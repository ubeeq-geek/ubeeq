/**
 * Collect a byte stream within a caller-owned admission budget. This is not a
 * streaming-to-disk API: working and replacement/final buffers can coexist in
 * memory. Transport deadlines and disposal before iteration remain caller-owned.
 */
export async function readBoundedBytes(source: AsyncIterable<Uint8Array>, maxBytes: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Byte budget must be a positive safe integer');
  let buffer = new Uint8Array(0);
  let size = 0;
  for await (const chunk of source) {
    if (!(chunk instanceof Uint8Array)) throw new Error('Byte stream yielded a non-byte chunk');
    if (chunk.byteLength > maxBytes - size) throw new Error('Byte stream exceeds its admission budget');
    if (chunk.byteLength) {
      if (size + chunk.byteLength > buffer.byteLength) {
        const capacity = Math.min(maxBytes, Math.max(size + chunk.byteLength, buffer.byteLength * 2, 1024));
        const replacement = new Uint8Array(capacity);
        replacement.set(buffer.subarray(0, size));
        buffer = replacement;
      }
      // Copy immediately: producers may reuse buffers. Do not retain one object
      // per chunk, which lets tiny chunks exhaust memory despite a byte budget.
      buffer.set(chunk, size);
      size += chunk.byteLength;
    }
  }
  return size === buffer.byteLength ? buffer : buffer.slice(0, size);
}
