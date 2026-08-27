/** Stable, product-neutral domain identifiers. */
export type EntityId = string & { readonly __entityId: unique symbol };

/** The single authoritative regional cell for creator-owned mutable data. */
export interface DataHome {
  cellId: string;
  region: string;
  assignedAt: string;
  routingRevision: number;
}

/** Common shape inherited by every creator-owned aggregate. */
export interface CellOwned {
  dataHome: DataHome;
}

export const validateDataHome = (dataHome: DataHome): DataHome => {
  if (!dataHome.cellId?.trim()) throw new Error("Data-home cellId is required");
  if (!dataHome.region?.trim()) throw new Error("Data-home region is required");
  if (!dataHome.assignedAt || Number.isNaN(Date.parse(dataHome.assignedAt))) throw new Error("Data-home assignedAt must be an ISO timestamp");
  if (!Number.isSafeInteger(dataHome.routingRevision) || dataHome.routingRevision < 1) throw new Error("Data-home routingRevision must be a positive integer");
  return dataHome;
};

export interface AuditEvent extends CellOwned {
  id: EntityId;
  occurredAt: string;
  actorId?: EntityId;
  type: string;
  subjectId: EntityId;
  metadata?: Record<string, unknown>;
}

export interface UsageRecord extends CellOwned {
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

export interface Work extends CellOwned {
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

export interface Asset extends CellOwned {
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

export type CreatorStatus = "active" | "inactive";
export type CollectionType = "collection" | "gallery" | "series" | "playlist";
export type CollectionStatus = "draft" | "published" | "archived" | "deleted";
export type PublicationVisibility = "private" | "unlisted" | "public";
export type PublicationStatus = "draft" | "scheduled" | "queued" | "publishing" | "live" | "updating" | "failed" | "missing" | "removed" | "unknown";
export type PublicationSyncStatus = "not_applicable" | "in_sync" | "local_newer" | "remote_newer" | "conflict" | "error" | "unknown";
export type PublicationIntentStatus = "draft" | "live" | "scheduled";

export interface Creator extends CellOwned {
  id: EntityId;
  instanceId: EntityId;
  name: string;
  slug: string;
  slugHistory: readonly string[];
  bio?: string;
  links?: readonly { label: string; url: string }[];
  status: CreatorStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Collection extends CellOwned {
  id: EntityId;
  instanceId: EntityId;
  creatorId: EntityId;
  type: CollectionType;
  title: string;
  slug: string;
  slugHistory: readonly string[];
  description?: string;
  coverAssetId?: EntityId;
  status: CollectionStatus;
  visibility: PublicationVisibility;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  deletedAt?: string;
}

export interface CollectionWork {
  collectionId: EntityId;
  workId: EntityId;
  position: number;
  addedAt: string;
}

export interface PublicationReconciliationField {
  field: string;
  lastSynced: unknown;
  local: unknown;
  remote: unknown;
  localChanged: boolean;
  remoteChanged: boolean;
  conflict: boolean;
}

export interface Publication extends CellOwned {
  id: EntityId;
  instanceId: EntityId;
  creatorId: EntityId;
  workId: EntityId;
  /** Product extensions choose a destination; Ubeeq core does not maintain a provider list. */
  destinationId: string;
  connectionId?: EntityId;
  status: PublicationStatus;
  visibility: PublicationVisibility;
  remoteId?: string;
  remoteUrl?: string;
  metadataOverrides?: Readonly<{ title?: string; description?: string; tags?: readonly string[]; fields?: Readonly<Record<string, unknown>> }>;
  sync: {
    status: PublicationSyncStatus;
    lastAttemptAt?: string;
    lastSuccessfulAt?: string;
    localRevision?: number;
    remoteMetadataFingerprint?: string;
    remoteContentFingerprint?: string;
    retry?: { idempotencyKey: string; attempt: number; nextAttemptAt?: string; connectionCooldownUntil?: string };
    errorCode?: string;
    errorMessage?: string;
    reconciliation?: { status: "in_sync" | "local_newer" | "remote_newer" | "non_conflicting_changes" | "conflict"; fields: readonly PublicationReconciliationField[]; updatedAt: string };
  };
  createdAt: string;
  updatedAt: string;
  publishedAt?: string;
  removedAt?: string;
}

export interface PublicationIntent extends CellOwned {
  id: EntityId;
  instanceId: EntityId;
  creatorId: EntityId;
  workId: EntityId;
  destinationId: string;
  connectionId?: EntityId;
  enabled: boolean;
  desiredStatus: PublicationIntentStatus;
  scheduledAt?: string;
  createdAt: string;
  updatedAt: string;
}

export const isCollectionVisible = (collection: Pick<Collection, "status" | "visibility">): boolean =>
  collection.status === "published" && collection.visibility !== "private";

export const isPublicationActive = (publication: Pick<Publication, "status">): boolean =>
  publication.status === "live" || publication.status === "updating";

export type ContentBlockType =
  | "section"
  | "heading"
  | "paragraph"
  | "image"
  | "video"
  | "audio"
  | "quote"
  | "divider"
  | "embed"
  | "file"
  | "link"
  | "credit"
  | "grouping"
  | "carousel"
  | "pdf_preview"
  | "html_fragment";

/** A portable, structured content tree. Rendering and sanitization are adapter responsibilities. */
export interface ContentBlock {
  id: EntityId;
  type: ContentBlockType;
  text?: string;
  level?: number;
  assetId?: EntityId;
  fileId?: EntityId;
  caption?: string;
  quote?: string;
  author?: string;
  url?: string;
  mimeType?: string;
  title?: string;
  label?: string;
  html?: string;
  data?: Readonly<Record<string, unknown>>;
  children?: readonly ContentBlock[];
}

export interface ContentMediaReference {
  assetId: EntityId;
  discoverable?: boolean;
  position?: number;
  caption?: string;
  credit?: { label: string; url?: string };
  comparison?: {
    type?: string;
    role?: string;
    order?: number;
    item?: { assetId: EntityId; role?: string; order?: number; caption?: string; credit?: { label: string; url?: string } };
  };
}

export const validateContentBlocks = (blocks: readonly ContentBlock[]): void => {
  const ids = new Set<string>();
  const visit = (items: readonly ContentBlock[]): void => {
    for (const block of items) {
      if (!block.id?.trim()) throw new Error("Content block id is required");
      if (ids.has(block.id)) throw new Error(`Content block id ${block.id} is duplicated`);
      ids.add(block.id);
      if (block.level !== undefined && (!Number.isInteger(block.level) || block.level < 1)) throw new Error(`Content block ${block.id} has an invalid level`);
      if (block.children) visit(block.children);
    }
  };
  visit(blocks);
};
