import type {
  AssetKind, AssetStatus, CollectionStatus, CollectionType, ContentMetadataDefaults,
  ContentMetadataValues, ContentPreparationSettings, CreatorWorkPort, CreatorWorkRecord,
  PublicationVisibility, StoredPostBlock, WorkAssetRole, WorkKind, WorkOriginType, WorkStatus
} from '@ubeeq/core';

/** Compatibility records are views of the host's authoritative rows, not a second store. */
export interface PreparationWork extends CreatorWorkRecord {
  kind: WorkKind;
  status: WorkStatus;
  body?: StoredPostBlock[];
  contentRating: 'general' | 'suggestive' | 'mature' | 'sexual' | 'fetish' | 'graphic';
  aiDisclosure: 'none' | 'ai-assisted' | 'ai-generated';
  heavyTopics: Array<'politics-public-affairs' | 'crime-disasters-tragedy'>;
  origin: { type: WorkOriginType };
  primaryAssetId?: string;
  contentPreparationMetadata?: { workflowId: string; fingerprint: string };
}
export interface PreparationAsset {
  assetId: string; tenantId: string; creatorId: string; kind: AssetKind; status: AssetStatus;
  mimeType: string; originalFilename?: string; sizeBytes?: number; checksumSha256?: string;
  storage: { mode: 'hosted' | 'external'; objectKey?: string; thumbnailObjectKey?: string; externalUrl?: string };
  metadata?: Record<string, string | number | boolean | null>;
  createdAt: string; updatedAt: string; replacedByAssetId?: string; deletedAt?: string;
}
export interface PreparationAttachment {
  workId: string; assetId: string; role: WorkAssetRole; position: number;
  caption?: string; altText?: string; replacedByAssetId?: string;
}
export interface PreparationCollection {
  collectionId: string; tenantId: string; creatorId: string; type: CollectionType;
  title: string; slug: string; slugHistory: string[]; description?: string;
  category?: 'free_preview' | 'followers_only' | 'premium';
  coverAssetId?: string; status: CollectionStatus; visibility: PublicationVisibility;
  revision?: number; volumeIds?: string[]; managementState?: 'draft' | 'active' | 'archived';
  createdAt: string; updatedAt: string; archivedAt?: string; deletedAt?: string;
}
export interface PreparationCollectionMember {
  collectionId: string; workId: string; position: number; addedAt: string; representationId?: string;
}
export interface PreparationSourceFile {
  fileId: string; creatorId: string;
  sourceKind: 'image' | 'video' | 'audio' | 'document' | 'archive' | 'other';
  mimeType: string; storageKey: string; originalFilename?: string; sizeBytes?: number;
  checksumSha256?: string; metadata?: Record<string, string | number | boolean | null>;
  uploadState?: 'pending' | 'ready' | 'cancelled'; restricted?: boolean;
  createdAt: string; updatedAt: string;
}
export interface PreparationCreator { creatorId: string; status: string; deletion?: unknown }
export interface PreparationOrganizationState { revision: number }

/** run() must join canonical writes, receipts and authorization/source read guards
 * in one durable conditional transaction. A process-local mutex is insufficient.
 * Stored JSON belongs to this authority and is decoded by the workflow domain.
 */
export interface PreparationAtomic {
  readonly supportsConditionalTransactions?: boolean;
  run<T>(operation: (transaction: { id: string }) => Promise<T>): Promise<T>;
  get(kind: string, id: string): Promise<any>;
  list(kind: string): Promise<any[]>;
  put(kind: string, id: string, value: unknown): Promise<void>;
}
export interface ContentPreparationStore<S extends PreparationOrganizationState> extends CreatorWorkPort<PreparationWork> {
  readonly publicationAtomic?: PreparationAtomic;
  getCreatorById(creatorId: string): Promise<PreparationCreator | null>;
  listCreators(): Promise<PreparationCreator[]>;
  getWorkDiscoveryParticipation(tenantId: string, workId: string): Promise<{ state: string } | null>;
  getAnnouncementOrchestration<T>(scope: { tenantId: string; creatorId: string }, kind: string, id: string): Promise<{ value: T } | null>;
  getSourceFileById?(fileId: string): Promise<PreparationSourceFile | null>;
  getCanonicalAsset(tenantId: string, assetId: string): Promise<PreparationAsset | null>;
  listCanonicalAssetsByWork(tenantId: string, workId: string): Promise<Array<PreparationAsset & { attachment: PreparationAttachment }>>;
  createCanonicalAsset(asset: PreparationAsset): Promise<void>;
  attachAssetToWork(tenantId: string, attachment: PreparationAttachment): Promise<void>;
  detachAssetFromWork(tenantId: string, workId: string, assetId: string): Promise<void>;
  commitAssetAttachment(input: { previousRevision: number; work: PreparationWork; asset: PreparationAsset; attachment: PreparationAttachment }): Promise<void>;
  getCreatorCollection(tenantId: string, collectionId: string): Promise<PreparationCollection | null>;
  listCreatorCollections(tenantId: string, creatorId: string): Promise<PreparationCollection[]>;
  listCollectionWorks(tenantId: string, collectionId: string): Promise<PreparationCollectionMember[]>;
  getCollectionOrganization(tenantId: string, creatorId: string): Promise<S>;
  commitCollectionOrganization(input: {
    tenantId: string; creatorId: string; expectedRevision: number; state: S;
    collection: PreparationCollection & { revision: number }; expectedCollectionRevision: number;
    members?: PreparationCollectionMember[];
  }): Promise<void>;
}
export interface PreparationSetup {
  profile: {
    shared: ContentMetadataValues;
    overrides: Array<ContentMetadataDefaults['overrides'][number] & { publicationId?: string }>;
  };
  publicationSettings?: Array<{ destination: string; accountId?: string; galleries: string[]; values: ContentMetadataValues }>;
}

/** Mandatory host capabilities retain storage/model-specific behavior. Bind them
 * to the same scoped authority as store; never add silent no-op implementations.
 */
export interface ContentPreparationAuthorization {
  authorizeCreator(creatorId: string): Promise<boolean>;
  canManageCollections(creatorId: string): Promise<boolean>;
}
export interface ContentPreparationHost extends ContentPreparationAuthorization {
  /** Return live actor-bound checks, not a permission snapshot. Each accepting
   * child command invokes them inside the store's conditional transaction. */
  recoveryAuthorization(actorId: string): ContentPreparationAuthorization;
  /** Return fresh, serializable product defaults, stable for this host instance. */
  defaultSettings(): ContentPreparationSettings;
  inspectOriginal(file: PreparationSourceFile): Promise<string>;
  captureSetup(work: PreparationWork): Promise<PreparationSetup>;
  contentMetadataWork(work: PreparationWork, metadata: ContentMetadataDefaults): Promise<PreparationWork>;
  validateCollectionVolumes(collections: PreparationCollection[], updated: PreparationCollection): void;
  resolvedCollectionMembers(tenantId: string, collection: PreparationCollection): Promise<PreparationCollectionMember[]>;
  recordImageCompatibility(work: PreparationWork, asset: PreparationAsset, actorId: string): Promise<void>;
}
