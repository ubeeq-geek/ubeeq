/** Collection slideshow settings are opt-in; saving a collection never starts a render. */
export interface SlideshowMusicTrack { assetId: string; startSeconds: number; endSeconds?: number }
export interface SlideshowSettings {
  slideDurationSeconds: number;
  transition: 'crossfade' | 'cut';
  transitionDurationSeconds: number;
  format: 'landscape' | 'portrait' | 'square';
  music: SlideshowMusicTrack[];
  loopMusic: boolean;
  musicFadeOutSeconds: number;
}
export class SlideshowError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'SlideshowError'; }
}
const invalid = (message: string): never => { throw new SlideshowError('invalid_slideshow', message); };
const seconds = (value: unknown, min: number, max: number, label: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || Math.abs(value * 30 - Math.round(value * 30)) > 0.000001) {
    return invalid(`${label} must be between ${min} and ${max} seconds, in increments of 1/30 second.`);
  }
  return value;
};
/** Normalize untrusted JSON and return an independent, canonical settings snapshot. */
export function normalizeSlideshowSettings(value: unknown = {}): SlideshowSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('Slideshow settings must be an object.');
  const input = value as Record<string, unknown>;
  const slideDurationSeconds = seconds(input.slideDurationSeconds ?? 4, 0.5, 60, 'Slide duration');
  const transition = input.transition ?? 'crossfade';
  if (transition !== 'cut' && transition !== 'crossfade') return invalid('Choose cut or crossfade.');
  const defaultTransition = Math.floor(Math.min(0.5, slideDurationSeconds / 2) * 30) / 30;
  const transitionDurationSeconds = transition === 'cut' ? 0 : seconds(input.transitionDurationSeconds ?? defaultTransition, 1 / 30, Math.min(5, slideDurationSeconds / 2), 'Transition duration');
  const format = input.format ?? 'landscape';
  if (format !== 'landscape' && format !== 'portrait' && format !== 'square') return invalid('Choose landscape, portrait or square.');
  const tracks = input.music ?? [];
  if (!Array.isArray(tracks) || tracks.length > 10) return invalid('Choose at most ten music tracks.');
  const music = tracks.map((track): SlideshowMusicTrack => {
    if (!track || typeof track !== 'object' || Array.isArray(track) || typeof track.assetId !== 'string' || !track.assetId.trim() || track.assetId.length > 500) return invalid('A music asset ID is required.');
    const startSeconds = seconds(track.startSeconds ?? 0, 0, 3600, 'Track start');
    const endSeconds = track.endSeconds === undefined ? undefined : seconds(track.endSeconds, 1 / 30, 3600, 'Track end');
    if (endSeconds !== undefined && endSeconds <= startSeconds) return invalid('Track end must follow its start.');
    return { assetId: track.assetId, startSeconds, ...(endSeconds === undefined ? {} : { endSeconds }) };
  });
  if (input.loopMusic !== undefined && typeof input.loopMusic !== 'boolean') return invalid('Music looping must be a boolean.');
  return { slideDurationSeconds, transition, transitionDurationSeconds, format, music, loopMusic: input.loopMusic ?? true,
    musicFadeOutSeconds: seconds(input.musicFadeOutSeconds ?? 2, 0, 10, 'Music fade out') };
}
export function slideshowDurationSeconds(slideCount: number, settings: SlideshowSettings): number {
  if (!Number.isSafeInteger(slideCount) || slideCount < 1 || slideCount > 100) return invalid('Choose a collection with between one and 100 images.');
  const normalized = normalizeSlideshowSettings(settings);
  const duration = (slideCount * normalized.slideDurationSeconds) - ((slideCount - 1) * normalized.transitionDurationSeconds);
  if (duration > 3600) return invalid('Slideshow videos must be at most one hour long.');
  return Math.round(duration * 30) / 30;
}
export const slideshowDimensions = (format: SlideshowSettings['format']): { width: number; height: number } => {
  if (format === 'landscape') return { width: 1920, height: 1080 };
  if (format === 'portrait') return { width: 1080, height: 1920 };
  if (format === 'square') return { width: 1080, height: 1080 };
  return invalid('Unknown slideshow format.');
};
