import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { isAbsolute } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** Node stream sink. Caller owns the private attempt directory and partial-file cleanup. */
export const writeBoundedStreamFile = async (body: Readable, path: string, limits: {
  maximumBytes: number; contentLength?: number; expectedLength?: number;
}): Promise<{ byteLength: number; checksumSha256: string }> => {
  if (!(body instanceof Readable)) throw new Error('A Node readable stream is required');
  try {
    let { maximumBytes } = limits;
    const { contentLength, expectedLength } = limits;
    if (!isAbsolute(path) || path.includes('\0')) throw new Error('An absolute local output path is required');
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw new Error('Invalid stream byte budget');
    if (contentLength !== undefined && (!Number.isSafeInteger(contentLength) || contentLength < 1 || contentLength > maximumBytes)) throw new Error('Invalid stream content length');
    if (expectedLength !== undefined) {
      if (!Number.isSafeInteger(expectedLength) || expectedLength < 1 || expectedLength > maximumBytes ||
        (contentLength !== undefined && contentLength !== expectedLength)) throw new Error('Stream does not match expected length');
      maximumBytes = expectedLength;
    }
    let total = 0;
    const hash = createHash('sha256');
    const bounded = new Transform({ transform(chunk, _encoding, callback) {
      if (!(chunk instanceof Uint8Array) || chunk.byteLength > maximumBytes - total) { callback(new Error('Stream exceeds byte budget')); return; }
      total += chunk.byteLength; hash.update(chunk); callback(null, chunk);
    } });
    await pipeline(body, bounded, createWriteStream(path, { flags: 'wx', mode: 0o600 }));
    if (!total || (contentLength !== undefined && total !== contentLength) || (expectedLength !== undefined && total !== expectedLength)) throw new Error('Stream length does not match its metadata or expectation');
    return { byteLength: total, checksumSha256: hash.digest('hex') };
  } finally { body.destroy(); }
};
