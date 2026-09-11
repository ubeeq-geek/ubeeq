import { VimeoApiError } from './vimeo-request.js';
export interface VimeoUploadSource { sizeBytes: number; read(offset: number, length: number): Promise<Uint8Array>; }
export interface VimeoUploadTransferPort {
  uploadOffset(uploadUrl: string): Promise<number>;
  uploadChunk(uploadUrl: string, offset: number, body: Uint8Array): Promise<number>;
}

/** Transfer one known ticket. No ticket creation, retry, or implicit persistence. */
export async function transferVimeoUpload(input: {
  client: VimeoUploadTransferPort; uploadUrl: string; source: VimeoUploadSource;
  chunkBytes?: number; maxChunks?: number; onProgress(offset: number): Promise<void>;
}): Promise<number> {
  const { client, uploadUrl, source } = input, chunkBytes = input.chunkBytes ?? 8 * 1024 * 1024;
  const maxChunks = input.maxChunks ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(maxChunks) || maxChunks < 1) throw new VimeoApiError('Invalid Vimeo chunk budget', 400, false);
  if (!Number.isSafeInteger(source.sizeBytes) || source.sizeBytes <= 0 || !Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > 64 * 1024 * 1024) throw new VimeoApiError('Invalid Vimeo transfer bounds', 400, false);
  let offset = await client.uploadOffset(uploadUrl);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > source.sizeBytes) throw new VimeoApiError('Vimeo offset exceeds canonical source bounds', 502, false);
  let chunks = 0;
  while (offset < source.sizeBytes && chunks < maxChunks) {
    const length = Math.min(chunkBytes, source.sizeBytes - offset);
    const chunk = await source.read(offset, length);
    if (!(chunk instanceof Uint8Array) || chunk.byteLength !== length) throw new VimeoApiError('Canonical source ended before its declared size', 422, false);
    const next = await client.uploadChunk(uploadUrl, offset, chunk);
    if (next !== offset + length) throw new VimeoApiError('Vimeo upload offset did not advance as expected', 502, false);
    offset = next;
    await input.onProgress(offset);
    chunks++;
  }
  return offset;
}
