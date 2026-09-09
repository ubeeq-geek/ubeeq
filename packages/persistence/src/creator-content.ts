/** Minimum storage keys. Products extend records with their own metadata and policy fields. */
export interface CreatorContentRecords {
  work: { tenantId: string; creatorId: string; workId: string; status: string; updatedAt: string };
  asset: { tenantId: string; creatorId: string; assetId: string };
  attachment: { workId: string; assetId: string; position: number };
  publication: { tenantId: string; workId: string; publicationId: string; destination: string; updatedAt: string };
  intent: { tenantId: string; workId: string; publicationIntentId: string; updatedAt: string };
  collection: { tenantId: string; creatorId: string; collectionId: string; title: string; status: string };
  collectionWork: { collectionId: string; workId: string; position: number };
  discovery: { tenantId: string; workId: string };
}

/**
 * Compatibility port for existing creator-content records. It preserves stored IDs
 * during extraction; transport authorization and product admission remain explicit.
 * List methods currently materialize results; scalable adapters must provide the
 * complete result until callers adopt a separately versioned paginated contract.
 */
export interface CreatorContentStore<M extends CreatorContentRecords = CreatorContentRecords> {
  commitAssetAttachment(input: CreatorContentAssetCommit<M>): Promise<void>;
  listWorksByCreator(tenantId: string, creatorId: string, options?: { includeDeleted?: boolean }): Promise<M['work'][]>;
  getWork(tenantId: string, workId: string): Promise<M['work'] | null>;
  createWork(work: M['work']): Promise<void>;
  updateWork(work: M['work']): Promise<void>;
  commitWorkRevision(work: M['work'] & { revision: number }, expectedRevision: number): Promise<void>;

  listCanonicalAssetsByWork(tenantId: string, workId: string): Promise<Array<M['asset'] & { attachment: M['attachment'] }>>;
  /** Complete creator inventory, including detached/retained records; no authorization implied. */
  listCanonicalAssetsByCreator(tenantId: string, creatorId: string): Promise<M['asset'][]>;
  getCanonicalAsset(tenantId: string, assetId: string): Promise<M['asset'] | null>;
  createCanonicalAsset(asset: M['asset']): Promise<void>;
  updateCanonicalAsset(asset: M['asset']): Promise<void>;
  attachAssetToWork(tenantId: string, attachment: M['attachment']): Promise<void>;
  detachAssetFromWork(tenantId: string, workId: string, assetId: string): Promise<void>;

  listPublicationsByWork(tenantId: string, workId: string): Promise<M['publication'][]>;
  listPublicationsByDestination(tenantId: string, destination: M['publication']['destination']): Promise<M['publication'][]>;
  getPublication(tenantId: string, publicationId: string): Promise<M['publication'] | null>;
  upsertPublication(publication: M['publication']): Promise<void>;
  listPublicationIntentsByWork(tenantId: string, workId: string): Promise<M['intent'][]>;
  getPublicationIntent(tenantId: string, publicationIntentId: string): Promise<M['intent'] | null>;
  upsertPublicationIntent(intent: M['intent']): Promise<void>;
  deletePublicationIntent(tenantId: string, publicationIntentId: string): Promise<void>;

  listCreatorCollections(tenantId: string, creatorId: string, options?: { includeDeleted?: boolean }): Promise<M['collection'][]>;
  getCreatorCollection(tenantId: string, collectionId: string): Promise<M['collection'] | null>;
  createCreatorCollection(collection: M['collection']): Promise<void>;
  updateCreatorCollection(collection: M['collection']): Promise<void>;
  listCollectionWorks(tenantId: string, collectionId: string): Promise<M['collectionWork'][]>;
  replaceCollectionWorks(tenantId: string, collectionId: string, works: M['collectionWork'][]): Promise<void>;

  getWorkDiscoveryParticipation(tenantId: string, workId: string): Promise<M['discovery'] | null>;
  upsertWorkDiscoveryParticipation(participation: M['discovery']): Promise<void>;
}

export interface CreatorContentAssetCommit<M extends CreatorContentRecords> {
  previousRevision: number;
  work: M['work'] & { revision: number };
  asset: M['asset'];
  attachment: M['attachment'];
}
export class CreatorContentCommitError extends Error {
  readonly code = "revision_conflict";
}

/** Opaque consumer source identity; contains no provider credentials. */
export interface CreatorContentSourceReceipt {
  tenantId: string; creatorId: string; receiptId: string; sourceIdentity: string;
  workId: string; assetId: string; checksum: string;
}
export interface CreatorContentReuseCommit<M extends CreatorContentRecords> {
  previousRevision: number;
  work: M['work'] & { revision: number };
  sourceWorkId: string;
  /** The previously admitted asset snapshot; commit rejects changes to it. */
  expectedAsset: M['asset'];
  attachment: M['attachment'];
  receipt: CreatorContentSourceReceipt;
}
/** Separate capability: callers must not emulate this with independent writes. */
export interface CreatorContentSourceReuseStore<M extends CreatorContentRecords> {
  getSourceReceipt(tenantId: string, receiptId: string): Promise<CreatorContentSourceReceipt | null>;
  commitSourceReuse(input: CreatorContentReuseCommit<M>): Promise<void>;
}
