import { readBoundedResponseText } from './bounded-response-text.js';

export type YouTubePrivacy = 'private' | 'unlisted' | 'public';
export interface YouTubeUploadMetadata {
  title: string; description: string; tags: readonly string[]; categoryId: string;
  privacy: YouTubePrivacy; madeForKids: boolean; containsSyntheticMedia?: boolean;
  notifySubscribers: boolean;
}
export interface YouTubeUploadProgress { offset: number; videoId?: string }
export class YouTubeUploadError extends Error {
  constructor(readonly code: 'AUTHENTICATION' | 'RATE_LIMIT' | 'TRANSIENT' | 'INVALID_RESPONSE' | 'SESSION_EXPIRED' | 'AMBIGUOUS_INITIATION' | 'REJECTED', readonly status?: number, readonly retryAfterSeconds?: number) {
    super(`YouTube upload ${code.toLowerCase().replace(/_/g, ' ')}.`);
  }
}

/** Session URLs are bearer capabilities. Hosts must encrypt them and exclude them from responses/logs. */
export function validateYouTubeUploadSession(value: string): string {
  let url: URL; try { url = new URL(value); } catch { throw new YouTubeUploadError('INVALID_RESPONSE'); }
  if (url.protocol !== 'https:' || !['www.googleapis.com', 'youtube.googleapis.com'].includes(url.hostname)
    || url.port || url.username || url.password || url.hash || url.pathname !== '/upload/youtube/v3/videos'
    || !url.searchParams.get('upload_id')) throw new YouTubeUploadError('INVALID_RESPONSE');
  return url.toString();
}

const positiveSize = (size: number) => {
  if (!Number.isSafeInteger(size) || size < 1) throw new Error('A positive safe video size is required.');
};
const boundedJson = async (response: Response): Promise<Record<string, any>> => {
  try { const result = JSON.parse(await readBoundedResponseText(response, 256 * 1024));
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error(); return result;
  } catch { throw new YouTubeUploadError('INVALID_RESPONSE', response.status); }
};

/** Google resumable protocol only; no product admission, storage, queue or credential custody. */
export class YouTubeUploadClient {
  constructor(private readonly request: typeof fetch = fetch) {}
  private async send(url: string, init: RequestInit, initiating = false): Promise<Response> {
    let response: Response;
    try { response = await this.request(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(30_000) }); }
    catch { throw new YouTubeUploadError(initiating ? 'AMBIGUOUS_INITIATION' : 'TRANSIENT'); }
    if (response.status === 308 || response.ok) return response;
    await response.body?.cancel().catch(() => undefined);
    const retry = Number(response.headers.get('retry-after'));
    const code = initiating && response.status >= 500 ? 'AMBIGUOUS_INITIATION' : response.status === 401 ? 'AUTHENTICATION' : response.status === 429 ? 'RATE_LIMIT'
      : response.status === 404 || response.status === 410 ? 'SESSION_EXPIRED' : response.status >= 500 ? 'TRANSIENT' : 'REJECTED';
    throw new YouTubeUploadError(code, response.status, Number.isFinite(retry) && retry > 0 ? retry : undefined);
  }
  async initiate(token: string, size: number, mimeType: string, metadata: YouTubeUploadMetadata): Promise<string> {
    positiveSize(size);
    if (typeof metadata.title !== 'string' || typeof metadata.description !== 'string' || !Array.isArray(metadata.tags)
      || metadata.tags.length > 100 || metadata.tags.some(tag => typeof tag !== 'string' || !tag.trim() || tag.length > 500)
      || metadata.tags.map(tag => tag.includes(' ') ? `"${tag}"` : tag).join(',').length > 500
      || metadata.containsSyntheticMedia !== undefined && typeof metadata.containsSyntheticMedia !== 'boolean'
      || !metadata.title.trim() || metadata.title.length > 100 || metadata.description.length > 5000
      || !/^\d+$/.test(metadata.categoryId) || !['private', 'unlisted', 'public'].includes(metadata.privacy)
      || typeof metadata.madeForKids !== 'boolean' || typeof metadata.notifySubscribers !== 'boolean'
      || !/^video\/[a-z0-9.+-]+$/i.test(mimeType)) throw new Error('Invalid YouTube upload metadata.');
    const response = await this.send(`https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status&notifySubscribers=${metadata.notifySubscribers}`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Length': String(size), 'X-Upload-Content-Type': mimeType },
      body: JSON.stringify({ snippet: { title: metadata.title, description: metadata.description, tags: metadata.tags, categoryId: metadata.categoryId },
        status: { privacyStatus: metadata.privacy, selfDeclaredMadeForKids: metadata.madeForKids,
          ...(metadata.containsSyntheticMedia === undefined ? {} : { containsSyntheticMedia: metadata.containsSyntheticMedia }) } })
    }, true);
    const location = response.headers.get('location');
    await response.body?.cancel().catch(() => undefined);
    if (!location) throw new YouTubeUploadError('AMBIGUOUS_INITIATION');
    try { return validateYouTubeUploadSession(location); }
    catch { throw new YouTubeUploadError('AMBIGUOUS_INITIATION'); }
  }
  private async progress(response: Response, size: number): Promise<YouTubeUploadProgress> {
    if (response.status === 308) {
      const range = response.headers.get('range');
      await response.body?.cancel().catch(() => undefined);
      if (!range) return { offset: 0 };
      const match = /^bytes=0-(\d+)$/.exec(range);
      const offset = match ? Number(match[1]) + 1 : NaN;
      if (!Number.isSafeInteger(offset) || offset < 1 || offset > size) throw new YouTubeUploadError('INVALID_RESPONSE');
      return { offset };
    }
    const body = await boundedJson(response);
    if (typeof body.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(body.id)) throw new YouTubeUploadError('INVALID_RESPONSE');
    return { offset: size, videoId: body.id };
  }
  async query(token: string, session: string, size: number): Promise<YouTubeUploadProgress> {
    positiveSize(size);
    return this.progress(await this.send(validateYouTubeUploadSession(session), {
      method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Length': '0', 'Content-Range': `bytes */${size}` }
    }), size);
  }
  async uploadChunk(token: string, session: string, size: number, offset: number, body: Uint8Array): Promise<YouTubeUploadProgress> {
    positiveSize(size);
    if (!Number.isSafeInteger(offset) || offset < 0 || !body.byteLength || body.byteLength > 8 * 1024 * 1024 || offset + body.byteLength > size
      || (offset + body.byteLength < size && body.byteLength % (256 * 1024) !== 0)) throw new Error('Invalid YouTube upload range.');
    return this.progress(await this.send(validateYouTubeUploadSession(session), {
      method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream',
        'Content-Length': String(body.byteLength), 'Content-Range': `bytes ${offset}-${offset + body.byteLength - 1}/${size}` },
      body: Buffer.from(body)
    }), size);
  }
  async video(token: string, videoId: string): Promise<Record<string, any>> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(videoId)) throw new Error('Invalid YouTube video identity.');
    const response = await this.send(`https://www.googleapis.com/youtube/v3/videos?part=snippet,status,processingDetails&id=${encodeURIComponent(videoId)}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const body = await boundedJson(response);
    const item = Array.isArray(body.items) ? body.items.find((value: any) => value?.id === videoId) : undefined;
    if (!item) throw new YouTubeUploadError('REJECTED', 404);
    return item;
  }
}

/** Always discover the accepted offset before reading bytes, including after uncertain completion. */
export async function transferYouTubeUpload(input: {
  client: YouTubeUploadClient; token: string; session: string;
  source: { size: number; read(offset: number, length: number): Promise<Uint8Array> };
  chunkBytes?: number; maxChunks?: number; onProgress(progress: YouTubeUploadProgress): Promise<void>;
}): Promise<YouTubeUploadProgress> {
  const chunkBytes = input.chunkBytes ?? 8 * 1024 * 1024, maxChunks = input.maxChunks ?? 8;
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 256 * 1024 || chunkBytes > 8 * 1024 * 1024 || chunkBytes % (256 * 1024)
    || !Number.isSafeInteger(maxChunks) || maxChunks < 1 || maxChunks > 8) throw new Error('Invalid upload transfer budget.');
  let progress = await input.client.query(input.token, input.session, input.source.size);
  await input.onProgress(progress);
  for (let n = 0; !progress.videoId && progress.offset < input.source.size && n < maxChunks; n++) {
    const length = Math.min(chunkBytes, input.source.size - progress.offset);
    const bytes = await input.source.read(progress.offset, length);
    if (bytes.byteLength !== length) throw new Error('Source video changed or was truncated.');
    const next = await input.client.uploadChunk(input.token, input.session, input.source.size, progress.offset, bytes);
    if (next.offset < progress.offset || (!next.videoId && next.offset > progress.offset + length)) throw new YouTubeUploadError('INVALID_RESPONSE');
    if (!next.videoId && next.offset === progress.offset) throw new YouTubeUploadError('TRANSIENT');
    progress = next; await input.onProgress(progress);
  }
  return progress;
}
