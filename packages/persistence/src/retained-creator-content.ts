import type * as Core from '@ubeeq/core';

/** Retained creator-content fields. The host narrows destinations and adds its
 * product fields; storage never rewrites those fields or persisted identities. */
export namespace RetainedCreatorContent {
 export type ContentRating='general'|'suggestive'|'mature'|'sexual'|'fetish'|'graphic';
 export type AiDisclosure='none'|'ai-assisted'|'ai-generated';
 export type HeavyTopic='politics-public-affairs'|'crime-disasters-tragedy';
 export type PostBlock=Core.StoredPostBlock;
export type TenantId = string;
export type WorkKind = Core.WorkKind;
export type WorkStatus = Core.WorkStatus;
export type WorkOriginType = Core.WorkOriginType;
export type ContentAvailability = Core.ContentAvailability;
export type CanonicalAssetKind = Core.AssetKind;
export type CanonicalAssetStatus = Core.AssetStatus;
export type WorkAssetRole = Core.WorkAssetRole;
export type CreatorCollectionType = Core.CollectionType;
export type CreatorCollectionStatus = Core.CollectionStatus;
export type PublicationDestination = string;
export type PublicationStatus = Core.PublicationStatus;
export type PublicationVisibility = Core.PublicationVisibility;
export type PublicationSyncStatus = Core.PublicationSyncStatus;
export type PublicationIntentStatus = Core.PublicationIntentStatus;
export type DiscoveryParticipationState = 'none' | 'eligible' | 'opted_in' | 'removed';

/**
 * Provider-neutral provenance for a Work's AI disclosure. `unknown` is
 * intentionally distinct from `none`: an imported provider record without an
 * AI label is not evidence that no AI was used.
 */
export type AiProvenanceAssertion = AiDisclosure | 'unknown';
export type AiProvenanceSourceKind = 'creator' | 'moderator' | 'provider' | 'import' | 'content-credentials' | 'system';
export interface AiProvenanceSource {
  kind: AiProvenanceSourceKind;
  assertion: AiProvenanceAssertion;
  assertedAt: string;
  platform?: PublicationDestination;
  remoteId?: string;
  /** Stable provider field or internal rule identifier; never a raw payload. */
  basis?: string;
}
export interface AiProvenance {
  assertion: AiProvenanceAssertion;
  sources: readonly AiProvenanceSource[];
  updatedAt: string;
}

/** An append-only record of exactly what was disclosed for one remote attempt. */
export interface PublicationDisclosureSnapshot {
  version: 1;
  snapshotId: string;
  attemptKey: string;
  capturedAt: string;
  workRevision: number;
  contentRating: ContentRating;
  aiDisclosure: AiDisclosure;
  aiProvenance: AiProvenance;
  heavyTopics: readonly HeavyTopic[];
  assetChecksumsSha256: readonly string[];
  fingerprintSha256: string;
}

export interface Work {
  contentPreparationMetadata?:{workflowId:string;fingerprint:string};
  watermarkPolicy?:unknown;
  imageRenditions?:unknown;
  collectionDefaultsSource?:unknown;
  sharedMetadataLink?:unknown;
  fieldMetadata?:unknown;
  workId: string;
  tenantId: TenantId;
  creatorId: string;
  kind: WorkKind;
  title: string;
  slug: string;
  slugHistory: string[];
  description?: string;
  tags: string[];
  body?: PostBlock[];
  contentRating: ContentRating;
  aiDisclosure: AiDisclosure;
  aiProvenance?: AiProvenance;
  heavyTopics: HeavyTopic[];
  status: WorkStatus;
  origin: {
    type: WorkOriginType;
    platform?: PublicationDestination;
    integrationAccountId?: string;
    remoteId?: string;
    remoteUrl?: string;
    importedAt?: string;
  };
  primaryAssetId?: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  deletedAt?: string;
}

export interface CanonicalAsset {
  assetId: string;
  tenantId: TenantId;
  creatorId: string;
  kind: CanonicalAssetKind;
  status: CanonicalAssetStatus;
  mimeType: string;
  originalFilename?: string;
  sizeBytes?: number;
  checksumSha256?: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  storage: {
    mode: 'hosted' | 'external';
    objectKey?: string;
    thumbnailObjectKey?: string;
    externalUrl?: string;
  };
  metadata?: Record<string, string | number | boolean | null>;
  aiProvenance?: AiProvenance;
  createdAt: string;
  updatedAt: string;
  replacedByAssetId?: string;
  deletedAt?: string;
}

export interface WorkAsset {
  /** Retirement belongs to this Work; the source may still be used by other Works. */
  replacedByAssetId?:string;
  workId: string;
  assetId: string;
  role: WorkAssetRole;
  position: number;
  caption?: string;
  altText?: string;
}

export type CollectionPurpose = 'spaces' | 'websites';
export interface CreatorCollection {
  relationships?: unknown;
  category?:unknown;
  watermarkPolicy?:unknown;
  imageRenditions?:unknown;
  shareWatermark?:unknown;
  /** Parent volumes; a collection may appear in several, without moving its Works. */
  volumeIds?: string[];
  purchaseSettings?: { premium: boolean };
  workDefaults?:unknown;
  /** Retained legacy intent; surfaced as pending connection setup when unconfigured. */
  purposes?: CollectionPurpose[];
  /** Explicit pending setup overrides retained legacy purpose hints. */
  connectionSetup?: {space?:boolean;website?:boolean};
  discordConnections?: Array<{destinationId:string;label?:string;createdAt:string}>;
  websiteConnections?: Array<{destinationId:string;label?:string;createdAt:string}>;
  revision?: number;
  sourceCollectionId?: string;
  membershipRevision?: number;
  metadataRevision?: number;
  /** Released presentation; never a second editable catalogue record. */
  publicMetadata?:unknown;
  managementState?: 'draft' | 'active' | 'archived';
  /** Sticky publication/import/sync history; detaching a destination must not make deletion safe. */
  publicationHistoryAt?:string;
  /** Actual Work publication history, independent of legacy metadata/import history. */
  workPublicationHistoryAt?:string;
  collectionId: string;
  tenantId: TenantId;
  creatorId: string;
  type: CreatorCollectionType;
  title: string;
  slug: string;
  slugHistory: string[];
  description?: string;
  coverAssetId?: string;
  coverImage?: {
    format?:unknown;
    fit?:'contain'|'cover';
    sourceKey:string;
    renditionKeys:{desktop:string;tablet:string;mobile:string};
    focalPoint:{x:number;y:number};
    zoom?:number;
    sourceWorkId?:string;
    altText?:string;
    updatedAt:string;
  };
  status: CreatorCollectionStatus;
  visibility: PublicationVisibility;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  deletedAt?: string;
}

export interface CollectionWork {
  representationId?: string;
  collectionId: string;
  workId: string;
  position: number;
  addedAt: string;
}

export interface Publication {
  command?: Pick<import('./publication-commands.js').ManagedPublicationRecord,'account'|'preparationVersion'|'currentTargetKey'|'executionPolicy'|'remoteBinding'>;
  lastConfirmedImage?: Core.PublicationImageDeliveryEvidence;
  imageSelection?: Core.PublicationImageSelection<Readonly<Record<string,unknown>>>;
  configurationRevision?: number;
  unresolvedImageContext?: { sourceCollectionId: string };
  copy?: Core.PublicationCopyIdentity;
  activeOperationId?: string;
  revision?: number;
  publicationId: string;
  tenantId: TenantId;
  creatorId: string;
  workId: string;
  destination: PublicationDestination;
  integrationAccountId?: string;
  status: PublicationStatus;
  visibility: PublicationVisibility;
  remoteId?: string;
  remoteUrl?: string;
  remoteCreatedAt?: string;
  remoteUpdatedAt?: string;
  metadataOverrides?: {
    title?: string;
    description?: string;
    tags?: string[];
    fields?: Record<string, unknown>;
  };
  sync: {
    status: PublicationSyncStatus;
    lastAttemptAt?: string;
    lastSuccessfulAt?: string;
    localRevision?: number;
    remoteMetadataFingerprint?: string;
    remoteContentFingerprint?: string;
    remoteCursor?: string;
    remoteState?: 'active' | 'missing' | 'restricted' | 'unknown';
    retry?: { idempotencyKey: string; attempt: number; nextAttemptAt?: string; accountCooldownUntil?: string };
    errorCode?: string;
    errorMessage?: string;
    /** Provider-neutral reconciliation state; raw provider payloads never belong here. */
    reconciliation?: {
      baseline?: Record<string, unknown>;
      remote?: Record<string, unknown>;
      status: 'in_sync' | 'local_newer' | 'remote_newer' | 'non_conflicting_changes' | 'conflict';
      fields: Array<{
        field: string;
        lastSynced: unknown;
        local: unknown;
        remote: unknown;
        localChanged: boolean;
        remoteChanged: boolean;
        conflict: boolean;
      }>;
      updatedAt: string;
    };
  };
  providerData?: Record<string, unknown>;
  /** Immutable history. A new remote attempt appends; prior entries never change. */
  disclosureSnapshots?: readonly PublicationDisclosureSnapshot[];
  activeDisclosureSnapshotId?: string;
  createdAt: string;
  updatedAt: string;
  publishedAt?: string;
  removedAt?: string;
}

export interface PublicationIntent {
  gallerySelectionEditedAt?: string;
  galleryExternalCollectionIds?: string[];
  galleryFeature?: boolean;
  metadataGroupId?: string;
  metadataRevision?: string;
  metadataPolicy?: 'follow_standard' | 'custom';
  metadataOverrides?: { title?: string; description?: string };
  publicationId?: string;
  slotId?: string;
  publicationIntentId: string;
  tenantId: TenantId;
  creatorId: string;
  workId: string;
  destination: PublicationDestination;
  integrationAccountId?: string;
  enabled: boolean;
  desiredStatus: PublicationIntentStatus;
  scheduledAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkDiscoveryParticipation {
  workId: string;
  tenantId: TenantId;
  creatorId: string;
  state: DiscoveryParticipationState;
  optedInAt?: string;
  withdrawnAt?: string;
  removedAt?: string;
  removalReason?: string;
  updatedAt: string;
}

}

export interface RetainedCreatorContentModels {
 work:RetainedCreatorContent.Work;asset:RetainedCreatorContent.CanonicalAsset;attachment:RetainedCreatorContent.WorkAsset;
 publication:RetainedCreatorContent.Publication;intent:RetainedCreatorContent.PublicationIntent;collection:RetainedCreatorContent.CreatorCollection;
 collectionWork:RetainedCreatorContent.CollectionWork;discovery:RetainedCreatorContent.WorkDiscoveryParticipation;
}
