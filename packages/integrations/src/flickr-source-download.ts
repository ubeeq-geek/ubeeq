import { createHash } from 'node:crypto';
import { readBoundedBytes } from '@ubeeq/storage';

const approvedUrl = (value: string) => {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && (host === 'live.staticflickr.com' || host.endsWith('.staticflickr.com'));
  } catch { return false; }
};

const detectedMime = (body: Buffer): string | undefined => {
  if (body.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
  if (body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (body.subarray(0, 6).toString('ascii') === 'GIF87a' || body.subarray(0, 6).toString('ascii') === 'GIF89a') return 'image/gif';
  if (body.subarray(0, 4).toString('ascii') === 'RIFF' && body.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return undefined;
};

/** Bounded provider bytes and signature detection; not a safety scan or full image decode. */
export const downloadFlickrSource = async (sourceUrl: string, maxBytes: number, fetcher: typeof fetch = fetch) => {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('FLICKR_SOURCE_INVALID_BYTE_LIMIT');
  if (!approvedUrl(sourceUrl)) throw new Error('FLICKR_SOURCE_URL_REJECTED');
  const response = await fetcher(sourceUrl, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
  const reader = response.body?.getReader();
  let body: Buffer;
  try {
    if (!response.ok) throw new Error(response.status >= 500 ? 'FLICKR_SOURCE_TEMPORARILY_UNAVAILABLE' : 'FLICKR_SOURCE_UNAVAILABLE');
    const declaredSize = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredSize) && declaredSize > maxBytes) throw new Error('FLICKR_SOURCE_TOO_LARGE');
    if (!reader) throw new Error('FLICKR_SOURCE_TOO_LARGE');
    const chunks = async function* () {
      while (true) { const item = await reader.read(); if (item.done) return; yield item.value; }
    };
    try {
      const bytes = await readBoundedBytes(chunks(), maxBytes);
      body = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    } catch (error) {
      if (error instanceof Error && error.message === 'Byte stream exceeds its admission budget') throw new Error('FLICKR_SOURCE_TOO_LARGE');
      throw error;
    }
  } finally {
    if (reader) { try { await reader.cancel(); } catch { /* Preserve the original failure. */ } reader.releaseLock(); }
  }
  if (!body.length || body.length > maxBytes) throw new Error('FLICKR_SOURCE_TOO_LARGE');
  const mimeType = detectedMime(body);
  if (!mimeType) throw new Error('FLICKR_SOURCE_MIME_INVALID');
  const checksumSha256 = createHash('sha256').update(body).digest('hex');
  return { body, checksumSha256, mimeType, sizeBytes: body.length };
};
