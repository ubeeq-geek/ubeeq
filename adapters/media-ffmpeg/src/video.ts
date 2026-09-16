import { mkdtemp, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateFfprobeOutput, type VideoValidationProfile, type FfprobeJson, type MediaProcessor } from '@ubeeq/processing';

export interface VideoEncodingLimits { maxDurationSeconds: number; maxOutputBytes: number; maxWidth: number; maxHeight: number; hasAudio: boolean }
export interface VideoEncodingTools {
  probe(path: string): Promise<FfprobeJson>;
  encodeVideo(input: string, output: string, limits: VideoEncodingLimits): Promise<void>;
}
export interface VideoRenditionProfile extends VideoValidationProfile {
  allowedAudioCodecs: readonly string[]; maxAudioChannels: number; maxAudioSampleRate: number;
}
/** Private version-bound MP4. Products still own admission, storage, durable jobs and publication. */
export class FfmpegVideoProcessor implements MediaProcessor {
  private readonly profile: VideoRenditionProfile;
  private readonly limits: { maxSourceBytes: number; maxOutputBytes: number; maxWidth: number; maxHeight: number };
  constructor(private readonly tools: VideoEncodingTools, profile: VideoRenditionProfile,
    limits: { maxSourceBytes: number; maxOutputBytes: number; maxWidth: number; maxHeight: number }) {
    this.profile = structuredClone(profile); this.limits = { ...limits };
    if (!Object.values(this.limits).every(value => Number.isSafeInteger(value) && value > 0) ||
      limits.maxWidth < 2 || limits.maxHeight < 2 || !Array.isArray(profile.allowedAudioCodecs) ||
      ![profile.maxAudioChannels, profile.maxAudioSampleRate].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('Invalid video rendition budgets.');
  }
  async process(input: Parameters<MediaProcessor['process']>[0]) {
    const { contentType, sourceVersionId } = input;
    if (!contentType?.startsWith('video/') || typeof sourceVersionId !== 'string' || !sourceVersionId.trim() ||
      !(input.source instanceof Uint8Array) || !input.source.byteLength || input.source.byteLength > this.limits.maxSourceBytes || input.squareCrop !== undefined) throw new Error('A bounded versioned video source without image crop is required.');
    const source = new Uint8Array(input.source);
    const directory = await mkdtemp(join(tmpdir(), 'video-rendition-'));
    try {
      const sourcePath = join(directory, 'source'), outputPath = join(directory, 'video.mp4');
      await writeFile(sourcePath, source, { flag: 'wx', mode: 0o600 });
      const probe = await this.tools.probe(sourcePath), streams = probe.streams || [];
      const metadata = validateFfprobeOutput(probe, this.profile);
      const videos = streams.filter(stream => stream.codec_type === 'video'), audios = streams.filter(stream => stream.codec_type === 'audio');
      if (videos.length !== 1 || videos[0].disposition?.attached_pic || audios.length > 1 || streams.length !== videos.length + audios.length) throw new Error('Video rendition requires one video and at most one audio stream.');
      const audio = audios[0];
      if (audio && (!this.profile.allowedAudioCodecs.includes(audio.codec_name || '') || !Number.isSafeInteger(audio.channels) || audio.channels! < 1 || audio.channels! > this.profile.maxAudioChannels ||
        !Number.isSafeInteger(Number(audio.sample_rate)) || Number(audio.sample_rate) < 1 || Number(audio.sample_rate) > this.profile.maxAudioSampleRate)) throw new Error('Audio stream exceeds video rendition profile.');
      await this.tools.encodeVideo(sourcePath, outputPath, { ...this.limits, maxDurationSeconds: metadata.durationSeconds, hasAudio: Boolean(audio) });
      const size = (await stat(outputPath)).size;
      if (!Number.isSafeInteger(size) || size < 12 || size > this.limits.maxOutputBytes) throw new Error('Video output exceeds byte budget.');
      const body = new Uint8Array(await readFile(outputPath));
      if (body.byteLength !== size || String.fromCharCode(...body.slice(4, 8)) !== 'ftyp') throw new Error('Video tool did not produce MP4 bytes.');
      const outputProbe = await this.tools.probe(outputPath);
      const output = validateFfprobeOutput(outputProbe, { profile: 'mp4-output-v1', maxDurationSeconds: metadata.durationSeconds + 0.25,
        maxWidth: this.limits.maxWidth, maxHeight: this.limits.maxHeight, allowedContainers: ['mov,mp4,m4a,3gp,3g2,mj2'], allowedVideoCodecs: ['h264'],
        frameIntervalSeconds: metadata.durationSeconds + 1, maxFrames: 2 });
      const outputStreams = outputProbe.streams || [], outputAudio = outputStreams.filter(stream => stream.codec_type === 'audio');
      if (Math.abs(output.durationSeconds - metadata.durationSeconds) > 0.25 || output.rotation !== 0 || output.width % 2 || output.height % 2 ||
        outputStreams.length !== (audio ? 2 : 1) || outputAudio.length !== (audio ? 1 : 0) ||
        (audio && (outputAudio[0].codec_name !== 'aac' || outputAudio[0].channels !== 2 || Number(outputAudio[0].sample_rate) !== 48000))) throw new Error('Video output does not match the admitted encoding.');
      return { metadata: { contentType, width: metadata.width, height: metadata.height, durationSeconds: metadata.durationSeconds,
        videoCodec: metadata.videoCodec, container: metadata.container, rotation: metadata.rotation, hasAudio: metadata.hasAudio,
        validationProfile: metadata.validationProfile, renditionWidth: output.width, renditionHeight: output.height, renditionDurationSeconds: output.durationSeconds },
        renditions: [{ id: `video:${sourceVersionId}`, sourceVersionId, role: 'preview' as const, contentType: 'video/mp4', byteLength: body.byteLength, body }], measuredUnits: 1 };
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
}
