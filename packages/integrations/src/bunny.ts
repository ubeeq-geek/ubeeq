import { createHash } from 'node:crypto';
import { readBoundedResponseText } from './bounded-response-text.js';

export class BunnyApiError extends Error {
  constructor(readonly status: number) { super(`Bunny request failed (${status}).`); this.name = 'BunnyApiError'; }
}
export const bunnyStorageRegions = ['de', 'ny', 'la', 'sg', 'syd', 'uk', 'se', 'jh'] as const;
export type BunnyStorageRegion = typeof bunnyStorageRegions[number];
export function bunnyStorageOrigin(region: BunnyStorageRegion, s3 = false): string {
  if (!bunnyStorageRegions.includes(region)) throw new Error('Unsupported Bunny Storage region.');
  return `https://${s3 ? `${region}-s3.` : region === 'de' ? '' : `${region}.`}storage.bunnycdn.com`;
}
export function bunnyStoragePath(value: string, directory = false): string {
  if (typeof value !== 'string' || value.length > 1024 || /[\\%?#\x00-\x1f\x7f]/.test(value) || value.startsWith('/')) throw new Error('Invalid Bunny Storage path.');
  const path = value.replace(/\/$/, '');
  if ((!directory && !path) || path.split('/').some(part => part === '.' || part === '..' || (part === '' && path !== ''))) throw new Error('Invalid Bunny Storage path.');
  return path.split('/').filter(Boolean).map(encodeURIComponent).join('/') + (directory && path ? '/' : '');
}
const library = (id: string) => { if (!/^[1-9]\d{0,11}$/.test(id)) throw new Error('Invalid Bunny library ID.'); return id; };
export function bunnyVideoId(id: string): string { if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id)) throw new Error('Invalid Bunny video ID.'); return id; }
function secret(value: string) { if (!value || value.length > 1024 || /[\r\n]/.test(value)) throw new Error('Invalid Bunny credential.'); return value; }
async function request(fetcher: typeof fetch, url: string, key: string, init: RequestInit = {}) {
  const response = await fetcher(url, { ...init, headers: { ...init.headers, AccessKey: secret(key), Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(30_000) });
  // Never surface provider bodies: they may echo an API key or private paths.
  if (!response.ok) { await response.body?.cancel(); throw new BunnyApiError(response.status); }
  const body = await readBoundedResponseText(response, 4 * 1024 * 1024);
  return body ? JSON.parse(body) : undefined;
}
export interface BunnyVideo { id: string; title: string; status: number; sizeBytes?: number; durationSeconds?: number; }
function video(raw: any): BunnyVideo {
  bunnyVideoId(raw?.guid);
  if (typeof raw.title !== 'string' || !Number.isInteger(raw.status) || raw.status < 0 || raw.status > 8) throw new Error('Invalid Bunny video response.');
  return { id: raw.guid, title: raw.title.slice(0, 500), status: raw.status, ...(Number.isSafeInteger(raw.storageSize) && raw.storageSize >= 0 ? { sizeBytes: raw.storageSize } : {}), ...(typeof raw.length === 'number' && raw.length >= 0 ? { durationSeconds: raw.length } : {}) };
}
export class BunnyStreamClient {
  private base: string;
  constructor(readonly libraryId: string, private apiKey: string, private fetcher: typeof fetch = fetch) { this.base = `https://video.bunnycdn.com/library/${library(libraryId)}/videos`; secret(apiKey); }
  async list(page = 1, search = ''): Promise<{ items: BunnyVideo[]; nextPage?: number }> {
    if (!Number.isSafeInteger(page) || page < 1 || page > 100_000 || search.length > 200) throw new Error('Invalid Bunny video page.');
    const raw = await request(this.fetcher, `${this.base}?page=${page}&itemsPerPage=50&search=${encodeURIComponent(search)}`, this.apiKey);
    if (!Array.isArray(raw?.items) || raw.items.length > 50 || !Number.isSafeInteger(raw.totalItems) || raw.totalItems < 0) throw new Error('Invalid Bunny video inventory.');
    return { items: raw.items.map(video), ...(page * 50 < raw.totalItems ? { nextPage: page + 1 } : {}) };
  }
  async get(id: string) { return video(await request(this.fetcher, `${this.base}/${bunnyVideoId(id)}`, this.apiKey)); }
  async create(title: string) { this.title(title); return video(await request(this.fetcher, this.base, this.apiKey, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }) })); }
  async rename(id: string, title: string) { this.title(title); await request(this.fetcher, `${this.base}/${bunnyVideoId(id)}`, this.apiKey, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }) }); }
  async delete(id: string) { await request(this.fetcher, `${this.base}/${bunnyVideoId(id)}`, this.apiKey, { method: 'DELETE' }); }
  uploadGrant(id: string, expires: number) {
    bunnyVideoId(id); if (!Number.isSafeInteger(expires) || expires <= 0) throw new Error('Invalid Bunny expiry.');
    return { endpoint: 'https://video.bunnycdn.com/tusupload', videoId: id, libraryId: this.libraryId, expires, signature: createHash('sha256').update(`${this.libraryId}${this.apiKey}${expires}${id}`).digest('hex') };
  }
  private title(title: string) { if (typeof title !== 'string' || !title.trim() || title.length > 500) throw new Error('Enter a title within 500 characters.'); }
}
export interface BunnyStorageObject { name: string; path: string; directory: boolean; sizeBytes: number; }
export class BunnyStorageClient {
  private base: string;
  constructor(readonly zone: string, region: BunnyStorageRegion, private password: string, private fetcher: typeof fetch = fetch) {
    if (!/^[a-z0-9][a-z0-9-]{2,99}$/.test(zone)) throw new Error('Invalid Bunny Storage zone name.');
    secret(password); this.base = `${bunnyStorageOrigin(region)}/${zone}/`;
  }
  async list(path = ''): Promise<BunnyStorageObject[]> {
    const prefix = bunnyStoragePath(path, true);
    const rows = await request(this.fetcher, `${this.base}${prefix}`, this.password);
    if (!Array.isArray(rows) || rows.length > 10_000) throw new Error('Open a smaller Bunny Storage folder.');
    return rows.map(raw => {
      if (typeof raw?.ObjectName !== 'string' || raw.ObjectName.includes('/') || typeof raw.IsDirectory !== 'boolean' || !Number.isSafeInteger(raw.Length) || raw.Length < 0) throw new Error('Invalid Bunny Storage inventory.');
      const item = `${path.replace(/\/$/, '')}${path ? '/' : ''}${raw.ObjectName}`;
      bunnyStoragePath(item);
      return { name: raw.ObjectName, path: item, directory: raw.IsDirectory, sizeBytes: raw.Length };
    });
  }
  async deleteFile(path: string) { if (path.endsWith('/')) throw new Error('Folder deletion is not supported.'); await request(this.fetcher, `${this.base}${bunnyStoragePath(path)}`, this.password, { method: 'DELETE' }); }
}
export function bunnyStreamUrl(libraryId: string, videoId: string, options: { embed?: boolean; signingKey?: string; expires?: number } = {}): string {
  const url = new URL(`https://player.mediadelivery.net/${options.embed ? 'embed' : 'play'}/${library(libraryId)}/${bunnyVideoId(videoId)}`);
  if (options.embed) { url.searchParams.set('autoplay', 'false'); url.searchParams.set('preload', 'false'); }
  if (options.signingKey) {
    if (!Number.isSafeInteger(options.expires) || options.expires! <= 0) throw new Error('Signed Bunny playback requires an expiry.');
    url.searchParams.set('token', createHash('sha256').update(`${secret(options.signingKey)}${videoId}${options.expires}`).digest('hex'));
    url.searchParams.set('expires', String(options.expires));
  }
  return url.href;
}
export function bunnyCdnUrl(hostname: string, path: string): string {
  if (!/^[a-z0-9][a-z0-9-]*\.b-cdn\.net$/.test(hostname)) throw new Error('Use your Bunny pull zone’s b-cdn.net hostname.');
  return `https://${hostname}/${bunnyStoragePath(path)}`;
}
