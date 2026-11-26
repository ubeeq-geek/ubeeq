import type { SlideshowSettings } from '@ubeeq/core';
export interface SlideshowMediaInput { source: Uint8Array; contentType: string }
export interface SlideshowRenderInput {
  settings: SlideshowSettings;
  slides: SlideshowMediaInput[];
  /** Ordered bytes corresponding exactly to settings.music. */
  music: SlideshowMediaInput[];
}
export interface SlideshowRenderResult {
  body: Uint8Array;
  contentType: 'video/mp4';
  durationSeconds: number;
  width: number;
  height: number;
}
/** Hosts own admission, source-version binding, durable jobs and private result storage. */
export interface SlideshowRenderer { render(input: SlideshowRenderInput): Promise<SlideshowRenderResult> }
