import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isAbsolute } from 'node:path';
import type { FfprobeJson, VideoToolAdapter } from '@ubeeq/processing';
export { FfmpegPosterProcessor, renderVideoPoster } from './poster.js';

const execute = promisify(execFile);
export interface FfmpegVideoToolOptions { ffprobePath: string; ffmpegPath: string; timeoutMs?: number; maxFrameWidth?: number }
/** Optional native tool adapter. Binaries and their sandbox are provided by the deployment, never downloaded here. */
export class FfmpegVideoToolAdapter implements VideoToolAdapter {
  private readonly timeout: number;
  constructor(private readonly options: FfmpegVideoToolOptions) {
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
}
