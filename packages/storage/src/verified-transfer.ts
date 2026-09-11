import { createHash, randomUUID } from 'node:crypto';
import type { ObjectStorage, StoredObject } from './index.js';
import { isObjectKeyWithinPrefix } from './object-key-scope.js';

export interface VerifiedObjectTransferPorts {
  source: Pick<ObjectStorage, 'get'>;
  destination: Pick<ObjectStorage, 'get'>;
  /** Must write only the supplied fresh key, privately, and return the actual
   * versioned reference from the destination provider. Do not invent S3 versions. */
  writeDestination(input: { object: Omit<StoredObject, 'versionId'>; body: Uint8Array }): Promise<StoredObject>;
  /** Caller owns current source/target authorization and policy. Never derive
   * allowed prefixes solely from an untrusted import manifest. */
  admit(input: { source: StoredObject; destination: { bucket: string; key: string } }): Promise<void>;
}

/** Copy one explicitly admitted source to a fresh private destination and verify
 * actual bytes on both sides. Returns no delivery URL and links no domain record. */
export const transferVerifiedObject = async (ports: VerifiedObjectTransferPorts, input: {
  source: StoredObject; sourcePrefix: string; destinationBucket: string; destinationPrefix: string; maxBytes?: number;
}): Promise<StoredObject> => {
  const source = structuredClone(input.source), maxBytes = input.maxBytes ?? 50 * 1024 * 1024;
  const key = `${input.destinationPrefix.replace(/\/$/, '')}/${randomUUID()}`;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !source.bucket || !source.versionId || !source.contentType ||
    !['private', 'restricted', 'public'].includes(source.scope) ||
    !Number.isSafeInteger(source.byteLength) || source.byteLength < 1 || source.byteLength > maxBytes ||
    !/^[a-f0-9]{64}$/.test(source.checksum || '') || !isObjectKeyWithinPrefix(source.key, input.sourcePrefix) ||
    !input.destinationBucket || !isObjectKeyWithinPrefix(key, input.destinationPrefix)) throw new Error('Invalid object transfer scope, lineage or byte budget.');
  const destination = { bucket: input.destinationBucket, key };
  const admit = () => ports.admit({ source: structuredClone(source), destination: { ...destination } });
  const verify = (loaded: { object: StoredObject; body: Uint8Array }, expected: StoredObject) => {
    if (!(loaded.body instanceof Uint8Array) || loaded.body.byteLength !== source.byteLength ||
      createHash('sha256').update(loaded.body).digest('hex') !== source.checksum ||
      ['bucket', 'key', 'versionId', 'contentType', 'byteLength', 'checksum', 'scope'].some(field =>
        loaded.object[field as keyof StoredObject] !== expected[field as keyof StoredObject])) throw new Error('Transferred object failed integrity or reference verification.');
  };
  await admit();
  const loaded = await ports.source.get(structuredClone(source));
  verify(loaded, source);
  // Own bytes across authorization/writer callbacks; source adapters may reuse buffers.
  const body = Uint8Array.from(loaded.body);
  const expected = { ...destination, contentType: source.contentType, byteLength: source.byteLength, checksum: source.checksum, scope: 'private' as const };
  await admit();
  const written = structuredClone(await ports.writeDestination({ object: { ...expected }, body }));
  if (!written.versionId || Object.entries(expected).some(([field, value]) => written[field as keyof StoredObject] !== value)) throw new Error('Destination returned an invalid private transfer reference.');
  const verified = await ports.destination.get(structuredClone(written));
  verify(verified, written);
  await admit();
  return written;
};
