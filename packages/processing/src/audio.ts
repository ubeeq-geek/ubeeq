import type { FfprobeJson } from './video.js';

export interface AudioValidationProfile {
  profile: string;
  maxDurationSeconds: number;
  maxChannels: number;
  maxSampleRate: number;
  maxStreams: number;
  allowedContainers: readonly string[];
  allowedAudioCodecs: readonly string[];
  allowAttachedPicture?: boolean;
}
export interface ValidatedAudioMetadata {
  validationProfile: string; durationSeconds: number; container: string;
  audioCodec: string; streamIndex: number; channels: number; sampleRate: number;
  hasAttachedPicture: boolean;
}
const positiveDecimal = (value: unknown): number => {
  if (typeof value !== 'string' || !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) throw new Error('Missing or invalid audio duration or sample rate.');
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error('Missing or invalid audio duration or sample rate.');
  return parsed;
};

/** Metadata admission only, not proof that a complete source can be decoded. */
export const validateAudioFfprobeOutput = (probe: FfprobeJson, profile: AudioValidationProfile): ValidatedAudioMetadata => {
  const nonemptyList = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.every(item => typeof item === 'string' && item.trim().length > 0);
  if (!profile || typeof profile.profile !== 'string' || !profile.profile.trim() || !Number.isFinite(profile.maxDurationSeconds) || profile.maxDurationSeconds <= 0 ||
    ![profile.maxChannels, profile.maxSampleRate, profile.maxStreams].every(value => Number.isSafeInteger(value) && value > 0) ||
    !nonemptyList(profile.allowedContainers) || !nonemptyList(profile.allowedAudioCodecs) || (profile.allowAttachedPicture !== undefined && typeof profile.allowAttachedPicture !== 'boolean')) throw new Error('Invalid audio validation profile.');
  const streams = probe?.streams;
  if (!Array.isArray(streams) || streams.length < 1 || streams.length > profile.maxStreams || streams.some(stream => !stream || typeof stream !== 'object')) throw new Error('Invalid audio stream set.');
  const indexes = streams.map(stream => stream.index);
  if (indexes.some(index => !Number.isSafeInteger(index) || index! < 0) || new Set(indexes).size !== indexes.length) throw new Error('Audio stream indexes must be unique non-negative integers.');
  const audio = streams.filter(stream => stream.codec_type === 'audio');
  if (audio.length !== 1) throw new Error('Exactly one audio stream is required.');
  const other = streams.filter(stream => stream.codec_type !== 'audio');
  if (other.some(stream => !profile.allowAttachedPicture || stream.codec_type !== 'video' || stream.disposition?.attached_pic !== 1)) throw new Error('Unexpected non-audio stream.');
  const stream = audio[0], container = probe.format?.format_name;
  if (typeof container !== 'string' || !profile.allowedContainers.includes(container)) throw new Error('Unsupported audio container.');
  if (typeof stream.codec_name !== 'string' || !profile.allowedAudioCodecs.includes(stream.codec_name)) throw new Error('Unsupported audio codec.');
  const durationSeconds = positiveDecimal(probe.format?.duration);
  const streamDuration = stream.duration === undefined || stream.duration === 'N/A' ? durationSeconds : positiveDecimal(stream.duration);
  if (Math.max(durationSeconds, streamDuration) > profile.maxDurationSeconds) throw new Error('Audio duration exceeds the active validation profile.');
  const sampleRate = positiveDecimal(stream.sample_rate);
  if (!Number.isSafeInteger(sampleRate) || sampleRate > profile.maxSampleRate || !Number.isSafeInteger(stream.channels) || stream.channels! < 1 || stream.channels! > profile.maxChannels) throw new Error('Audio channel or sample-rate limit exceeded.');
  return { validationProfile: profile.profile, durationSeconds: Math.max(durationSeconds, streamDuration), container, audioCodec: stream.codec_name,
    streamIndex: stream.index!, channels: stream.channels!, sampleRate, hasAttachedPicture: other.length > 0 };
};
