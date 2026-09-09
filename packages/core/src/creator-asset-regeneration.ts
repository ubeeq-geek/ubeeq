import { CreatorWorkService, type CreatorWorkPort, type CreatorWorkRecord, type CreatorWorkScope } from './creator-works.js';

export interface CreatorAssetRegenerationRequest extends CreatorWorkScope {
  workId: string; assetId: string; sourceVersionId: string; expectedRevision: number; requestId: string;
  squareCrop?: { x: number; y: number; size: number };
}
export const snapshotCreatorSquareCrop = (value: unknown): CreatorAssetRegenerationRequest['squareCrop'] => {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CreatorAssetRegenerationError('invalid_request', 'Invalid square crop.');
  const crop = value as Record<string, unknown>;
  if (Object.keys(crop).some(key => !['x', 'y', 'size'].includes(key)) || ![crop.x, crop.y, crop.size].every(v => typeof v === 'number' && Number.isFinite(v)) || Number(crop.size) <= 0) {
    throw new CreatorAssetRegenerationError('invalid_request', 'Invalid square crop.');
  }
  return { x: crop.x as number, y: crop.y as number, size: crop.size as number };
};
export interface CreatorAssetRegenerationReceipt { jobId: string; state: string; idempotent: boolean }
export interface CreatorAssetRegenerationPort<W extends CreatorWorkRecord> extends CreatorWorkPort<W> {
  /** Atomically recheck scope, revision, source and membership; deduplicate requests
   * and reject overlapping active jobs. Preserve the current processing result. */
  enqueueAssetRegeneration(input: CreatorAssetRegenerationRequest): Promise<CreatorAssetRegenerationReceipt>;
}
export class CreatorAssetRegenerationError extends Error {
  constructor(public readonly code: 'invalid_request' | 'source_changed' | 'processing_busy' | 'processing_unsupported', message: string) {
    super(message); this.name = 'CreatorAssetRegenerationError';
  }
}
export class CreatorAssetRegenerationService<W extends CreatorWorkRecord> {
  private readonly works: CreatorWorkService<W>;
  constructor(private readonly store: CreatorAssetRegenerationPort<W>, authorize: (scope: CreatorWorkScope) => Promise<boolean>,
    private readonly admit: (input: Readonly<CreatorAssetRegenerationRequest>) => Promise<void>) {
    this.works = new CreatorWorkService(store, authorize);
  }
  async request(input: Omit<CreatorAssetRegenerationRequest, 'creatorId'>): Promise<CreatorAssetRegenerationReceipt> {
    const snapshot = { ...input, squareCrop: snapshotCreatorSquareCrop(input.squareCrop) };
    if ([snapshot.tenantId, snapshot.workId, snapshot.assetId, snapshot.sourceVersionId, snapshot.requestId].some(value =>
      typeof value !== 'string' || !value.trim() || value.length > 500) || !Number.isSafeInteger(snapshot.expectedRevision) || snapshot.expectedRevision < 1) {
      throw new CreatorAssetRegenerationError('invalid_request', 'Regeneration requires identity, source, revision and a bounded request key.');
    }
    const work = await this.works.get(snapshot.tenantId, snapshot.workId);
    const request = { ...snapshot, creatorId: work.creatorId };
    await this.admit(structuredClone(request));
    return this.store.enqueueAssetRegeneration(request);
  }
}
