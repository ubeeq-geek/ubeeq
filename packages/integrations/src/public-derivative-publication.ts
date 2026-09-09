import { createHash } from 'node:crypto';

const safeSegment = (name: string, value: string): string => {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`${name} is not safe for a public delivery key`);
  return value;
};

const extensionFor = (contentType: string): string => {
  const extensions: Record<string, string> = {
    'image/avif': 'avif', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
    'video/mp4': 'mp4', 'video/webm': 'webm'
  };
  const extension = extensions[contentType.toLowerCase()];
  if (!extension) throw new Error('Public derivative content type is not supported');
  return extension;
};

export interface PublicDerivativePublication {
  id: string;
  recordType: 'PUBLIC_DERIVATIVE_PUBLICATION';
  product: string;
  environment: string;
  dataHomeRegion: string;
  assetId: string;
  mediaVersionId: string;
  scanGroupId: string;
  sourceBucket: string;
  sourceObjectKey: string;
  destinationBucket: string;
  destinationObjectKey: string;
  contentHash: string;
  contentType: string;
  state: 'PUBLISHING' | 'PUBLISHED' | 'FAILED';
  createdAt: string;
  publishedAt?: string;
}

export interface PublicDerivativePublicationRepository {
  /** Optional read-only recovery of an exact receipt and its current published asset. */
  completedReceipt?(publication: PublicDerivativePublication): Promise<{ createdAt: string; publishedAt: string } | undefined>;
  /** Must conditionally create the publication and reject an existing id. */
  begin(publication: PublicDerivativePublication): Promise<void>;
  /** Must atomically mark the Asset PUBLISHED and append its regional audit event. */
  complete(publication: PublicDerivativePublication): Promise<void>;
  /** Conditionally fences PUBLISHING -> FAILED against completion before object cleanup. */
  fail(publication: PublicDerivativePublication, reason: string): Promise<void>;
}

export const publicDerivativePublicationKey = (publicationId: string): string => `PUBLICATION#${publicationId}`;
export const publicDerivativeAssetKey = (assetId: string): string => `ASSET#${assetId}`;

export interface PublicDerivativePublicationStore {
  copy(input: { sourceBucket: string; sourceObjectKey: string; destinationBucket: string; destinationObjectKey: string; contentType: string; contentHash: string }): Promise<void>;
  remove(input: { bucket: string; objectKey: string }): Promise<void>;
}

export interface PublishPublicDerivativeInput {
  product: string;
  environment: string;
  dataHomeRegion: string;
  assetId: string;
  mediaVersionId: string;
  scanGroupId: string;
  contentHash: string;
  contentType: string;
  sourceBucket: string;
  sourceObjectKey: string;
  expectedPrivateDerivativesBucket: string;
  publicDerivativesBucket: string;
  expectedPublicDerivativesBucket: string;
}

/**
 * Promotes only a policy-eligible derivative from this cell's private derivative
 * bucket. Originals and quarantine objects can never be selected as the source.
 */
export const publishPublicDerivative = async <P extends string, R extends string>(
  input: PublishPublicDerivativeInput & { product: P; dataHomeRegion: R },
  repository: PublicDerivativePublicationRepository,
  store: PublicDerivativePublicationStore,
  admit?: (input: Readonly<PublishPublicDerivativeInput>) => boolean | Promise<boolean>,
  now = new Date().toISOString()
): Promise<PublicDerivativePublication & { product: P; dataHomeRegion: R }> => {
  input = structuredClone(input);
  if (!input.environment.trim()) throw new Error('Publication environment is required');
  if (input.sourceBucket !== input.expectedPrivateDerivativesBucket) throw new Error('Public delivery source must be this cell\'s private derivatives bucket');
  if (input.publicDerivativesBucket !== input.expectedPublicDerivativesBucket) throw new Error('Public delivery destination must be this cell\'s public derivatives bucket');
  if (!input.sourceObjectKey || input.sourceObjectKey.startsWith('/') || input.sourceObjectKey.includes('..')) throw new Error('Private derivative object key is invalid');
  if (!/^[a-fA-F0-9]{64}$/.test(input.contentHash)) throw new Error('Public derivative requires an authoritative SHA-256');
  if (await admit?.(structuredClone(input)) !== true) throw new Error('Public derivative publication not admitted');

  const assetId = safeSegment('Asset identifier', input.assetId);
  const mediaVersionId = safeSegment('Media version identifier', input.mediaVersionId);
  const scanGroupId = safeSegment('Scan group identifier', input.scanGroupId);
  const extension = extensionFor(input.contentType);
  const identity = createHash('sha256').update([
    input.product, input.environment, input.dataHomeRegion, assetId, mediaVersionId,
    scanGroupId, input.contentHash
  ].join('\u0000')).digest('hex');
  const publication: PublicDerivativePublication & { product: P; dataHomeRegion: R } = {
    id: `publication-${identity}`, recordType: 'PUBLIC_DERIVATIVE_PUBLICATION',
    product: input.product, environment: input.environment, dataHomeRegion: input.dataHomeRegion,
    assetId, mediaVersionId, scanGroupId, sourceBucket: input.sourceBucket,
    sourceObjectKey: input.sourceObjectKey, destinationBucket: input.publicDerivativesBucket,
    // Different scan/publication identities must not share a cleanup target.
    // Existing records retain their stored keys; only new attempts use this layout.
    destinationObjectKey: `assets/${assetId}/${mediaVersionId}/${input.contentHash}/${identity}.${extension}`,
    contentHash: input.contentHash.toLowerCase(), contentType: input.contentType.toLowerCase(),
    state: 'PUBLISHING', createdAt: now
  };

  const recover = async (): Promise<(PublicDerivativePublication & { product: P; dataHomeRegion: R }) | undefined> => {
    const timestamps = await repository.completedReceipt?.(publication);
    return timestamps ? { ...publication, ...timestamps, state: 'PUBLISHED' } : undefined;
  };
  try { await repository.begin(publication); }
  catch (error) {
    const completed = await recover();
    if (completed) return completed;
    throw error;
  }
  try {
    await store.copy({
      sourceBucket: publication.sourceBucket, sourceObjectKey: publication.sourceObjectKey,
      destinationBucket: publication.destinationBucket, destinationObjectKey: publication.destinationObjectKey,
      contentType: publication.contentType, contentHash: publication.contentHash
    });
    const completed = { ...publication, state: 'PUBLISHED' as const, publishedAt: now };
    await repository.complete(completed);
    return completed;
  } catch (error) {
    const completed = await recover();
    if (completed) return completed;
    // Fence completion before cleanup. A lost successful completion response
    // must not delete a committed publication; an ambiguous failure transition
    // also leaves bytes alone until its authoritative state can be reconciled.
    try { await repository.fail(publication, error instanceof Error ? error.name : 'PublicationError'); }
    catch (failureError) {
      // Completion may have won after the first recovery read.
      const completed = await recover();
      if (completed) return completed;
      throw failureError;
    }
    await store.remove({ bucket: publication.destinationBucket, objectKey: publication.destinationObjectKey });
    throw error;
  }
};
