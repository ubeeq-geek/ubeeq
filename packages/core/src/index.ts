/** Stable, product-neutral domain identifiers. */
export type EntityId = string & { readonly __entityId: unique symbol };

export interface AuditEvent {
  id: EntityId;
  occurredAt: string;
  actorId?: EntityId;
  type: string;
  subjectId: EntityId;
  metadata?: Record<string, unknown>;
}

export interface UsageRecord {
  id: EntityId;
  accountId: EntityId;
  meter: string;
  quantity: number;
  recordedAt: string;
  source: string;
}

/** Stable, product-neutral content lifecycle contracts. */
export type WorkKind = "image" | "gallery" | "video" | "audio" | "literature" | "article" | "animation" | "mixed";
export type WorkStatus = "draft" | "ready" | "archived" | "deleted";
export type WorkOriginType = "local" | "import";
export type AssetKind = "image" | "video" | "audio" | "document" | "archive" | "other";
export type AssetStatus = "processing" | "ready" | "failed" | "replaced" | "deleted";
export type WorkAssetRole = "primary" | "content" | "attachment" | "source" | "preview";
export type ContentAvailability = "metadata_only" | "external_reference" | "display_copy" | "original_hosted";

export interface WorkOrigin {
  type: WorkOriginType;
  /** An external provider identifier; public Ubeeq never hard-codes a product's catalogue. */
  providerId?: string;
  connectionId?: EntityId;
  remoteId?: string;
  remoteUrl?: string;
  importedAt?: string;
}

export interface Work {
  id: EntityId;
  instanceId: EntityId;
  creatorId: EntityId;
  kind: WorkKind;
  title: string;
  slug: string;
  slugHistory: readonly string[];
  description?: string;
  tags: readonly string[];
  status: WorkStatus;
  origin: WorkOrigin;
  primaryAssetId?: EntityId;
  revision: number;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  deletedAt?: string;
}

export interface AssetStorage {
  mode: "hosted" | "external";
  objectKey?: string;
  thumbnailObjectKey?: string;
  externalUrl?: string;
}

export interface Asset {
  id: EntityId;
  instanceId: EntityId;
  creatorId: EntityId;
  kind: AssetKind;
  status: AssetStatus;
  mimeType: string;
  originalFilename?: string;
  sizeBytes?: number;
  checksumSha256?: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  storage: AssetStorage;
  metadata?: Readonly<Record<string, string | number | boolean | null>>;
  createdAt: string;
  updatedAt: string;
  replacedByAssetId?: EntityId;
  deletedAt?: string;
}

export interface WorkAsset {
  workId: EntityId;
  assetId: EntityId;
  role: WorkAssetRole;
  position: number;
  caption?: string;
  altText?: string;
}

export type WorkWithAssets = Work & {
  assets: readonly (Asset & { attachment: WorkAsset })[];
};

/** Derives delivery availability without imposing a product retention or visibility policy. */
export const contentAvailabilityFor = (work: Pick<Work, "origin">, assets: WorkWithAssets["assets"]): ContentAvailability => {
  if (!assets.length) return work.origin.type === "import" && work.origin.remoteId ? "external_reference" : "metadata_only";
  const hosted = assets.filter((asset) => asset.storage.mode === "hosted" && asset.status === "ready");
  if (hosted.some((asset) => asset.metadata?.sourceCopyQuality !== "display_copy")) return "original_hosted";
  return hosted.length ? "display_copy" : "external_reference";
};
