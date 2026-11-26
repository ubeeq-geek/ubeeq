import type { SlideshowSettings } from '@ubeeq/core';
export interface CollectionSlideshowRendition {
  id: string; state: string; stale: boolean; settings: SlideshowSettings; imageCount: number; durationSeconds: number;
  width?: number; height?: number; downloadPath?: string; error?: string;
}
export interface CollectionSlideshowApi {
  list(collectionId: string): Promise<CollectionSlideshowRendition[]>;
  generate(collectionId: string, settings: SlideshowSettings, musicRightsConfirmed: boolean, requestId: string): Promise<CollectionSlideshowRendition>;
  download(collectionId: string, renditionId: string): Promise<Blob>;
}
/** Bearer credentials stay in headers, including when downloading private MP4 bytes. */
export class CollectionSlideshowClient implements CollectionSlideshowApi {
  constructor(private readonly token: () => string, private readonly base = '/api/v1', private readonly request: typeof fetch = (...args) => fetch(...args)) {}
  private path(collectionId: string): string { return `${this.base}/collections/${encodeURIComponent(collectionId)}/slideshows`; }
  private async call(path: string, body?: unknown): Promise<Response> {
    const response = await this.request(path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${this.token()}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store', redirect: 'error' });
    if (!response.ok) {
      const error = await response.json().catch(() => undefined);
      throw new Error(error?.error?.message ?? 'Slideshow operation failed.');
    }
    return response;
  }
  async list(collectionId: string): Promise<CollectionSlideshowRendition[]> { return (await (await this.call(this.path(collectionId))).json()).renditions; }
  async generate(collectionId: string, settings: SlideshowSettings, musicRightsConfirmed: boolean, requestId: string): Promise<CollectionSlideshowRendition> {
    return (await (await this.call(this.path(collectionId), { settings, musicRightsConfirmed, requestId })).json()).rendition;
  }
  async download(collectionId: string, renditionId: string): Promise<Blob> {
    return (await this.call(`${this.path(collectionId)}/${encodeURIComponent(renditionId)}/content`)).blob();
  }
}
