/** Deterministic millisecond sampling; limits are mechanisms, admission profiles are supplied by products. */
export const deterministicVideoFramePlan = (durationSeconds: number, intervalSeconds: number, maxFrames = 10_000): number[] => {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error('Video duration must be positive');
  if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) throw new Error('Frame interval must be positive');
  const durationMs = Math.round(durationSeconds * 1000), intervalMs = Math.round(intervalSeconds * 1000);
  if (!Number.isSafeInteger(durationMs) || !Number.isSafeInteger(intervalMs) || intervalMs < 1) throw new Error('Frame timing must fit safe millisecond precision');
  if (!Number.isSafeInteger(maxFrames) || maxFrames < 1) throw new Error('Frame budget must be a positive integer');
  const finalMs = Math.max(0, durationMs - 1), count = Math.ceil(durationMs / intervalMs);
  const appendFinal = count === 0 || (count - 1) * intervalMs !== finalMs;
  if (count + Number(appendFinal) > maxFrames) throw new Error('Frame plan exceeds the frame budget');
  const frames = Array.from({ length: count }, (_, index) => index * intervalMs);
  if (appendFinal) frames.push(finalMs);
  return frames;
};

export interface VideoValidationProfile {
  profile: string;
  maxDurationSeconds: number;
  maxWidth: number;
  maxHeight: number;
  allowedContainers: readonly string[];
  allowedVideoCodecs: readonly string[];
  frameIntervalSeconds: number;
  maxFrames?: number;
}
export interface FfprobeJson {
  format?: { duration?: string; format_name?: string; bit_rate?: string };
  streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number;
    index?: number; sample_rate?: string; channels?: number; duration?: string;
    disposition?: { attached_pic?: number };
    tags?: { rotate?: string }; side_data_list?: Array<{ rotation?: number }> }>;
}
export interface ValidatedVideoMetadata {
  validationProfile: string; durationSeconds: number; container: string; videoCodec: string;
  width: number; height: number; bitrate?: number; rotation: number; hasAudio: boolean; audioCodec?: string;
  frameTimestampsMs: number[];
}
export interface VideoToolAdapter {
  probe(inputPath: string): Promise<FfprobeJson>;
  extractFrame(inputPath: string, outputPath: string, timestampMs: number): Promise<void>;
}

export const validateFfprobeOutput = (probe: FfprobeJson, profile: VideoValidationProfile): ValidatedVideoMetadata => {
  if (!profile.profile || !Number.isFinite(profile.maxDurationSeconds) || profile.maxDurationSeconds <= 0 ||
    ![profile.maxWidth, profile.maxHeight].every(value => Number.isSafeInteger(value) && value > 0) ||
    !Array.isArray(profile.allowedContainers) || !Array.isArray(profile.allowedVideoCodecs)) throw new Error('Invalid video validation profile');
  const video = probe?.streams?.find(({ codec_type }) => codec_type === 'video');
  const audio = probe?.streams?.find(({ codec_type }) => codec_type === 'audio');
  const durationSeconds = Number(probe?.format?.duration), container = probe?.format?.format_name || '';
  if (!video || !Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error('Malformed video or missing decodable video stream');
  if (durationSeconds > profile.maxDurationSeconds) throw new Error('Video duration exceeds the active validation profile');
  if (!profile.allowedContainers.includes(container)) throw new Error(`Unsupported video container: ${container || 'unknown'}`);
  if (!video.codec_name || !profile.allowedVideoCodecs.includes(video.codec_name)) throw new Error(`Unsupported video codec: ${video.codec_name || 'unknown'}`);
  if (!Number.isSafeInteger(video.width) || !Number.isSafeInteger(video.height) || video.width! <= 0 || video.height! <= 0 ||
    video.width! > profile.maxWidth || video.height! > profile.maxHeight) throw new Error('Video dimensions exceed the active validation profile');
  const rotation = Number(video.side_data_list?.find(({ rotation }) => typeof rotation === 'number')?.rotation ?? video.tags?.rotate ?? 0);
  const bitrate = Number(probe.format?.bit_rate);
  return { validationProfile: profile.profile, durationSeconds, container, videoCodec: video.codec_name, width: video.width!, height: video.height!,
    bitrate: Number.isFinite(bitrate) && bitrate >= 0 ? bitrate : undefined, rotation: Number.isFinite(rotation) ? rotation : 0,
    hasAudio: Boolean(audio), audioCodec: audio?.codec_name,
    frameTimestampsMs: deterministicVideoFramePlan(durationSeconds, profile.frameIntervalSeconds, profile.maxFrames) };
};

/** Returns only after every planned extraction succeeds. Partial files belong to the caller's attempt directory. */
export const extractValidatedFrames = async (input: { inputPath: string; outputPath(timestampMs: number): string; tools: VideoToolAdapter; profile: VideoValidationProfile }): Promise<ValidatedVideoMetadata> => {
  const metadata = validateFfprobeOutput(await input.tools.probe(input.inputPath), input.profile);
  for (const timestamp of metadata.frameTimestampsMs) await input.tools.extractFrame(input.inputPath, input.outputPath(timestamp), timestamp);
  return metadata;
};
