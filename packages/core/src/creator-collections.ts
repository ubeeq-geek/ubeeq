/** Storage-independent collection operations for compatibility records. */
export interface CreatorCollectionRecord {
  tenantId: string;
  creatorId: string;
  collectionId: string;
  slug: string;
  slugHistory: string[];
  status: string;
  updatedAt: string;
  revision?: number;
}

export interface CreatorCollectionScope { tenantId: string; creatorId: string }
export interface CreatorCollectionMembership {
  collectionId: string;
  workId: string;
  position: number;
  addedAt: string;
}

/** Structurally implemented by the creator-content persistence port. */
export interface CreatorCollectionPort<C extends CreatorCollectionRecord> {
  /** Set only when expected order is compared atomically with membership replacement. */
  readonly supportsExpectedCollectionOrder?: boolean;
  readonly supportsExpectedCollectionStatus?: boolean;
  readonly supportsExpectedCollectionRevision?: boolean;
  listCreatorCollections(tenantId: string, creatorId: string): Promise<C[]>;
  getCreatorCollection(tenantId: string, collectionId: string): Promise<C | null>;
  createCreatorCollection(collection: C): Promise<void>;
  updateCreatorCollection(collection: C, expectedStatus?: string, expectedRevision?: number): Promise<void>;
  listCollectionWorks(tenantId: string, collectionId: string): Promise<CreatorCollectionMembership[]>;
  replaceCollectionWorks(tenantId: string, collectionId: string, works: CreatorCollectionMembership[], expectedWorkIds?: readonly string[]): Promise<void>;
  getWork(tenantId: string, workId: string): Promise<{
    tenantId: string; creatorId: string; workId: string; status: string;
  } | null>;
}

export class CreatorCollectionError extends Error {
  constructor(public readonly code: "access_denied" | "not_found" | "slug_conflict" | "invalid_works" | "immutable_owner" | "revision_conflict", message: string) {
    super(message);
    this.name = "CreatorCollectionError";
  }
}

/**
 * Authorization is required for every operation, including reads. The caller binds
 * the policy callback to its authenticated actor; request input is not authority.
 * This compatibility service does not claim serializable slug reservation or
 * cross-record transactions. Adapters must address concurrent writers separately.
 */
export class CreatorCollectionService<C extends CreatorCollectionRecord> {
  constructor(
    private readonly store: CreatorCollectionPort<C>,
    private readonly authorize: (scope: CreatorCollectionScope) => Promise<boolean>,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  private async requireAccess(scope: CreatorCollectionScope): Promise<void> {
    if (!await this.authorize({ tenantId: scope.tenantId, creatorId: scope.creatorId })) {
      throw new CreatorCollectionError("access_denied", "Creator content access denied.");
    }
  }

  async get(tenantId: string, collectionId: string): Promise<C> {
    const collection = await this.store.getCreatorCollection(tenantId, collectionId);
    if (!collection || collection.tenantId !== tenantId || collection.collectionId !== collectionId) {
      throw new CreatorCollectionError("not_found", "Collection not found.");
    }
    await this.requireAccess(collection);
    return collection;
  }

  private async view(collection: C): Promise<C & { workIds: string[] }> {
    const memberships = await this.store.listCollectionWorks(collection.tenantId, collection.collectionId);
    return { ...collection, workIds: memberships.map(({ workId }) => workId) };
  }

  async list(scope: CreatorCollectionScope): Promise<Array<C & { workIds: string[] }>> {
    await this.requireAccess(scope);
    const collections = await this.store.listCreatorCollections(scope.tenantId, scope.creatorId);
    return Promise.all(collections.filter((collection) => collection.tenantId === scope.tenantId && collection.creatorId === scope.creatorId).map((collection) => this.view(collection)));
  }

  private async requireAvailableSlug(collection: C): Promise<void> {
    const existing = await this.store.listCreatorCollections(collection.tenantId, collection.creatorId);
    if (existing.some((other) => other.collectionId !== collection.collectionId &&
      (other.slug === collection.slug || other.slugHistory?.includes(collection.slug)))) {
      throw new CreatorCollectionError("slug_conflict", "Collection slug is already in use.");
    }
  }

  async create(collection: C): Promise<C & { workIds: string[] }> {
    await this.requireAccess(collection);
    await this.requireAvailableSlug(collection);
    const created = { ...collection, slugHistory: [...new Set([...collection.slugHistory, collection.slug])] };
    await this.store.createCreatorCollection(created);
    return { ...created, workIds: [] };
  }

  async update(collection: C, expectedStatus?: string, expectedRevision?: number): Promise<C & { workIds: string[] }> {
    this.requireRevisionSupport(expectedRevision);
    if (expectedStatus !== undefined && !this.store.supportsExpectedCollectionStatus) {
      throw new CreatorCollectionError('revision_conflict', 'Conditional collection lifecycle writes are unavailable in this adapter.');
    }
    const previous = await this.get(collection.tenantId, collection.collectionId);
    if (previous.creatorId !== collection.creatorId) {
      throw new CreatorCollectionError("immutable_owner", "Collection ownership cannot be changed.");
    }
    await this.requireAvailableSlug(collection);
    const updated = { ...collection, slugHistory: [...new Set([...(previous.slugHistory || []), previous.slug, collection.slug])] };
    await this.store.updateCreatorCollection(updated, expectedStatus, expectedRevision);
    return this.view(expectedRevision === undefined && this.store.supportsExpectedCollectionRevision
      ? await this.get(collection.tenantId, collection.collectionId)
      : expectedRevision === undefined ? updated : { ...updated, revision: expectedRevision + 1 });
  }

  private requireRevisionSupport(expectedRevision?: number): void {
    if (expectedRevision !== undefined && (!this.store.supportsExpectedCollectionRevision ||
      !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision >= Number.MAX_SAFE_INTEGER)) {
      throw new CreatorCollectionError('revision_conflict', 'A supported, valid collection revision is required.');
    }
  }

  async remove(tenantId: string, collectionId: string, expectedRevision?: number): Promise<void> {
    this.requireRevisionSupport(expectedRevision);
    const collection = await this.get(tenantId, collectionId);
    const now = this.now();
    await this.store.updateCreatorCollection({ ...collection, status: "deleted", deletedAt: now, updatedAt: now }, undefined, expectedRevision);
  }

  async replaceWorks(tenantId: string, collectionId: string, requestedWorkIds: readonly string[], expectedWorkIds?: readonly string[]): Promise<C & { workIds: string[] }> {
    const collection = await this.get(tenantId, collectionId);
    if (collection.status === "deleted") throw new CreatorCollectionError("not_found", "Collection not found.");
    if (expectedWorkIds !== undefined && !this.store.supportsExpectedCollectionOrder) throw new CreatorCollectionError('invalid_works', 'Conditional collection ordering is unavailable in this adapter.');
    const workIds = [...new Set(requestedWorkIds.map((id) => id.trim()).filter(Boolean))];
    const works = await Promise.all(workIds.map((workId) => this.store.getWork(tenantId, workId)));
    if (works.some((work, index) => !work || work.tenantId !== tenantId || work.workId !== workIds[index] ||
      work.creatorId !== collection.creatorId || work.status === "deleted")) {
      throw new CreatorCollectionError("invalid_works", "Choose Works owned by this Creator.");
    }
    const addedAt = this.now();
    await this.store.replaceCollectionWorks(tenantId, collectionId,
      workIds.map((workId, position) => ({ collectionId, workId, position, addedAt })), expectedWorkIds);
    return { ...collection, workIds };
  }
}
