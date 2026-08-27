import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AuthenticatedSession, IdentityAccount, IdentityAdapter } from "@ubeeq/auth";
import type { DurableJob, JobLease, JobQueue, Scheduler } from "@ubeeq/jobs";
import type { CredentialVault } from "@ubeeq/integrations";
import { OptimisticConcurrencyError, type Page, type PageRequest, type PersistenceTransaction, type RevisionedRecord, type RevisionedRepository, type UbeeqRepositories } from "@ubeeq/persistence";
import type { DeliveryAdapter, ObjectStorage, StoredObject, UploadAdapter, UploadCompletion, UploadInitiation } from "@ubeeq/storage";

const now = (): string => new Date().toISOString();
const json = <T>(value: T): string => JSON.stringify(value);
const parse = <T>(value: string): T => JSON.parse(value) as T;
const digest = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");
type SqliteDatabase = { exec(sql: string): void; prepare(sql: string): { get(...parameters: unknown[]): unknown; all(...parameters: unknown[]): unknown; run(...parameters: unknown[]): { changes: number } }; };

export interface LocalAdapterConfiguration { databasePath: string; dataDirectory: string; publicBaseUrl: string; sessionTtlSeconds?: number; credentialEncryptionKey?: string; }

export class LocalSqliteDatabase {
  readonly database: SqliteDatabase;
  private transactionDepth = 0;

  constructor(readonly configuration: LocalAdapterConfiguration) {
    mkdirSync(resolve(configuration.dataDirectory), { recursive: true });
    mkdirSync(resolve(configuration.databasePath, ".."), { recursive: true });
    this.database = new DatabaseSync(configuration.databasePath) as SqliteDatabase;
    this.database.exec("CREATE TABLE IF NOT EXISTS ubeeq_schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
    for (const id of ["001-initial", "002-credential-vault"]) {
      const applied = this.database.prepare("SELECT id FROM ubeeq_schema_migrations WHERE id = ?").get(id) as { id?: string } | undefined;
      if (!applied?.id) { this.database.exec(readFileSync(join(__dirname, "migrations", `${id}.sql`), "utf8")); this.database.prepare("INSERT INTO ubeeq_schema_migrations (id, applied_at) VALUES (?, ?)").run(id, now()); }
    }
  }

  async transaction<T>(operation: (transaction: PersistenceTransaction) => Promise<T>): Promise<T> {
    const root = this.transactionDepth === 0;
    if (root) this.database.exec("BEGIN IMMEDIATE");
    this.transactionDepth += 1;
    try {
      const result = await operation({ id: `sqlite-${this.transactionDepth}` });
      if (root) this.database.exec("COMMIT");
      return result;
    } catch (error) {
      if (root) this.database.exec("ROLLBACK");
      throw error;
    } finally { this.transactionDepth -= 1; }
  }
}

class SqliteRevisionedRepository<T extends RevisionedRecord> implements RevisionedRepository<T> {
  constructor(private readonly local: LocalSqliteDatabase, private readonly repository: string) {}

  async create(record: Omit<T, "revision" | "createdAt" | "updatedAt">, options?: { idempotencyKey?: string }): Promise<T> {
    if (options?.idempotencyKey) {
      const existing = this.local.database.prepare("SELECT record_id FROM ubeeq_idempotency WHERE repository = ? AND idempotency_key = ?").get(this.repository, options.idempotencyKey) as { record_id?: string } | undefined;
      if (existing?.record_id) return (await this.get(existing.record_id))!;
    }
    const existing = await this.get(record.id);
    if (existing) throw new Error(`Record ${record.id} already exists.`);
    const timestamp = now();
    const value = { ...record, revision: 1, createdAt: timestamp, updatedAt: timestamp } as T;
    this.local.database.prepare("INSERT INTO ubeeq_records (repository, id, revision, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(this.repository, value.id, value.revision, json(value), timestamp, timestamp);
    if (options?.idempotencyKey) this.local.database.prepare("INSERT INTO ubeeq_idempotency (repository, idempotency_key, record_id, created_at) VALUES (?, ?, ?, ?)").run(this.repository, options.idempotencyKey, value.id, timestamp);
    return value;
  }

  async get(id: string): Promise<T | undefined> {
    const row = this.local.database.prepare("SELECT payload FROM ubeeq_records WHERE repository = ? AND id = ?").get(this.repository, id) as { payload?: string } | undefined;
    return row?.payload ? parse<T>(row.payload) : undefined;
  }

  async list(request: PageRequest): Promise<Page<T>> {
    const limit = Math.max(1, Math.min(100, request.limit));
    const after = request.cursor ? Buffer.from(request.cursor, "base64url").toString("utf8") : "";
    const rows = this.local.database.prepare("SELECT payload, id FROM ubeeq_records WHERE repository = ? AND id > ? ORDER BY id LIMIT ?").all(this.repository, after, limit + 1) as Array<{ payload: string; id: string }>;
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(({ payload }) => parse<T>(payload));
    return { items, nextCursor: hasMore ? Buffer.from(items.at(-1)!.id).toString("base64url") : undefined };
  }

  async update(id: string, expectedRevision: number, change: Partial<Omit<T, "id" | "revision" | "createdAt" | "updatedAt">>): Promise<T> {
    const current = await this.get(id);
    if (!current || current.revision !== expectedRevision) throw new OptimisticConcurrencyError(id, expectedRevision);
    const value = { ...current, ...change, revision: current.revision + 1, updatedAt: now() } as T;
    const result = this.local.database.prepare("UPDATE ubeeq_records SET revision = ?, payload = ?, updated_at = ? WHERE repository = ? AND id = ? AND revision = ?").run(value.revision, json(value), value.updatedAt, this.repository, id, expectedRevision);
    if (result.changes !== 1) throw new OptimisticConcurrencyError(id, expectedRevision);
    return value;
  }

  async remove(id: string, expectedRevision: number): Promise<void> {
    const result = this.local.database.prepare("DELETE FROM ubeeq_records WHERE repository = ? AND id = ? AND revision = ?").run(this.repository, id, expectedRevision);
    if (result.changes !== 1) throw new OptimisticConcurrencyError(id, expectedRevision);
  }
}

const repository = <T extends RevisionedRecord>(local: LocalSqliteDatabase, name: string): RevisionedRepository<T> => new SqliteRevisionedRepository<T>(local, name);

/** Durable local composition. It is intentionally a generic JSON-record adapter, not an in-memory default. */
export const createLocalRepositories = (local: LocalSqliteDatabase): UbeeqRepositories => ({
  transaction: local.transaction.bind(local),
  creators: repository(local, "creators"), works: repository(local, "works"), assets: repository(local, "assets"), collections: repository(local, "collections"), workMemberships: repository(local, "workMemberships"),
  publicationIntents: repository(local, "publicationIntents"), publications: repository(local, "publications"), reconciliationSnapshots: repository(local, "reconciliationSnapshots"),
  moderationEvidence: repository(local, "moderationEvidence"), moderationHolds: repository(local, "moderationHolds"), reviewCases: repository(local, "reviewCases"), auditEvents: repository(local, "auditEvents"),
  usageEvents: repository(local, "usageEvents"), creditLots: repository(local, "creditLots"), creditReservations: repository(local, "creditReservations"), balances: repository(local, "balances"),
  integrationAccounts: repository(local, "integrationAccounts"), syncCursors: repository(local, "syncCursors"), integrationJobs: repository(local, "integrationJobs"), exportManifests: repository(local, "exportManifests"), importCheckpoints: repository(local, "importCheckpoints"), federationActors: repository(local, "federationActors"), remotePublicationReferences: repository(local, "remotePublicationReferences")
});

export class LocalFilesystemStorage implements ObjectStorage, UploadAdapter, DeliveryAdapter {
  constructor(private readonly local: LocalSqliteDatabase) {}
  private objectPath(object: Pick<StoredObject, "bucket" | "key" | "versionId">): string {
    const root = resolve(this.local.configuration.dataDirectory, "objects", object.bucket);
    const path = resolve(root, object.key, object.versionId ?? "current");
    if (relative(root, path).startsWith("..")) throw new Error("Object key escapes local storage root.");
    return path;
  }
  async put(input: { object: StoredObject; body: Uint8Array }): Promise<void> {
    const path = this.objectPath(input.object); mkdirSync(resolve(path, ".."), { recursive: true }); writeFileSync(path, input.body); writeFileSync(`${path}.json`, json(input.object));
  }
  async get(input: Pick<StoredObject, "bucket" | "key" | "versionId">): Promise<{ object: StoredObject; body: Uint8Array }> {
    const path = this.objectPath(input); return { object: parse<StoredObject>(readFileSync(`${path}.json`, "utf8")), body: readFileSync(path) };
  }
  async remove(input: Pick<StoredObject, "bucket" | "key" | "versionId">): Promise<void> { const path = this.objectPath(input); rmSync(path, { force: true }); rmSync(`${path}.json`, { force: true }); }
  async initiate(input: { object: StoredObject; checksumAlgorithm: "sha256"; multipart?: boolean; expiresAt: string }): Promise<UploadInitiation> {
    const uploadId = randomUUID(); this.local.database.prepare("INSERT INTO ubeeq_uploads (id, object_payload, created_at) VALUES (?, ?, ?)").run(uploadId, json(input.object), now());
    return { uploadId, object: input.object, completeUrl: `${this.local.configuration.publicBaseUrl.replace(/\/$/, "")}/v1/uploads/${uploadId}/complete`, expiresAt: input.expiresAt };
  }
  async acceptUpload(uploadId: string, body: Uint8Array): Promise<void> { const result = this.local.database.prepare("UPDATE ubeeq_uploads SET body = ? WHERE id = ?").run(body, uploadId); if (result.changes !== 1) throw new Error("Unknown upload."); }
  async complete(input: UploadCompletion): Promise<StoredObject> {
    const row = this.local.database.prepare("SELECT object_payload, body FROM ubeeq_uploads WHERE id = ?").get(input.uploadId) as { object_payload?: string; body?: Uint8Array } | undefined;
    if (!row?.object_payload || !row.body) throw new Error("Upload content has not been received.");
    if (row.body.byteLength !== input.byteLength || digest(row.body) !== input.checksum) throw new Error("Upload checksum or length does not match.");
    const object = { ...parse<StoredObject>(row.object_payload), checksum: input.checksum, byteLength: input.byteLength, versionId: randomUUID() };
    await this.put({ object, body: row.body }); this.local.database.prepare("DELETE FROM ubeeq_uploads WHERE id = ?").run(input.uploadId); return object;
  }
  async issue(request: { object: Pick<StoredObject, "bucket" | "key" | "versionId" | "scope">; expiresAt: string }): Promise<{ url: string; expiresAt: string }> {
    const encoded = Buffer.from(json(request.object)).toString("base64url"); return { url: `${this.local.configuration.publicBaseUrl.replace(/\/$/, "")}/v1/delivery/${encoded}`, expiresAt: request.expiresAt };
  }
}

export class LocalIdentityAdapter implements IdentityAdapter {
  constructor(private readonly local: LocalSqliteDatabase) {}
  async register(input: { email: string; password: string }): Promise<IdentityAccount> {
    if (!/^\S+@\S+\.\S+$/.test(input.email) || input.password.length < 12) throw new Error("Local accounts require a valid email and a password of at least 12 characters.");
    const id = randomUUID(), timestamp = now(), salt = randomBytes(16).toString("hex"), passwordHash = scryptSync(input.password, salt, 64).toString("hex");
    this.local.database.prepare("INSERT INTO ubeeq_accounts (id, email, password_hash, salt, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, input.email.toLowerCase(), passwordHash, salt, "active", timestamp, timestamp);
    return { id, subjectId: id, status: "active", createdAt: timestamp, updatedAt: timestamp };
  }
  async authenticate(input: { email: string; password: string }): Promise<{ token: string; session: AuthenticatedSession }> {
    const row = this.local.database.prepare("SELECT id, password_hash, salt, status, created_at, updated_at FROM ubeeq_accounts WHERE email = ?").get(input.email.toLowerCase()) as { id: string; password_hash: string; salt: string; status: IdentityAccount["status"]; created_at: string; updated_at: string } | undefined;
    if (!row || row.status !== "active") throw new Error("Invalid local credentials.");
    const supplied = scryptSync(input.password, row.salt, 64); const expected = Buffer.from(row.password_hash, "hex");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error("Invalid local credentials.");
    const token = randomBytes(32).toString("base64url"), id = randomUUID(), timestamp = now(), expiresAt = new Date(Date.now() + (this.local.configuration.sessionTtlSeconds ?? 86_400) * 1000).toISOString();
    this.local.database.prepare("INSERT INTO ubeeq_sessions (id, account_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)").run(id, row.id, digest(token), expiresAt, timestamp);
    return { token, session: { id, subject: { id: row.id, roles: ["creator"], scopes: ["creator.read", "creator.write", "work.publish", "export.create"] }, issuedAt: timestamp, expiresAt, authenticationMethod: "password" } };
  }
  async verifySession(input: { credential: string }): Promise<AuthenticatedSession | undefined> {
    const row = this.local.database.prepare("SELECT s.id, s.account_id, s.expires_at FROM ubeeq_sessions s WHERE s.token_hash = ? AND s.revoked_at IS NULL").get(digest(input.credential)) as { id: string; account_id: string; expires_at: string } | undefined;
    if (!row || row.expires_at <= now()) return undefined;
    return { id: row.id, subject: { id: row.account_id, roles: ["creator"], scopes: ["creator.read", "creator.write", "work.publish", "export.create"] }, issuedAt: "", expiresAt: row.expires_at, authenticationMethod: "password" };
  }
  async getAccount(subjectId: string): Promise<IdentityAccount | undefined> { const row = this.local.database.prepare("SELECT id, status, created_at, updated_at FROM ubeeq_accounts WHERE id = ?").get(subjectId) as { id: string; status: IdentityAccount["status"]; created_at: string; updated_at: string } | undefined; return row ? { id: row.id, subjectId: row.id, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at } : undefined; }
  async listDelegations(): Promise<readonly []> { return []; }
  async revokeSession(input: { sessionId: string }): Promise<void> { this.local.database.prepare("UPDATE ubeeq_sessions SET revoked_at = ? WHERE id = ?").run(now(), input.sessionId); }
}

/** Development-only encrypted credential custody. Production adapters must use a managed vault/key boundary. */
export class LocalCredentialVault implements CredentialVault {
  private readonly key: Buffer;
  constructor(private readonly local: LocalSqliteDatabase) { this.key = createHash("sha256").update(local.configuration.credentialEncryptionKey ?? `local-development:${resolve(local.configuration.databasePath)}`).digest(); }
  async write(input: { ownerId: string; value: Uint8Array; expiresAt?: string }): Promise<{ reference: string }> {
    const id = randomUUID(), iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.key, iv); const ciphertext = Buffer.concat([cipher.update(input.value), cipher.final()]), tag = cipher.getAuthTag();
    this.local.database.prepare("INSERT INTO ubeeq_credentials (id, owner_id, ciphertext, iv, auth_tag, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, input.ownerId, ciphertext, iv, tag, input.expiresAt ?? null, now()); return { reference: `local-vault:${id}` };
  }
  async read(input: { reference: string }): Promise<Uint8Array | undefined> {
    const id = input.reference.replace(/^local-vault:/, ""); if (id === input.reference) return undefined;
    const row = this.local.database.prepare("SELECT ciphertext, iv, auth_tag, expires_at, revoked_at FROM ubeeq_credentials WHERE id = ?").get(id) as { ciphertext: Uint8Array; iv: Uint8Array; auth_tag: Uint8Array; expires_at?: string; revoked_at?: string } | undefined;
    if (!row || row.revoked_at || (row.expires_at && row.expires_at <= now())) return undefined;
    const decipher = createDecipheriv("aes-256-gcm", this.key, row.iv); decipher.setAuthTag(Buffer.from(row.auth_tag)); return Buffer.concat([decipher.update(row.ciphertext), decipher.final()]);
  }
  async revoke(input: { reference: string }): Promise<void> { const id = input.reference.replace(/^local-vault:/, ""); if (id !== input.reference) this.local.database.prepare("UPDATE ubeeq_credentials SET revoked_at = ? WHERE id = ?").run(now(), id); }
}

export class LocalSqliteJobQueue implements JobQueue, Scheduler {
  constructor(private readonly local: LocalSqliteDatabase) {}
  async enqueue<T>(input: Omit<DurableJob<T>, "id" | "state" | "attempt" | "availableAt" | "createdAt" | "updatedAt"> & { availableAt?: string }): Promise<DurableJob<T>> {
    const existing = this.local.database.prepare("SELECT * FROM ubeeq_jobs WHERE idempotency_key = ?").get(input.idempotencyKey) as Record<string, unknown> | undefined; if (existing) return this.row(existing) as DurableJob<T>;
    const timestamp = now(), job: DurableJob<T> = { id: randomUUID(), type: input.type, payload: input.payload, idempotencyKey: input.idempotencyKey, state: "queued", attempt: 0, maxAttempts: input.maxAttempts, availableAt: input.availableAt ?? timestamp, createdAt: timestamp, updatedAt: timestamp, correlationId: input.correlationId };
    this.write(job); return job;
  }
  async lease<T>(input: { types?: readonly string[]; leaseDurationSeconds: number; workerId: string }): Promise<JobLease<T> | undefined> {
    // A crashed worker's expired lease becomes recoverable work before another worker claims it.
    this.local.database.prepare("UPDATE ubeeq_jobs SET state = 'retry_scheduled', available_at = ?, lease_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE state = 'leased' AND lease_expires_at <= ?").run(now(), now(), now());
    const typeFilter = input.types?.length ? ` AND type IN (${input.types.map(() => "?").join(",")})` : "";
    const row = this.local.database.prepare(`SELECT * FROM ubeeq_jobs WHERE state IN ('queued', 'retry_scheduled') AND available_at <= ?${typeFilter} ORDER BY available_at, id LIMIT 1`).get(now(), ...(input.types ?? [])) as Record<string, unknown> | undefined; if (!row) return undefined;
    const job = this.row(row) as DurableJob<T>;
    const leaseToken = randomUUID(); job.state = "leased"; job.attempt += 1; job.leaseExpiresAt = new Date(Date.now() + input.leaseDurationSeconds * 1000).toISOString(); job.updatedAt = now(); this.write(job, leaseToken); return { job, leaseToken };
  }
  async complete(input: { id: string; leaseToken: string }): Promise<void> { this.transition(input.id, input.leaseToken, "completed"); }
  async retry(input: { id: string; leaseToken: string; error: { code: string; message: string }; retryAt: string }): Promise<void> { this.transition(input.id, input.leaseToken, "retry_scheduled", input.error, input.retryAt); }
  async deadLetter(input: { id: string; leaseToken: string; error: { code: string; message: string } }): Promise<void> { this.transition(input.id, input.leaseToken, "dead_lettered", input.error); }
  async cancel(input: { id: string; reason?: string }): Promise<void> { this.local.database.prepare("UPDATE ubeeq_jobs SET state = 'cancelled', last_error = ?, updated_at = ? WHERE id = ?").run(input.reason ? json({ code: "cancelled", message: input.reason }) : null, now(), input.id); }
  async recover(input: { id: string; availableAt?: string }): Promise<DurableJob> { const row = this.local.database.prepare("SELECT * FROM ubeeq_jobs WHERE id = ?").get(input.id) as Record<string, unknown> | undefined; if (!row) throw new Error("Unknown job."); const job = this.row(row); job.state = "queued"; job.availableAt = input.availableAt ?? now(); job.lastError = undefined; job.updatedAt = now(); this.write(job); return job; }
  async get(id: string): Promise<DurableJob | undefined> { const row = this.local.database.prepare("SELECT * FROM ubeeq_jobs WHERE id = ?").get(id) as Record<string, unknown> | undefined; return row ? this.row(row) : undefined; }
  async list(input: { states?: readonly DurableJob["state"][]; limit: number }): Promise<readonly DurableJob[]> { const limit = Math.max(1, Math.min(100, input.limit)); const stateFilter = input.states?.length ? ` WHERE state IN (${input.states.map(() => "?").join(",")})` : ""; const rows = this.local.database.prepare(`SELECT * FROM ubeeq_jobs${stateFilter} ORDER BY created_at DESC, id DESC LIMIT ?`).all(...(input.states ?? []), limit) as Record<string, unknown>[]; return rows.map((row) => this.row(row)); }
  async schedule(input: { type: string; idempotencyKey: string; payload: unknown; runAt: string }): Promise<void> { await this.enqueue({ ...input, maxAttempts: 3, availableAt: input.runAt }); }
  async cancelSchedule(idempotencyKey: string): Promise<void> { this.local.database.prepare("UPDATE ubeeq_jobs SET state = 'cancelled', updated_at = ? WHERE idempotency_key = ?").run(now(), idempotencyKey); }
  private row(row: Record<string, unknown>): DurableJob { return { id: String(row.id), type: String(row.type), payload: parse(String(row.payload)), idempotencyKey: String(row.idempotency_key), state: row.state as DurableJob["state"], attempt: Number(row.attempt), maxAttempts: Number(row.max_attempts), availableAt: String(row.available_at), leaseExpiresAt: row.lease_expires_at ? String(row.lease_expires_at) : undefined, createdAt: String(row.created_at), updatedAt: String(row.updated_at), correlationId: row.correlation_id ? String(row.correlation_id) : undefined, lastError: row.last_error ? parse(String(row.last_error)) : undefined }; }
  private write(job: DurableJob, leaseToken?: string): void { this.local.database.prepare("INSERT INTO ubeeq_jobs (id,type,payload,idempotency_key,state,attempt,max_attempts,available_at,lease_token,lease_expires_at,created_at,updated_at,correlation_id,last_error) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state, attempt=excluded.attempt, available_at=excluded.available_at, lease_token=excluded.lease_token, lease_expires_at=excluded.lease_expires_at, updated_at=excluded.updated_at, last_error=excluded.last_error").run(job.id, job.type, json(job.payload), job.idempotencyKey, job.state, job.attempt, job.maxAttempts, job.availableAt, leaseToken ?? null, job.leaseExpiresAt ?? null, job.createdAt, job.updatedAt, job.correlationId ?? null, job.lastError ? json(job.lastError) : null); }
  private transition(id: string, leaseToken: string, state: DurableJob["state"], error?: { code: string; message: string }, availableAt?: string): void { const result = this.local.database.prepare("UPDATE ubeeq_jobs SET state = ?, last_error = ?, available_at = COALESCE(?, available_at), lease_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND state = 'leased' AND lease_token = ?").run(state, error ? json(error) : null, availableAt ?? null, now(), id, leaseToken); if (result.changes !== 1) throw new Error("Job lease is no longer valid."); }
}

export const createLocalAdapterSet = (configuration: LocalAdapterConfiguration) => {
  const database = new LocalSqliteDatabase(configuration);
  const storage = new LocalFilesystemStorage(database);
  return { database, repositories: createLocalRepositories(database), storage, identity: new LocalIdentityAdapter(database), credentials: new LocalCredentialVault(database), jobs: new LocalSqliteJobQueue(database) };
};
