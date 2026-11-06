import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeSlideshowSettings, slideshowDimensions, slideshowDurationSeconds } from '@ubeeq/core';
import type { SlideshowRenderer, SlideshowRenderInput, SlideshowRenderResult } from '@ubeeq/processing';

const execute = promisify(execFile);
const imageExtensions: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const imageCodecs = new Set(['mjpeg', 'png', 'webp']);
const audioCodecs = new Set(['mp3', 'aac', 'pcm_s16le', 'pcm_s24le', 'pcm_f32le', 'flac', 'vorbis', 'opus']);
interface SlideshowProbe {
  format?: { duration?: string };
  streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number; pix_fmt?: string;
    channels?: number; sample_rate?: string; disposition?: { attached_pic?: number } }>;
}
export interface FfmpegSlideshowOptions {
  ffmpegPath: string;
  ffprobePath: string;
  /** Total render deadline. Hosts must also bound decoder CPU/memory and the job lease. */
  timeoutMs?: number;
  maxSourceBytes?: number;
  maxOutputBytes?: number;
}
/** Optional native implementation; no executable downloads or environment defaults. */
export class FfmpegSlideshowRenderer implements SlideshowRenderer {
  private readonly options: Required<FfmpegSlideshowOptions>;
  constructor(options: FfmpegSlideshowOptions) {
    this.options = { timeoutMs: 300_000, maxSourceBytes: 256 * 1024 * 1024, maxOutputBytes: 512 * 1024 * 1024, ...options };
    if (!options.ffmpegPath || !options.ffprobePath || ![this.options.timeoutMs, this.options.maxSourceBytes, this.options.maxOutputBytes].every(n => Number.isSafeInteger(n) && n > 0)) throw new Error('Explicit FFmpeg/FFprobe executables and positive slideshow budgets are required.');
  }
  private async command(binary: string, args: string[], deadline: number): Promise<string> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Slideshow render deadline exceeded.');
    const { stdout } = await execute(binary, args, { timeout: remaining, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
    return stdout;
  }
  private async probe(path: string, deadline: number): Promise<SlideshowProbe> {
    return JSON.parse(await this.command(this.options.ffprobePath, ['-v', 'error', '-protocol_whitelist', 'file', '-show_format', '-show_streams', '-of', 'json', path], deadline));
  }
  async render(input: SlideshowRenderInput): Promise<SlideshowRenderResult> {
    // Capture all caller-owned data before the first await.
    const settings = normalizeSlideshowSettings(input.settings);
    const durationSeconds = slideshowDurationSeconds(input.slides.length, settings);
    if (!Array.isArray(input.music) || input.music.length !== settings.music.length) throw new Error('Music sources do not match the selected tracks.');
    const media = [...input.slides, ...input.music];
    if (media.some(item => !(item.source instanceof Uint8Array) || !item.source.byteLength) || media.reduce((sum, item) => sum + item.source.byteLength, 0) > this.options.maxSourceBytes) throw new Error('Slideshow source byte budget exceeded.');
    if (input.slides.some(item => !imageExtensions[item.contentType]) || input.music.some(item => !item.contentType.startsWith('audio/'))) throw new Error('Slideshow requires JPEG, PNG or WebP images and audio music sources.');
    const slides = input.slides.map(item => ({ ...item, source: new Uint8Array(item.source) }));
    const music = input.music.map(item => ({ ...item, source: new Uint8Array(item.source) }));
    const { width, height } = slideshowDimensions(settings.format);
    const deadline = Date.now() + this.options.timeoutMs;
    const directory = await mkdtemp(join(tmpdir(), 'collection-slideshow-'));
    try {
      const imagePaths: string[] = [];
      for (const [index, slide] of slides.entries()) {
        const path = join(directory, `image-${index}.${imageExtensions[slide.contentType]}`);
        await writeFile(path, slide.source, { mode: 0o600 });
        const probe = await this.probe(path, deadline), streams = probe.streams ?? [], video = streams[0];
        const imageWidth = Number(video?.width), imageHeight = Number(video?.height);
        if (streams.length !== 1 || video.codec_type !== 'video' || !imageCodecs.has(video.codec_name ?? '') || !Number.isSafeInteger(imageWidth) || !Number.isSafeInteger(imageHeight) || imageWidth < 1 || imageHeight < 1 || imageWidth * imageHeight > 40_000_000) throw new Error('Invalid slideshow image or image pixel budget exceeded.');
        imagePaths.push(path);
      }
      let soundtrack: string | undefined;
      if (music.length) {
        const audioArgs: string[] = [], filters: string[] = [];
        let totalTrackSeconds = 0;
        for (const [index, track] of music.entries()) {
          const path = join(directory, `track-${index}`);
          await writeFile(path, track.source, { mode: 0o600 });
          const probe = await this.probe(path, deadline), streams = probe.streams ?? [], audio = streams.find(s => s.codec_type === 'audio');
          const trackDuration = Number(probe.format?.duration), selected = settings.music[index];
          const channels = Number(audio?.channels), sampleRate = Number(audio?.sample_rate);
          if (!audio || streams.some(s => s.codec_type !== 'audio' && !s.disposition?.attached_pic) || streams.filter(s => s.codec_type === 'audio').length !== 1 || !audioCodecs.has(audio.codec_name ?? '') || !Number.isSafeInteger(channels) || channels < 1 || channels > 8 || !Number.isSafeInteger(sampleRate) || sampleRate < 1 || sampleRate > 192000 || !Number.isFinite(trackDuration) || trackDuration <= selected.startSeconds || trackDuration > 3600 || (selected.endSeconds !== undefined && selected.endSeconds > trackDuration + 0.05)) throw new Error('Invalid music source or trim range.');
          totalTrackSeconds += (selected.endSeconds ?? trackDuration) - selected.startSeconds;
          audioArgs.push('-protocol_whitelist', 'file', '-threads', '1', '-i', path);
          filters.push(`[${index}:a:0]atrim=start=${selected.startSeconds}${selected.endSeconds === undefined ? '' : `:end=${selected.endSeconds}`},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=s16:channel_layouts=stereo[a${index}]`);
        }
        if (totalTrackSeconds > 3600) throw new Error('Selected music playlist exceeds one hour.');
        filters.push(`${music.map((_, i) => `[a${i}]`).join('')}concat=n=${music.length}:v=0:a=1[audio]`);
        soundtrack = join(directory, 'music.wav');
        await this.command(this.options.ffmpegPath, ['-nostdin', '-v', 'error', ...audioArgs, '-filter_complex_threads', '1', '-filter_complex', filters.join(';'), '-map', '[audio]', '-map_metadata', '-1', '-c:a', 'pcm_s16le', '-threads', '1', '-t', String(totalTrackSeconds), '-fs', String(700 * 1024 * 1024), '-n', soundtrack], deadline);
      }
      const args = ['-nostdin', '-v', 'error'];
      for (const path of imagePaths) args.push('-protocol_whitelist', 'file', '-threads', '1', '-loop', '1', '-framerate', '30', '-t', String(settings.slideDurationSeconds), '-i', path);
      if (soundtrack) args.push('-protocol_whitelist', 'file', ...(settings.loopMusic ? ['-stream_loop', '-1'] : []), '-i', soundtrack);
      const filters = imagePaths.map((_, i) => `[${i}:v:0]scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p,settb=AVTB,setpts=PTS-STARTPTS,fps=30[v${i}]`);
      let video = 'v0';
      if (settings.transition === 'cut' && slides.length > 1) {
        filters.push(`${slides.map((_, i) => `[v${i}]`).join('')}concat=n=${slides.length}:v=1:a=0[video]`);
        video = 'video';
      } else for (let i = 1; i < slides.length; i++) {
        const offset = Math.round(i * (settings.slideDurationSeconds - settings.transitionDurationSeconds) * 30) / 30;
        filters.push(`[${video}][v${i}]xfade=transition=fade:duration=${settings.transitionDurationSeconds}:offset=${offset}[fade${i}]`);
        video = `fade${i}`;
      }
      if (soundtrack) {
        const fade = Math.min(settings.musicFadeOutSeconds, durationSeconds);
        filters.push(`[${slides.length}:a:0]apad,atrim=duration=${durationSeconds}${fade ? `,afade=t=out:st=${durationSeconds - fade}:d=${fade}` : ''}[audio]`);
      }
      const output = join(directory, 'slideshow.mp4');
      args.push('-filter_complex_threads', '1', '-filter_complex', filters.join(';'), '-map', `[${video}]`, ...(soundtrack ? ['-map', '[audio]', '-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-ar', '48000'] : ['-an']),
        '-sn', '-dn', '-map_metadata', '-1', '-map_metadata:s', '-1', '-map_chapters', '-1', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-r', '30', '-threads', '1', '-t', String(durationSeconds), '-fs', String(this.options.maxOutputBytes), '-movflags', '+faststart', '-f', 'mp4', '-n', output);
      await this.command(this.options.ffmpegPath, args, deadline);
      const size = (await stat(output)).size;
      if (size <= 0 || size > this.options.maxOutputBytes) throw new Error('Slideshow output byte budget exceeded.');
      const probe = await this.probe(output, deadline), videos = (probe.streams ?? []).filter(s => s.codec_type === 'video'), audios = (probe.streams ?? []).filter(s => s.codec_type === 'audio');
      const actualDuration = Number(probe.format?.duration);
      if (videos.length !== 1 || videos[0].codec_name !== 'h264' || videos[0].pix_fmt !== 'yuv420p' || videos[0].width !== width || videos[0].height !== height || audios.length !== Number(!!soundtrack) || audios.some(s => s.codec_name !== 'aac') || !Number.isFinite(actualDuration) || Math.abs(actualDuration - durationSeconds) > 0.15) throw new Error('Slideshow output failed validation (possibly truncated).');
      return { body: new Uint8Array(await readFile(output)), contentType: 'video/mp4', durationSeconds, width, height };
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
}
