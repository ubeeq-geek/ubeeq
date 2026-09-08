import { requestVimeo, VimeoApiError } from './vimeo-request.js';
export interface VimeoUploadTicket { videoId: string; uploadUrl: string; videoUri: string; }

const readOffset = (response: Response): number => {
  const raw = response.headers.get('upload-offset');
  if (raw === null || !/^[0-9]+$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new VimeoApiError('Vimeo returned an invalid upload offset', 502, false);
  return Number(raw);
};

/** Upload URLs are caller-admitted capabilities. This client never retries. */
export class VimeoUploadClient {
  constructor(private readonly fetcher: typeof fetch = fetch, private readonly apiBase = 'https://api.vimeo.com') {}

  async createUpload(accessToken: string, input: { sizeBytes: number; title: string; description?: string }): Promise<VimeoUploadTicket> {
    if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes <= 0) throw new VimeoApiError('Invalid Vimeo source size', 400, false);
    const response = await requestVimeo(this.fetcher, `${this.apiBase}/me/videos`, {
      method: 'POST', headers: { authorization: `Bearer ${accessToken}`, accept: 'application/vnd.vimeo.*+json;version=3.4', 'content-type': 'application/json' },
      body: JSON.stringify({ upload: { approach: 'tus', size: input.sizeBytes }, name: input.title, description: input.description })
    });
    const value = await response.json() as { uri?: unknown; upload?: { upload_link?: unknown } } | null;
    const videoUri = value?.uri, uploadUrl = value?.upload?.upload_link;
    if (typeof videoUri !== 'string' || !/^\/videos\/[0-9]+$/.test(videoUri) || typeof uploadUrl !== 'string' || !uploadUrl.trim()) throw new VimeoApiError('Vimeo returned an invalid upload ticket', 502, false);
    return { videoUri, videoId: videoUri.slice('/videos/'.length), uploadUrl };
  }

  async uploadOffset(uploadUrl: string): Promise<number> {
    return readOffset(await requestVimeo(this.fetcher, uploadUrl, { method: 'HEAD', headers: { 'tus-resumable': '1.0.0' } }));
  }

  async uploadChunk(uploadUrl: string, offset: number, body: Uint8Array): Promise<number> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !(body instanceof Uint8Array) || !body.byteLength || !Number.isSafeInteger(offset + body.byteLength)) throw new VimeoApiError('Invalid Vimeo upload chunk', 400, false);
    const response = await requestVimeo(this.fetcher, uploadUrl, {
      method: 'PATCH', headers: { 'tus-resumable': '1.0.0', 'upload-offset': String(offset), 'content-type': 'application/offset+octet-stream' },
      body: body as unknown as BodyInit
    });
    const next = readOffset(response);
    if (next !== offset + body.byteLength) throw new VimeoApiError('Vimeo upload offset did not advance as expected', 502, false);
    return next;
  }
}
