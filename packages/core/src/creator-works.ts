export interface CreatorWorkScope { tenantId: string; creatorId: string }

export interface CreatorWorkRecord extends CreatorWorkScope {
  workId: string;
  title: string;
  description?: string;
  tags: string[];
  slug: string;
  slugHistory: string[];
  status: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  deletedAt?: string;
}

export interface CreatorWorkPort<W extends CreatorWorkRecord> {
  listWorksByCreator(tenantId: string, creatorId: string): Promise<W[]>;
  getWork(tenantId: string, workId: string): Promise<W | null>;
  createWork(work: W): Promise<void>;
  updateWork(work: W): Promise<void>;
  /** Must reject a stale revision without changing stored state. No upsert fallback. */
  commitWorkRevision(work: W, expectedRevision: number): Promise<void>;
}

export class CreatorWorkError extends Error {
  constructor(public readonly code: "access_denied" | "not_found" | "slug_conflict" | "immutable_identity" | "revision_conflict", message: string) {
    super(message);
    this.name = "CreatorWorkError";
  }
}

/**
 * Creator-owned editing, independent of delivery, publication and discovery policy.
 * Bind authorization to the authenticated actor, never to client-supplied roles.
 * Revision commits require compare-and-swap. Slug checks still need an atomic
 * adapter guarantee; legacy callers of updateWork are outside this contract.
 */
export class CreatorWorkService<W extends CreatorWorkRecord> {
  constructor(
    private readonly store: CreatorWorkPort<W>,
    private readonly authorize: (scope: CreatorWorkScope) => Promise<boolean>,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  private async requireAccess(scope: CreatorWorkScope): Promise<void> {
    if (!await this.authorize({ tenantId: scope.tenantId, creatorId: scope.creatorId })) {
      throw new CreatorWorkError("access_denied", "Creator content access denied.");
    }
  }

  async get(tenantId: string, workId: string): Promise<W> {
    const work = await this.store.getWork(tenantId, workId);
    if (!work || work.tenantId !== tenantId || work.workId !== workId) {
      throw new CreatorWorkError("not_found", "Work not found");
    }
    await this.requireAccess(work);
    return work;
  }

  async list(scope: CreatorWorkScope, query = ""): Promise<W[]> {
    await this.requireAccess(scope);
    const normalizedQuery = query.trim().toLowerCase();
    return (await this.store.listWorksByCreator(scope.tenantId, scope.creatorId)).filter((work) =>
      work.tenantId === scope.tenantId && work.creatorId === scope.creatorId && work.status !== "deleted" &&
      (!normalizedQuery || [work.title, work.description || "", ...work.tags].some((value) => value.toLowerCase().includes(normalizedQuery))));
  }

  private async requireAvailableSlug(work: W, aliases: readonly string[] = [work.slug]): Promise<void> {
    const existing = await this.store.listWorksByCreator(work.tenantId, work.creatorId);
    const requested = new Set(aliases);
    if (existing.some((other) => other.workId !== work.workId && other.tenantId === work.tenantId &&
      other.creatorId === work.creatorId && other.status !== 'deleted' &&
      [other.slug, ...(other.slugHistory || [])].some(alias => requested.has(alias)))) {
      throw new CreatorWorkError("slug_conflict", "Work slug is already in use for this Creator.");
    }
  }

  async create(input: W): Promise<W> {
    await this.requireAccess(input);
    await this.requireAvailableSlug(input);
    const created = { ...input, status: "draft", revision: 1, slugHistory: [input.slug], archivedAt: undefined, deletedAt: undefined };
    await this.store.createWork(created);
    return created;
  }

  async revise(tenantId: string, workId: string, edit: (work: Readonly<W>, timestamp: string) => W): Promise<W> {
    const previous = await this.get(tenantId, workId);
    const timestamp = this.now();
    // Isolate the callback from reference adapters so rejected edits cannot mutate storage.
    const proposed = edit(structuredClone(previous), timestamp);
    if (proposed.tenantId !== previous.tenantId || proposed.creatorId !== previous.creatorId || proposed.workId !== previous.workId) {
      throw new CreatorWorkError("immutable_identity", "Work identity and ownership cannot be changed.");
    }
    const updated = {
      ...proposed,
      slugHistory: [...new Set([...(previous.slugHistory || []), previous.slug, proposed.slug])],
      revision: previous.revision + 1,
      createdAt: previous.createdAt,
      updatedAt: timestamp,
      archivedAt: proposed.status === "archived" ? timestamp : undefined,
      deletedAt: proposed.status === "deleted" ? timestamp : undefined
    };
    // Restoration reacquires all aliases, even when the current slug is unchanged
    // or the callback tries to discard history. Adapters must enforce this again
    // atomically with the revision commit to close concurrent reservation races.
    if (updated.status !== 'deleted' && (previous.status === 'deleted' || updated.slug !== previous.slug)) {
      await this.requireAvailableSlug(updated, previous.status === 'deleted' ? updated.slugHistory : [updated.slug]);
    }
    await this.store.commitWorkRevision(updated, previous.revision);
    return updated;
  }
}
