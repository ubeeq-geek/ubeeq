import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateFfprobeOutput, type VideoValidationProfile, type VideoToolAdapter, type MediaProcessor } from '@ubeeq/processing';

/** Private poster output; persistence, authorization and job fencing remain the worker's responsibility. */
export class FfmpegPosterProcessor implements MediaProcessor {
  constructor(private readonly tools: VideoToolAdapter, private readonly profile: VideoValidationProfile,
    private readonly maxOutputBytes = 10 * 1024 * 1024) {
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) throw new Error('Poster byte budget must be a positive integer');
  }
  async process(input: Parameters<MediaProcessor['process']>[0]) {
    if (!input.contentType.startsWith('video/') || !input.source.byteLength || !input.sourceVersionId) throw new Error('A versioned video source is required');
    const directory = await mkdtemp(join(tmpdir(), 'video-poster-'));
    try {
      const sourcePath = join(directory, 'source'), outputPath = join(directory, 'poster.jpg');
      await writeFile(sourcePath, input.source, { flag: 'wx' });
      const metadata = validateFfprobeOutput(await this.tools.probe(sourcePath), this.profile);
      await this.tools.extractFrame(sourcePath, outputPath, 0);
      const size = (await stat(outputPath)).size;
      if (size < 1 || size > this.maxOutputBytes) throw new Error('Poster exceeds byte budget');
      const body = new Uint8Array(await readFile(outputPath));
      if (body.byteLength !== size || body[0] !== 255 || body[1] !== 216 || body[2] !== 255) throw new Error('Video tool did not produce a JPEG poster');
      return { metadata: { contentType: input.contentType, width: metadata.width, height: metadata.height,
        durationSeconds: metadata.durationSeconds, videoCodec: metadata.videoCodec, container: metadata.container,
        rotation: metadata.rotation, hasAudio: metadata.hasAudio, validationProfile: metadata.validationProfile },
        renditions: [{ id: `poster:${input.sourceVersionId}`, sourceVersionId: input.sourceVersionId, role: 'poster' as const,
          contentType: 'image/jpeg', byteLength: body.byteLength, body }], measuredUnits: 1 };
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
}
