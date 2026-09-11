import { CreatorWorkError, CreatorWorkService, type CreatorWorkPort, type CreatorWorkRecord, type CreatorWorkScope } from "./creator-works.js";
import { contentAssetReferences } from './content-asset-references.js';

export interface CreatorAssetIdentity extends CreatorWorkScope { assetId: string }
export interface CreatorAssetRecord extends CreatorAssetIdentity {
  assetId: string;
  status: string;
  mimeType: string;
  sizeBytes: number;
  checksumSha256: string;
  storage: { bucket: string; key: string; versionId: string; contentType: string; byteLength: number; checksum: string; scope: "private" };
  createdAt: string;
  updatedAt: string;
  processing?: { state: "completed"; sourceVersionId: string; completedAt: string; metadata: Record<string, string | number | boolean>; renditions: CreatorAssetRendition[] };
}
export interface CreatorAssetRendition {
  id: string;
  sourceVersionId: string;
  role: "preview" | "poster";
  storage: CreatorAssetRecord["storage"];
}
export interface CreatorAssetProcessingCommit {
  jobId: string;
  leaseToken: string;
  tenantId: string;
  creatorId: string;
  workId: string;
  assetId: string;
  sourceVersionId: string;
  metadata: Record<string, string | number | boolean>;
  renditions: CreatorAssetRendition[];
}
export interface CreatorAssetProcessingPort {
  getProcessingAsset(tenantId: string, assetId: string): Promise<CreatorAssetRecord | null>;
  /** Atomically persist results and complete the current, unexpired job lease. */
  commitAssetProcessing(input: CreatorAssetProcessingCommit): Promise<void>;
}
export interface CreatorAssetWork extends CreatorWorkRecord { primaryAssetId?: string }
export interface CreatorAssetDetachmentCommit extends CreatorWorkScope {
  workId: string; assetId: string; expectedRevision: number; updatedAt: string;
}
export interface CreatorAssetDetachmentPort<W extends CreatorAssetWork> extends CreatorWorkPort<W> {
  /** Atomically recheck revision, membership and content references; detach, normalize order/primary and cancel matching active jobs. Retain stored files and assets. */
  commitAssetDetachment(input: CreatorAssetDetachmentCommit): Promise<W>;
}
export class CreatorAssetDetachmentService<W extends CreatorAssetWork> {
  private readonly works: CreatorWorkService<W>;
  constructor(private readonly store: CreatorAssetDetachmentPort<W>, authorize: (scope: CreatorWorkScope) => Promise<boolean>,
    private readonly now: () => string = () => new Date().toISOString()) { this.works = new CreatorWorkService(store, authorize, now); }
  async detach(tenantId: string, workId: string, assetId: string, expectedRevision: number): Promise<W> {
    const work = await this.works.get(tenantId, workId);
    if (work.status === 'deleted') throw new CreatorAssetError('not_found', 'Work not found.');
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || expectedRevision !== work.revision) {
      throw new CreatorWorkError('revision_conflict', 'Work changed; refresh before removing an asset.');
    }
    const content = work as W & { body?: unknown; media?: unknown };
    if (contentAssetReferences(content.body, content.media).includes(assetId)) {
      throw new CreatorAssetError('asset_in_use', 'Remove this asset from the saved Work content before detaching it.');
    }
    return structuredClone(await this.store.commitAssetDetachment({ tenantId, creatorId: work.creatorId, workId, assetId, expectedRevision, updatedAt: this.now() }));
  }
}
export interface CreatorAssetAttachment { workId: string; assetId: string; role: "primary" | "content"; position: number }
export interface CreatorAssetMembership { workId: string; assetId: string; role: string; position: number }
export interface CreatorPrimaryAssetCommit extends CreatorWorkScope {
  workId: string; assetId: string; expectedRevision: number; updatedAt: string;
}
export interface CreatorAssetOrderCommit extends CreatorWorkScope {
  workId: string; assetIds: string[]; expectedRevision: number; updatedAt: string;
}
export interface CreatorAssetOrderPort<W extends CreatorAssetWork, A extends CreatorAssetIdentity> extends CreatorWorkPort<W> {
  listCanonicalAssetsByWork(tenantId: string, workId: string): Promise<Array<A & { attachment: CreatorAssetMembership }>>;
  /** Atomically require the exact existing membership and revision; preserve primary selection and unrelated fields. */
  commitAssetOrder(input: CreatorAssetOrderCommit): Promise<W>;
}
export class CreatorAssetOrderService<W extends CreatorAssetWork, A extends CreatorAssetIdentity> {
  private readonly works: CreatorWorkService<W>;
  constructor(private readonly store: CreatorAssetOrderPort<W, A>, authorize: (scope: CreatorWorkScope) => Promise<boolean>,
    private readonly now: () => string = () => new Date().toISOString()) {
    this.works = new CreatorWorkService(store, authorize, now);
  }
  async replace(tenantId: string, workId: string, assetIds: string[], expectedRevision: number): Promise<W> {
    const ids = Array.isArray(assetIds) ? [...assetIds] : [];
    const work = await this.works.get(tenantId, workId);
    if (work.status === 'deleted') throw new CreatorAssetError('not_found', 'Work not found.');
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || expectedRevision !== work.revision) {
      throw new CreatorWorkError('revision_conflict', 'Work changed; refresh before reordering assets.');
    }
    const assets = await this.store.listCanonicalAssetsByWork(tenantId, workId);
    if (!Array.isArray(assetIds) || new Set(ids).size !== ids.length || new Set(assets.map(item => item.assetId)).size !== assets.length || ids.length !== assets.length ||
      ids.some(id => typeof id !== 'string' || !id) || assets.some(item => item.tenantId !== tenantId || item.creatorId !== work.creatorId ||
        item.attachment.workId !== workId || item.attachment.assetId !== item.assetId || !ids.includes(item.assetId))) {
      throw new CreatorAssetError('invalid_asset', 'Supply every attached asset exactly once.');
    }
    return structuredClone(await this.store.commitAssetOrder({ tenantId, creatorId: work.creatorId, workId, assetIds: ids, expectedRevision, updatedAt: this.now() }));
  }
}
export interface CreatorPrimaryAssetPort<W extends CreatorAssetWork, A extends CreatorAssetIdentity> extends CreatorWorkPort<W> {
  listCanonicalAssetsByWork(tenantId: string, workId: string): Promise<Array<A & { attachment: CreatorAssetMembership }>>;
  /** Atomically check revision and live membership, update primary pointer and all roles; preserve order and other Work fields. */
  commitPrimaryAsset(input: CreatorPrimaryAssetCommit): Promise<W>;
}
export class CreatorPrimaryAssetService<W extends CreatorAssetWork, A extends CreatorAssetIdentity> {
  private readonly works: CreatorWorkService<W>;
  constructor(private readonly store: CreatorPrimaryAssetPort<W, A>, authorize: (scope: CreatorWorkScope) => Promise<boolean>,
    private readonly now: () => string = () => new Date().toISOString()) {
    this.works = new CreatorWorkService(store, authorize, now);
  }
  async select(tenantId: string, workId: string, assetId: string, expectedRevision: number): Promise<W> {
    const work = await this.works.get(tenantId, workId);
    if (work.status === 'deleted') throw new CreatorAssetError('not_found', 'Work not found.');
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || expectedRevision !== work.revision) {
      throw new CreatorWorkError('revision_conflict', 'Work changed; refresh before selecting its primary asset.');
    }
    const assets = await this.store.listCanonicalAssetsByWork(tenantId, workId);
    const asset = assets.find(item => item.assetId === assetId && item.tenantId === tenantId && item.creatorId === work.creatorId &&
      item.attachment.workId === workId && item.attachment.assetId === assetId);
    if (!asset || !isPrivateStoredCreatorAsset(asset) || (asset as unknown as CreatorAssetRecord).status === 'deleted') {
      throw new CreatorAssetError('invalid_asset', 'Select an attached private asset.');
    }
    return structuredClone(await this.store.commitPrimaryAsset({ tenantId, creatorId: work.creatorId, workId, assetId, expectedRevision, updatedAt: this.now() }));
  }
}
export interface CreatorAssetPort<W extends CreatorAssetWork, A extends CreatorAssetIdentity> extends CreatorWorkPort<W> {
  listCanonicalAssetsByWork(tenantId: string, workId: string): Promise<Array<A & { attachment: CreatorAssetMembership }>>;
  /** All three records commit atomically, conditioned on the previous Work revision. */
  commitAssetAttachment(input: { previousRevision: number; work: W; asset: A; attachment: CreatorAssetAttachment }): Promise<void>;
}
export class CreatorAssetError extends Error {
  constructor(public readonly code: "invalid_asset" | "not_found" | "asset_in_use", message: string) { super(message); this.name = "CreatorAssetError"; }
}
/** Select only current private outputs. Callers must authorize the attached asset first. */
export const selectPrivateAssetRendition = (asset: CreatorAssetRecord, renditionId: string): CreatorAssetRendition => {
  const processing = asset.processing;
  const rendition = processing?.renditions.find((item) => item.id === renditionId);
  if (asset.status === "deleted" || asset.storage?.scope !== "private" || !asset.storage.versionId ||
    processing?.state !== "completed" || processing.sourceVersionId !== asset.storage.versionId ||
    !rendition || rendition.sourceVersionId !== asset.storage.versionId || rendition.storage?.scope !== "private" ||
    !rendition.storage.versionId || !["preview", "poster"].includes(rendition.role)) {
    throw new CreatorAssetError("not_found", "Rendition not found.");
  }
  return structuredClone(rendition);
};
export const isPrivateStoredCreatorAsset = (input: CreatorAssetIdentity): boolean => {
  const asset = input as CreatorAssetRecord;
  return Number.isSafeInteger(asset.sizeBytes) && asset.sizeBytes > 0 && /^[a-f0-9]{64}$/.test(asset.checksumSha256)
    && asset.storage?.scope === "private" && asset.storage.byteLength === asset.sizeBytes
    && asset.storage.checksum === asset.checksumSha256 && Boolean(asset.storage.versionId);
};
export class CreatorAssetService<W extends CreatorAssetWork, A extends CreatorAssetIdentity> {
  private readonly works: CreatorWorkService<W>;
  constructor(private readonly store: CreatorAssetPort<W, A>, authorize: (scope: CreatorWorkScope) => Promise<boolean>, private readonly now: () => string = () => new Date().toISOString(),
    private readonly validateStoredAsset: (asset: A) => boolean = isPrivateStoredCreatorAsset) {
    this.works = new CreatorWorkService(store, authorize, now);
  }
  async list(tenantId: string, workId: string): Promise<Array<A & { attachment: CreatorAssetMembership }>> {
    await this.works.get(tenantId, workId);
    return this.store.listCanonicalAssetsByWork(tenantId, workId);
  }
  async attach(tenantId: string, workId: string, asset: A): Promise<{ work: W; asset: A; attachment: CreatorAssetAttachment }> {
    const previous = await this.works.get(tenantId, workId);
    if (previous.status === "deleted") throw new CreatorAssetError("not_found", "Work not found.");
    if (asset.tenantId !== tenantId || asset.creatorId !== previous.creatorId || !asset.assetId || !this.validateStoredAsset(asset)) {
      throw new CreatorAssetError("invalid_asset", "Uploaded asset does not match its Work or stored object.");
    }
    const existing = await this.store.listCanonicalAssetsByWork(tenantId, workId);
    const attachment: CreatorAssetAttachment = { workId, assetId: asset.assetId, role: previous.primaryAssetId ? "content" : "primary", position: existing.length };
    const work = { ...previous, primaryAssetId: previous.primaryAssetId || asset.assetId, revision: previous.revision + 1, updatedAt: this.now() };
    await this.store.commitAssetAttachment({ previousRevision: previous.revision, work, asset, attachment });
    return { work, asset, attachment };
  }
}
