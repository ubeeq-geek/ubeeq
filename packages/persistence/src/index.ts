/** Provider-neutral durable persistence contracts. Provider implementations belong in adapter packages. */

export interface RevisionedRecord {
  id: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
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

export interface CreatorRecord extends RevisionedRecord { instanceId: string; handle: string; displayName: string; subjectId?: string; }
export interface WorkRecord extends RevisionedRecord { instanceId: string; creatorId: string; title: string; status: "draft" | "ready" | "published" | "archived" | "deleted"; }
export interface AssetRecord extends RevisionedRecord { instanceId: string; creatorId: string; workId?: string; mimeType: string; checksum: string; objectVersion: string; status: "pending" | "processing" | "ready" | "failed" | "deleted"; }
export interface CollectionRecord extends RevisionedRecord { instanceId: string; creatorId: string; title: string; visibility: "private" | "unlisted" | "public"; }
export interface WorkMembershipRecord extends RevisionedRecord { instanceId: string; collectionId: string; workId: string; position: number; }
export interface PublicationIntentRecord extends RevisionedRecord { instanceId: string; workId: string; destination: string; idempotencyKey: string; }
export interface PublicationRecord extends RevisionedRecord { instanceId: string; workId: string; destination: string; status: "draft" | "queued" | "live" | "removed" | "failed"; remoteId?: string; }
export interface ReconciliationSnapshotRecord extends RevisionedRecord { instanceId: string; publicationId: string; cursor?: string; snapshot: Readonly<Record<string, unknown>>; }
export interface ModerationEvidenceRecord extends RevisionedRecord { instanceId: string; subjectType: string; subjectId: string; source: string; payload: Readonly<Record<string, unknown>>; }
export interface ModerationHoldRecord extends RevisionedRecord { instanceId: string; subjectType: string; subjectId: string; state: "active" | "released"; reason?: string; }
export interface ReviewCaseRecord extends RevisionedRecord { instanceId: string; subjectId: string; state: "open" | "assigned" | "decided" | "closed"; assigneeId?: string; }
export interface AuditEventRecord extends RevisionedRecord { instanceId: string; action: string; actorId?: string; subjectId?: string; payload: Readonly<Record<string, unknown>>; }
export interface UsageEventRecord extends RevisionedRecord { instanceId: string; accountId: string; meter: string; quantity: number; idempotencyKey: string; }
export interface CreditLotRecord extends RevisionedRecord { instanceId: string; accountId: string; meter: string; remaining: number; expiresAt?: string; }
export interface CreditReservationRecord extends RevisionedRecord { instanceId: string; accountId: string; meter: string; quantity: number; state: "active" | "consumed" | "released"; }
export interface BalanceRecord extends RevisionedRecord { instanceId: string; accountId: string; meter: string; available: number; }
export interface IntegrationAccountRecord extends RevisionedRecord { instanceId: string; creatorId: string; connectorId: string; credentialReference?: string; health: "healthy" | "degraded" | "blocked" | "unknown"; }
export interface SyncCursorRecord extends RevisionedRecord { instanceId: string; integrationAccountId: string; operation: string; cursor?: string; }
export interface IntegrationJobRecord extends RevisionedRecord { instanceId: string; integrationAccountId: string; operation: string; state: "queued" | "running" | "completed" | "failed" | "cancelled"; }
export interface ExportManifestRecord extends RevisionedRecord { instanceId: string; creatorId: string; schemaVersion: string; checksum: string; objectReference: string; }
export interface ImportCheckpointRecord extends RevisionedRecord { instanceId: string; importId: string; state: "planned" | "running" | "completed" | "failed"; cursor?: string; }
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
