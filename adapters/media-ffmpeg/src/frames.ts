import { mkdtemp, writeFile, readFile, stat, unlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateFfprobeOutput, type VideoValidationProfile, type VideoToolAdapter, type MediaProcessor, type ProcessedRendition } from '@ubeeq/processing';

export interface VideoFrameSamplingTools extends VideoToolAdapter {
  extractLastFrame(inputPath: string, outputPath: string): Promise<void>;
}

/** Opt-in sampled frames, not playback video or a moderation decision. */
export class FfmpegFrameProcessor implements MediaProcessor {
  private readonly profile: VideoValidationProfile;
  private readonly limits: { maxSourceBytes: number; maxFrameBytes: number; maxTotalBytes: number };
  constructor(private readonly tools: VideoFrameSamplingTools, profile: VideoValidationProfile,
    limits: { maxSourceBytes: number; maxFrameBytes: number; maxTotalBytes: number }) {
    this.profile = structuredClone(profile);
    this.limits = { ...limits };
    if (![limits.maxSourceBytes, limits.maxFrameBytes, limits.maxTotalBytes].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('Frame byte budgets must be positive safe integers');
    if (!Number.isSafeInteger(profile.maxFrames) || profile.maxFrames! < 1) throw new Error('An explicit frame count budget is required');
  }
  async process(input: Parameters<MediaProcessor['process']>[0]) {
    const { contentType, sourceVersionId } = input;
    if (typeof contentType !== 'string' || !contentType.startsWith('video/') || typeof sourceVersionId !== 'string' || !sourceVersionId.trim() ||
      !(input.source instanceof Uint8Array) || !input.source.byteLength || input.source.byteLength > this.limits.maxSourceBytes || input.squareCrop !== undefined) throw new Error('A bounded versioned video source without image crop is required');
    const source = new Uint8Array(input.source);
    const directory = await mkdtemp(join(tmpdir(), 'video-frames-'));
    try {
      const sourcePath = join(directory, 'source');
      await writeFile(sourcePath, source, { flag: 'wx', mode: 0o600 });
      const metadata = validateFfprobeOutput(await this.tools.probe(sourcePath), this.profile);
      const renditions: ProcessedRendition[] = [];
      let totalBytes = 0;
      for (const timestamp of metadata.frameTimestampsMs) {
        if (totalBytes >= this.limits.maxTotalBytes) throw new Error('Frames exceed aggregate byte budget');
        const outputPath = join(directory, 'frame.jpg');
        if (timestamp === metadata.frameTimestampsMs.at(-1)) await this.tools.extractLastFrame(sourcePath, outputPath);
        else await this.tools.extractFrame(sourcePath, outputPath, timestamp);
        const size = (await stat(outputPath)).size;
        if (!Number.isSafeInteger(size) || size < 3 || size > this.limits.maxFrameBytes || size > this.limits.maxTotalBytes - totalBytes) throw new Error('Frame exceeds byte budget');
        const body = new Uint8Array(await readFile(outputPath));
        if (body.byteLength !== size || body[0] !== 255 || body[1] !== 216 || body[2] !== 255) throw new Error('Video tool did not produce a JPEG frame');
        await unlink(outputPath);
        totalBytes += size;
        renditions.push({ id: `frame:${sourceVersionId}:${timestamp}`, sourceVersionId, role: 'preview', contentType: 'image/jpeg', byteLength: size, body });
      }
      return { metadata: { contentType, width: metadata.width, height: metadata.height, durationSeconds: metadata.durationSeconds,
        validationProfile: metadata.validationProfile, frameCount: renditions.length, frameBytes: totalBytes }, renditions, measuredUnits: renditions.length };
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
}
