import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isAbsolute } from 'node:path';
import { lstat } from 'node:fs/promises';
import type { FfprobeJson, VideoToolAdapter } from '@ubeeq/processing';
export { FfmpegPosterProcessor, renderVideoPoster } from './poster.js';
export { FfmpegAudioProcessor, type AudioProcessingTools } from './audio.js';
export { FfmpegFrameProcessor, type VideoFrameSamplingTools } from './frames.js';
export { FfmpegVideoProcessor, type VideoEncodingTools, type VideoEncodingLimits, type VideoRenditionProfile } from './video.js';
import type { VideoEncodingLimits } from './video.js';

const execute = promisify(execFile);
export interface FfmpegVideoToolOptions { ffprobePath: string; ffmpegPath: string; timeoutMs?: number; maxFrameWidth?: number }
/** Optional native tool adapter. Binaries and their sandbox are provided by the deployment, never downloaded here. */
export class FfmpegVideoToolAdapter implements VideoToolAdapter {
  private readonly timeout: number;
  constructor(private readonly options: FfmpegVideoToolOptions) {
    this.options = { ...options };
    if (!options.ffprobePath || !options.ffmpegPath) throw new Error('Explicit FFmpeg and FFprobe paths are required');
    this.timeout = options.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.timeout) || this.timeout < 1) throw new Error('Video command timeout must be a positive integer');
    if (!Number.isSafeInteger(options.maxFrameWidth ?? 1920) || (options.maxFrameWidth ?? 1920) < 2) throw new Error('Frame width must be an integer of at least two pixels');
  }
  private localPath(path: string): string {
    if (!isAbsolute(path) || path.includes('\0')) throw new Error('Video tools require absolute local file paths');
    return path;
  }
  async probe(inputPath: string): Promise<FfprobeJson> {
    const { stdout } = await execute(this.options.ffprobePath,
      ['-v', 'error', '-protocol_whitelist', 'file', '-show_format', '-show_streams', '-of', 'json', this.localPath(inputPath)],
      { maxBuffer: 4 * 1024 * 1024, timeout: this.timeout, killSignal: 'SIGKILL' });
    return JSON.parse(stdout) as FfprobeJson;
  }
  async extractFrame(inputPath: string, outputPath: string, timestampMs: number): Promise<void> {
    if (!Number.isSafeInteger(timestampMs) || timestampMs < 0) throw new Error('Frame timestamp must be non-negative integer milliseconds');
    await execute(this.options.ffmpegPath,
      ['-nostdin', '-v', 'error', '-protocol_whitelist', 'file', '-ss', (timestampMs / 1000).toFixed(3), '-i', this.localPath(inputPath),
        '-frames:v', '1', '-map_metadata', '-1', '-vf', `scale=min(${this.options.maxFrameWidth ?? 1920}\\,iw):-2`, '-q:v', '3', '-y', this.localPath(outputPath)],
      { maxBuffer: 4 * 1024 * 1024, timeout: this.timeout, killSignal: 'SIGKILL' });
  }
  /** Decode through EOF, replacing one JPEG, to retain the actual final frame. */
  async extractLastFrame(inputPath: string, outputPath: string): Promise<void> {
    await execute(this.options.ffmpegPath,
      ['-nostdin', '-v', 'error', '-protocol_whitelist', 'file', '-i', this.localPath(inputPath),
        '-map', '0:v:0', '-an', '-sn', '-dn', '-map_metadata', '-1', '-vf', `scale=min(${this.options.maxFrameWidth ?? 1920}\\,iw):-2`,
        '-q:v', '3', '-fps_mode', 'passthrough', '-update', '1', '-y', this.localPath(outputPath)],
      { maxBuffer: 4 * 1024 * 1024, timeout: this.timeout, killSignal: 'SIGKILL' });
  }
  async encodeAudio(inputPath: string, outputPath: string, limits: { streamIndex: number; maxDurationSeconds: number; maxOutputBytes: number }): Promise<void> {
    if (!Number.isSafeInteger(limits.streamIndex) || limits.streamIndex < 0 || !Number.isFinite(limits.maxDurationSeconds) || limits.maxDurationSeconds <= 0 || !Number.isSafeInteger(limits.maxOutputBytes) || limits.maxOutputBytes < 1) throw new Error('Invalid audio encoding limits.');
    await execute(this.options.ffmpegPath, ['-nostdin', '-v', 'error', '-protocol_whitelist', 'file', '-i', this.localPath(inputPath),
      '-map', `0:${limits.streamIndex}`, '-vn', '-sn', '-dn', '-map_metadata', '-1', '-map_metadata:s:a', '-1', '-map_chapters', '-1',
      '-t', String(limits.maxDurationSeconds), '-ac', '2', '-ar', '44100', '-c:a', 'libmp3lame', '-b:a', '128k', '-threads', '1',
      '-fs', String(limits.maxOutputBytes), '-f', 'mp3', '-n', this.localPath(outputPath)],
      { maxBuffer: 1024 * 1024, timeout: this.timeout, killSignal: 'SIGKILL' });
  }
  async encodeVideo(inputPath: string, outputPath: string, limits: VideoEncodingLimits): Promise<void> {
    const { maxDurationSeconds, maxOutputBytes, maxWidth, maxHeight, hasAudio } = limits;
    if (!Number.isFinite(maxDurationSeconds) || maxDurationSeconds <= 0 || ![maxOutputBytes, maxWidth, maxHeight].every(value => Number.isSafeInteger(value) && value > 0) ||
      maxWidth < 2 || maxHeight < 2 || typeof hasAudio !== 'boolean') throw new Error('Invalid video encoding limits.');
    this.localPath(inputPath); this.localPath(outputPath);
    // Some FFmpeg builds return success when -n skips an existing output.
    // Keep -n as well: this check alone does not prevent a concurrent creation.
    const existing = await lstat(outputPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (existing) throw new Error('Video output already exists.');
    await execute(this.options.ffmpegPath, ['-nostdin', '-v', 'error', '-protocol_whitelist', 'file', '-i', this.localPath(inputPath),
      '-map', '0:v:0', ...(hasAudio ? ['-map', '0:a:0', '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-ar', '48000'] : ['-an']),
      '-sn', '-dn', '-map_metadata', '-1', '-map_metadata:s', '-1', '-map_chapters', '-1', '-t', String(maxDurationSeconds),
      '-vf', `scale=w=min(iw\\,${maxWidth}):h=min(ih\\,${maxHeight}):force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-r', '30', '-threads', '1',
      '-fs', String(maxOutputBytes), '-movflags', '+faststart', '-f', 'mp4', '-n', this.localPath(outputPath)],
      { maxBuffer: 1024 * 1024, timeout: this.timeout, killSignal: 'SIGKILL' });
  }
}
