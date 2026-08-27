/** Provider-neutral durable persistence contracts. Provider implementations belong in adapter packages. */

export interface RevisionedRecord {
  id: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

/** Stored on every creator-owned record so repositories can enforce cell locality. */
export interface CellOwnedRecord { homeCellId: string; dataHomeRegion: string; dataHomeAssignedAt: string; routingRevision: number; }

export class CellOwnershipError extends Error {
  constructor(readonly expectedCellId: string, readonly actualCellId?: string) {
    super(`Record belongs to cell ${actualCellId ?? "<missing>"}; expected ${expectedCellId}.`);
    this.name = "CellOwnershipError";
  }
}

export interface PageRequest { cursor?: string; limit: number; }
export interface Page<T> { items: readonly T[]; nextCursor?: string; }
export interface UniqueConstraint { name: string; values: Readonly<Record<string, string>>; }

export class OptimisticConcurrencyError extends Error {
  constructor(readonly id: string, readonly expectedRevision: number) {
    super(`Record ${id} no longer has revision ${expectedRevision}.`);
    this.name = "OptimisticConcurrencyError";
  }
}

export class UniqueConstraintError extends Error {
  constructor(readonly constraint: UniqueConstraint) {
    super(`Unique constraint ${constraint.name} was violated.`);
    this.name = "UniqueConstraintError";
  }
}

/** A transaction is atomic: all writes commit together or none commit. */
export interface PersistenceTransaction {
  readonly id: string;
}

export interface TransactionRunner {
  transaction<T>(operation: (transaction: PersistenceTransaction) => Promise<T>): Promise<T>;
}

/**
 * All durable repositories retain idempotency keys for at least the adapter's documented retention period.
 * Updates must reject stale revisions with OptimisticConcurrencyError.
 */
export interface RevisionedRepository<T extends RevisionedRecord> {
  create(record: Omit<T, "revision" | "createdAt" | "updatedAt">, options?: { transaction?: PersistenceTransaction; idempotencyKey?: string }): Promise<T>;
  get(id: string, options?: { transaction?: PersistenceTransaction }): Promise<T | undefined>;
  list(request: PageRequest, options?: { transaction?: PersistenceTransaction }): Promise<Page<T>>;
  update(id: string, expectedRevision: number, change: Partial<Omit<T, "id" | "revision" | "createdAt" | "updatedAt">>, options?: { transaction?: PersistenceTransaction; idempotencyKey?: string }): Promise<T>;
  remove(id: string, expectedRevision: number, options?: { transaction?: PersistenceTransaction; idempotencyKey?: string }): Promise<void>;
}

const DATA_HOME_FIELDS = ["homeCellId", "dataHomeRegion", "dataHomeAssignedAt", "routingRevision"] as const;

/** Provider-neutral fail-closed boundary for canonical creator-owned repositories. */
export class CellScopedRepository<T extends RevisionedRecord & CellOwnedRecord> implements RevisionedRepository<T> {
  constructor(readonly repository: RevisionedRepository<T>, readonly cellId: string) {
    if (!cellId.trim()) throw new Error("A cell-scoped repository requires a cellId.");
  }
  private local(record: T | undefined): T | undefined {
    return record?.homeCellId === this.cellId ? record : undefined;
  }
  async create(record: Omit<T, "revision" | "createdAt" | "updatedAt">, options?: Parameters<RevisionedRepository<T>["create"]>[1]): Promise<T> {
    if (record.homeCellId !== this.cellId) throw new CellOwnershipError(this.cellId, record.homeCellId);
    return this.repository.create(record, options);
  }
  async get(id: string, options?: Parameters<RevisionedRepository<T>["get"]>[1]): Promise<T | undefined> {
    return this.local(await this.repository.get(id, options));
  }
  async list(request: PageRequest, options?: Parameters<RevisionedRepository<T>["list"]>[1]): Promise<Page<T>> {
    const limit = Math.max(1, request.limit); const items: T[] = []; let cursor = request.cursor;
    do {
      const page = await this.repository.list({ cursor, limit: 1 }, options);
      const record = page.items[0]; if (record?.homeCellId === this.cellId) items.push(record);
      cursor = page.nextCursor;
      if (!cursor || items.length >= limit) return { items, nextCursor: cursor };
    } while (cursor);
    return { items };
  }
  async update(id: string, expectedRevision: number, change: Partial<Omit<T, "id" | "revision" | "createdAt" | "updatedAt">>, options?: Parameters<RevisionedRepository<T>["update"]>[3]): Promise<T> {
    const current = await this.repository.get(id, options);
    if (!current || current.homeCellId !== this.cellId) throw new CellOwnershipError(this.cellId, current?.homeCellId);
    for (const field of DATA_HOME_FIELDS) if (field in change && change[field] !== current[field]) throw new Error(`Data-home field ${field} is immutable outside migration.`);
    return this.repository.update(id, expectedRevision, change, options);
  }
  async remove(id: string, expectedRevision: number, options?: Parameters<RevisionedRepository<T>["remove"]>[2]): Promise<void> {
    const current = await this.repository.get(id, options);
    if (!current || current.homeCellId !== this.cellId) throw new CellOwnershipError(this.cellId, current?.homeCellId);
    return this.repository.remove(id, expectedRevision, options);
  }
}

export interface CreatorRecord extends RevisionedRecord, CellOwnedRecord { instanceId: string; handle: string; displayName: string; subjectId?: string; }
export interface WorkRecord extends RevisionedRecord, CellOwnedRecord { instanceId: string; creatorId: string; title: string; status: "draft" | "ready" | "published" | "archived" | "deleted"; }
export interface AssetRecord extends RevisionedRecord, CellOwnedRecord { instanceId: string; creatorId: string; workId?: string; mimeType: string; checksum: string; objectVersion: string; status: "pending" | "processing" | "ready" | "failed" | "deleted"; }
export interface CollectionRecord extends RevisionedRecord, CellOwnedRecord { instanceId: string; creatorId: string; title: string; visibility: "private" | "unlisted" | "public"; }
export interface WorkMembershipRecord extends RevisionedRecord, CellOwnedRecord { instanceId: string; collectionId: string; workId: string; position: number; }
export interface PublicationIntentRecord extends RevisionedRecord, CellOwnedRecord { instanceId: string; workId: string; destination: string; idempotencyKey: string; }
export interface PublicationRecord extends RevisionedRecord, CellOwnedRecord { instanceId: string; workId: string; destination: string; status: "draft" | "queued" | "live" | "removed" | "failed"; remoteId?: string; }
export interface ReconciliationSnapshotRecord extends RevisionedRecord, CellOwnedRecord { instanceId: string; publicationId: string; cursor?: string; snapshot: Readonly<Record<string, unknown>>; }
export interface ModerationEvidenceRecord extends RevisionedRecord, CellOwnedRecord { instanceId: string; subjectType: string; subjectId: string; source: string; payload: Readonly<Record<string, unknown>>; }
export interface ModerationHoldRecord extends RevisionedRecord, CellOwnedRecord { instanceId: string; subjectType: string; subjectId: string; state: "active" | "released"; reason?: string; }
export interface ReviewCaseRecord extends RevisionedRecord, CellOwnedRecord { instanceId: string; subjectId: string; state: "open" | "assigned" | "decided" | "closed"; assigneeId?: string; }
export interface AuditEventRecord extends RevisionedRecord, CellOwnedRecord { instanceId: string; action: string; actorId?: string; subjectId?: string; payload: Readonly<Record<string, unknown>>; }
export interface UsageEventRecord extends RevisionedRecord, CellOwnedRecord { instanceId: string; accountId: string; meter: string; quantity: number; idempotencyKey: string; }
export interface CreditLotRecord extends RevisionedRecord, CellOwnedRecord { instanceId: string; accountId: string; meter: string; remaining: number; expiresAt?: string; }
export interface CreditReservationRecord extends RevisionedRecord, CellOwnedRecord { instanceId: string; accountId: string; meter: string; quantity: number; state: "active" | "consumed" | "released"; }
export interface BalanceRecord extends RevisionedRecord, CellOwnedRecord { instanceId: string; accountId: string; meter: string; available: number; }
export interface IntegrationAccountRecord extends RevisionedRecord, CellOwnedRecord { instanceId: string; creatorId: string; connectorId: string; credentialReference?: string; health: "healthy" | "degraded" | "blocked" | "unknown"; }
export interface SyncCursorRecord extends RevisionedRecord, CellOwnedRecord { instanceId: string; integrationAccountId: string; operation: string; cursor?: string; }
export interface IntegrationJobRecord extends RevisionedRecord, CellOwnedRecord { instanceId: string; integrationAccountId: string; operation: string; state: "queued" | "running" | "completed" | "failed" | "cancelled"; }
export interface ExportManifestRecord extends RevisionedRecord, CellOwnedRecord { instanceId: string; creatorId: string; schemaVersion: string; checksum: string; objectReference: string; }
export interface ImportCheckpointRecord extends RevisionedRecord, CellOwnedRecord { instanceId: string; creatorId: string; importId: string; state: "planned" | "running" | "completed" | "failed"; cursor?: string; }
export interface FederationActorRecord extends RevisionedRecord { instanceId: string; actorUri: string; host: string; publicKey?: string; }
export interface RemotePublicationReferenceRecord extends RevisionedRecord { instanceId: string; actorId: string; publicationUri: string; immutableId: string; state: "accepted" | "withdrawn" | "rejected"; }

export interface UbeeqRepositories extends TransactionRunner {
  creators: RevisionedRepository<CreatorRecord>;
  works: RevisionedRepository<WorkRecord>;
  assets: RevisionedRepository<AssetRecord>;
  collections: RevisionedRepository<CollectionRecord>;
  workMemberships: RevisionedRepository<WorkMembershipRecord>;
  publicationIntents: RevisionedRepository<PublicationIntentRecord>;
  publications: RevisionedRepository<PublicationRecord>;
  reconciliationSnapshots: RevisionedRepository<ReconciliationSnapshotRecord>;
  moderationEvidence: RevisionedRepository<ModerationEvidenceRecord>;
  moderationHolds: RevisionedRepository<ModerationHoldRecord>;
  reviewCases: RevisionedRepository<ReviewCaseRecord>;
  auditEvents: RevisionedRepository<AuditEventRecord>;
  usageEvents: RevisionedRepository<UsageEventRecord>;
  creditLots: RevisionedRepository<CreditLotRecord>;
  creditReservations: RevisionedRepository<CreditReservationRecord>;
  balances: RevisionedRepository<BalanceRecord>;
  integrationAccounts: RevisionedRepository<IntegrationAccountRecord>;
  syncCursors: RevisionedRepository<SyncCursorRecord>;
  integrationJobs: RevisionedRepository<IntegrationJobRecord>;
  exportManifests: RevisionedRepository<ExportManifestRecord>;
  importCheckpoints: RevisionedRepository<ImportCheckpointRecord>;
  federationActors: RevisionedRepository<FederationActorRecord>;
  remotePublicationReferences: RevisionedRepository<RemotePublicationReferenceRecord>;
}

/** Executable shared fixture for every adapter's revisioned repository implementation. */
export interface RevisionedRepositoryContractHarness<T extends RevisionedRecord> {
  repository: RevisionedRepository<T>;
  createRecord(id: string): Omit<T, "revision" | "createdAt" | "updatedAt">;
  change(record: T): Partial<Omit<T, "id" | "revision" | "createdAt" | "updatedAt">>;
}

export const verifyRevisionedRepositoryContract = async <T extends RevisionedRecord>(harness: RevisionedRepositoryContractHarness<T>): Promise<void> => {
  const created = await harness.repository.create(harness.createRecord("contract-record"), { idempotencyKey: "create-contract-record" });
  if (created.revision !== 1) throw new Error("Repository contract violation: create must begin at revision 1.");
  const repeated = await harness.repository.create(harness.createRecord("contract-record"), { idempotencyKey: "create-contract-record" });
  if (repeated.id !== created.id || repeated.revision !== created.revision) throw new Error("Repository contract violation: create idempotency key was not retained.");
  const page = await harness.repository.list({ limit: 1 });
  if (!page.items.some((item) => item.id === created.id)) throw new Error("Repository contract violation: created record is not listable.");
  const updated = await harness.repository.update(created.id, created.revision, harness.change(created), { idempotencyKey: "update-contract-record" });
  if (updated.revision !== created.revision + 1) throw new Error("Repository contract violation: update must advance revision.");
  let rejectedStaleWrite = false;
  try { await harness.repository.update(created.id, created.revision, harness.change(updated)); }
  catch (error) { rejectedStaleWrite = error instanceof OptimisticConcurrencyError; }
  if (!rejectedStaleWrite) throw new Error("Repository contract violation: stale update was not rejected.");
  await harness.repository.remove(updated.id, updated.revision, { idempotencyKey: "delete-contract-record" });
  if (await harness.repository.get(updated.id)) throw new Error("Repository contract violation: deleted record remains readable.");
};

export const verifyCellScopedRepositoryContract = async (harness: { repository: RevisionedRepository<RevisionedRecord & CellOwnedRecord>; unscopedRepository: RevisionedRepository<RevisionedRecord & CellOwnedRecord>; cellId: string }): Promise<void> => {
  const { repository, unscopedRepository, cellId } = harness;
  const assignedAt = "2026-01-01T00:00:00.000Z";
  const record = (id: string, homeCellId = cellId) => ({ id, homeCellId, dataHomeRegion: "test-region", dataHomeAssignedAt: assignedAt, routingRevision: 1, contractValue: id });
  const local = await repository.create(record("cell-contract-local"));
  let rejectedCreate = false; try { await repository.create(record("cell-contract-foreign", "foreign-cell")); } catch (error) { rejectedCreate = error instanceof CellOwnershipError; }
  if (!rejectedCreate) throw new Error("Cell repository contract violation: foreign create was accepted.");
  const foreign = await unscopedRepository.create(record("cell-contract-between", "foreign-cell"));
  await repository.create(record("cell-contract-later"));
  if (await repository.get(foreign.id)) throw new Error("Cell repository contract violation: get exposed a foreign record.");
  const first = await repository.list({ limit: 1 }); const second = await repository.list({ limit: 1, cursor: first.nextCursor });
  if (first.items.length !== 1 || second.items.length !== 1 || first.items[0].homeCellId !== cellId || second.items[0].homeCellId !== cellId || first.items[0].id === second.items[0].id) throw new Error("Cell repository contract violation: pagination did not skip foreign records safely.");
  for (const [field, value] of [["homeCellId", "foreign-cell"], ["dataHomeRegion", "other-region"], ["dataHomeAssignedAt", "2027-01-01T00:00:00.000Z"], ["routingRevision", 2]] as const) {
    let rejectedMove = false; try { await repository.update(local.id, local.revision, { [field]: value }); } catch { rejectedMove = true; }
    if (!rejectedMove) throw new Error(`Cell repository contract violation: ${field} was mutable.`);
  }
  for (const operation of [() => repository.update(foreign.id, foreign.revision, {}), () => repository.remove(foreign.id, foreign.revision)]) {
    let rejected = false; try { await operation(); } catch (error) { rejected = error instanceof CellOwnershipError; }
    if (!rejected) throw new Error("Cell repository contract violation: foreign mutation was accepted.");
  }
};
