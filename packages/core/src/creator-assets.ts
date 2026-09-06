import { CreatorWorkService, type CreatorWorkPort, type CreatorWorkRecord, type CreatorWorkScope } from "./creator-works.js";

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
export interface CreatorAssetAttachment { workId: string; assetId: string; role: "primary" | "content"; position: number }
export interface CreatorAssetMembership { workId: string; assetId: string; role: string; position: number }
export interface CreatorAssetPort<W extends CreatorAssetWork, A extends CreatorAssetIdentity> extends CreatorWorkPort<W> {
  listCanonicalAssetsByWork(tenantId: string, workId: string): Promise<Array<A & { attachment: CreatorAssetMembership }>>;
  /** All three records commit atomically, conditioned on the previous Work revision. */
  commitAssetAttachment(input: { previousRevision: number; work: W; asset: A; attachment: CreatorAssetAttachment }): Promise<void>;
}
export class CreatorAssetError extends Error {
  constructor(public readonly code: "invalid_asset" | "not_found", message: string) { super(message); this.name = "CreatorAssetError"; }
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
