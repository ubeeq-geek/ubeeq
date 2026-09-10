import { mkdtemp, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateAudioFfprobeOutput, type AudioValidationProfile, type FfprobeJson, type MediaProcessor } from '@ubeeq/processing';

export interface AudioProcessingTools {
  probe(path: string): Promise<FfprobeJson>;
  encodeAudio(input: string, output: string, limits: { streamIndex: number; maxDurationSeconds: number; maxOutputBytes: number }): Promise<void>;
}
/** Private audio derivative; authorization, durable jobs and storage belong to the caller. */
export class FfmpegAudioProcessor implements MediaProcessor {
  private readonly profile: AudioValidationProfile;
  private readonly maxSourceBytes: number;
  private readonly maxOutputBytes: number;
  constructor(private readonly tools: AudioProcessingTools, profile: AudioValidationProfile, limits: { maxSourceBytes: number; maxOutputBytes: number }) {
    this.profile = structuredClone(profile);
    this.maxSourceBytes = limits.maxSourceBytes; this.maxOutputBytes = limits.maxOutputBytes;
    if (![this.maxSourceBytes, this.maxOutputBytes].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('Audio byte budgets must be positive safe integers.');
  }
  async process(input: Parameters<MediaProcessor['process']>[0]) {
    const { contentType, sourceVersionId } = input;
    if (typeof contentType !== 'string' || !contentType.startsWith('audio/') || typeof sourceVersionId !== 'string' || !sourceVersionId.trim() || !(input.source instanceof Uint8Array) || !input.source.byteLength || input.source.byteLength > this.maxSourceBytes || input.squareCrop !== undefined) throw new Error('A bounded versioned audio source without image crop is required.');
    const source = new Uint8Array(input.source);
    const directory = await mkdtemp(join(tmpdir(), 'audio-rendition-'));
    try {
      const sourcePath = join(directory, 'source'), outputPath = join(directory, 'audio.mp3');
      await writeFile(sourcePath, source, { flag: 'wx', mode: 0o600 });
      const metadata = validateAudioFfprobeOutput(await this.tools.probe(sourcePath), this.profile);
      await this.tools.encodeAudio(sourcePath, outputPath, { streamIndex: metadata.streamIndex, maxDurationSeconds: metadata.durationSeconds, maxOutputBytes: this.maxOutputBytes });
      const size = (await stat(outputPath)).size;
      if (!Number.isSafeInteger(size) || size < 1 || size > this.maxOutputBytes) throw new Error('Audio output exceeds byte budget.');
      const body = new Uint8Array(await readFile(outputPath));
      if (body.byteLength !== size || body.length < 3 || !((body[0] === 73 && body[1] === 68 && body[2] === 51) || (body[0] === 255 && (body[1] & 224) === 224))) throw new Error('Audio tool did not produce MP3 bytes.');
      const output = validateAudioFfprobeOutput(await this.tools.probe(outputPath), { profile: 'mp3-output-v1', maxDurationSeconds: metadata.durationSeconds + 0.15,
        maxChannels: 2, maxSampleRate: 44100, maxStreams: 1, allowedContainers: ['mp3'], allowedAudioCodecs: ['mp3'] });
      if (output.channels !== 2 || output.sampleRate !== 44100 || Math.abs(output.durationSeconds - metadata.durationSeconds) > 0.15) throw new Error('Audio output duration or encoding does not match the admitted source.');
      return { metadata: { ...metadata, contentType, renditionDurationSeconds: output.durationSeconds }, renditions: [{ id: `audio:${sourceVersionId}`, sourceVersionId,
        role: 'preview' as const, contentType: 'audio/mpeg', byteLength: body.byteLength, body }], measuredUnits: 1 };
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
}
