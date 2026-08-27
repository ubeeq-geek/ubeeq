import { createCipheriv, createDecipheriv, createHash, createHmac, generateKeyPairSync, randomBytes, randomUUID, sign as signMessage, scryptSync, timingSafeEqual, verify as verifyMessage } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AuthenticatedSession, IdentityAccount, PasswordIdentityAdapter } from "@ubeeq/auth";
import type { DurableJob, JobLease, JobQueue, Scheduler } from "@ubeeq/jobs";
import type { CredentialVault } from "@ubeeq/integrations";
import type { FederationReplayStore, FederationSignatureVerifier, FederationSigner } from "@ubeeq/federation";
import { RoutingDirectoryConflictError, validateCellRoute, validateMigrationCheckpoint, type CellRoute, type MigrationCheckpoint, type MigrationCheckpointStore, type RoutingDirectory } from "@ubeeq/deployment-platform";
import { CellScopedRepository, OptimisticConcurrencyError, type CellOwnedRecord, type Page, type PageRequest, type PersistenceTransaction, type RevisionedRecord, type RevisionedRepository, type UbeeqRepositories } from "@ubeeq/persistence";
import { requireCreatorScopedObject, type DeliveryAdapter, type ObjectStorage, type StoredObject, type UploadAcceptance, type UploadContentAdapter, type UploadCompletion, type UploadInitiation } from "@ubeeq/storage";

const now = (): string => new Date().toISOString();
const json = <T>(value: T): string => JSON.stringify(value);
const parse = <T>(value: string): T => JSON.parse(value) as T;
const digest = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");
type SqliteDatabase = { exec(sql: string): void; prepare(sql: string): { get(...parameters: unknown[]): unknown; all(...parameters: unknown[]): unknown; run(...parameters: unknown[]): { changes: number } }; };

export interface LocalAdapterConfiguration { databasePath: string; dataDirectory: string; publicBaseUrl: string; cellId: string; sessionTtlSeconds?: number; credentialEncryptionKey?: string; deliverySigningKey?: string; deliverySigningKeys?: Readonly<Record<string, string>>; activeDeliveryKeyId?: string; }

export class LocalSqliteDatabase {
  readonly database: SqliteDatabase;
  private transactionDepth = 0;

  constructor(readonly configuration: LocalAdapterConfiguration) {
    mkdirSync(resolve(configuration.dataDirectory), { recursive: true });
    mkdirSync(resolve(configuration.databasePath, ".."), { recursive: true });
    this.database = new DatabaseSync(configuration.databasePath) as SqliteDatabase;
    this.database.exec("CREATE TABLE IF NOT EXISTS ubeeq_schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
    if (!configuration.cellId.trim()) throw new Error("Local adapters require a cellId.");
    for (const id of ["001-initial", "002-credential-vault", "003-federation-replays", "004-federation-keys", "005-regional-cell", "006-cell-boundaries", "007-routing-directory"]) {
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
const cellRepository = <T extends RevisionedRecord & CellOwnedRecord>(local: LocalSqliteDatabase, name: string): RevisionedRepository<T> => new CellScopedRepository(repository<T>(local, name), local.configuration.cellId);

/** Durable local composition. It is intentionally a generic JSON-record adapter, not an in-memory default. */
export const createLocalRepositories = (local: LocalSqliteDatabase): UbeeqRepositories => ({
  transaction: local.transaction.bind(local),
  creators: cellRepository(local, "creators"), works: cellRepository(local, "works"), assets: cellRepository(local, "assets"), collections: cellRepository(local, "collections"), workMemberships: cellRepository(local, "workMemberships"),
  publicationIntents: cellRepository(local, "publicationIntents"), publications: cellRepository(local, "publications"), reconciliationSnapshots: cellRepository(local, "reconciliationSnapshots"),
  moderationEvidence: cellRepository(local, "moderationEvidence"), moderationHolds: cellRepository(local, "moderationHolds"), reviewCases: cellRepository(local, "reviewCases"), auditEvents: cellRepository(local, "auditEvents"),
  usageEvents: cellRepository(local, "usageEvents"), creditLots: cellRepository(local, "creditLots"), creditReservations: cellRepository(local, "creditReservations"), balances: cellRepository(local, "balances"),
  integrationAccounts: cellRepository(local, "integrationAccounts"), syncCursors: cellRepository(local, "syncCursors"), integrationJobs: cellRepository(local, "integrationJobs"), exportManifests: cellRepository(local, "exportManifests"), importCheckpoints: cellRepository(local, "importCheckpoints"), federationActors: repository(local, "federationActors"), remotePublicationReferences: repository(local, "remotePublicationReferences")
});

export class LocalFilesystemStorage implements ObjectStorage, UploadContentAdapter, DeliveryAdapter {
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
    const match = input.object.key.match(/^cells\/([^/]+)\/creators\/([^/]+)\//); if (!match) throw new Error("Upload object is not creator-scoped.");
    const uploadId = randomUUID(); this.local.database.prepare("INSERT INTO ubeeq_uploads (id, object_payload, cell_id, creator_id, expires_at, expected_checksum, expected_byte_length, operation, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(uploadId, json(input.object), match[1], match[2], input.expiresAt, input.object.checksum ?? null, input.object.byteLength, "upload_content", now());
    return { uploadId, object: input.object, completeUrl: `${this.local.configuration.publicBaseUrl.replace(/\/$/, "")}/v1/uploads/${uploadId}/complete`, expiresAt: input.expiresAt };
  }
  async accept(input: UploadAcceptance): Promise<void> { const row = this.local.database.prepare("SELECT cell_id, creator_id, expires_at, expected_checksum, expected_byte_length, operation FROM ubeeq_uploads WHERE id = ?").get(input.uploadId) as { cell_id: string; creator_id: string; expires_at: string; expected_checksum?: string; expected_byte_length: number; operation: string } | undefined; if (!row || row.cell_id !== input.cellId || row.creator_id !== input.creatorId || row.operation !== input.operation) throw new Error("Upload scope does not match the authenticated creator and cell."); if (Date.parse(row.expires_at) <= Date.now()) throw new Error("Upload session has expired."); if (input.body.byteLength !== row.expected_byte_length || (row.expected_checksum && digest(input.body) !== row.expected_checksum)) throw new Error("Upload content does not match the declared size or checksum."); this.local.database.prepare("UPDATE ubeeq_uploads SET body = ? WHERE id = ? AND cell_id = ? AND creator_id = ?").run(input.body, input.uploadId, input.cellId, input.creatorId); }
  async abort(input: { uploadId: string; cellId: string; creatorId: string }): Promise<void> { this.local.database.prepare("DELETE FROM ubeeq_uploads WHERE id = ? AND cell_id = ? AND creator_id = ?").run(input.uploadId, input.cellId, input.creatorId); }
  async complete(input: UploadCompletion): Promise<StoredObject> {
    const row = this.local.database.prepare("SELECT object_payload, body FROM ubeeq_uploads WHERE id = ?").get(input.uploadId) as { object_payload?: string; body?: Uint8Array } | undefined;
    if (!row?.object_payload || !row.body) throw new Error("Upload content has not been received.");
    const requested = parse<StoredObject>(row.object_payload);
    requireCreatorScopedObject(requested.key, input);
    if (row.body.byteLength !== input.byteLength || digest(row.body) !== input.checksum) throw new Error("Upload checksum or length does not match.");
    const object = { ...requested, checksum: input.checksum, byteLength: input.byteLength, versionId: randomUUID() };
    await this.put({ object, body: row.body }); this.local.database.prepare("DELETE FROM ubeeq_uploads WHERE id = ?").run(input.uploadId); return object;
  }
  async issue(request: { object: Pick<StoredObject, "bucket" | "key" | "versionId" | "scope">; expiresAt: string; disposition?: "inline" | "attachment" }): Promise<{ url: string; expiresAt: string }> {
    const match = request.object.key.match(/^cells\/([^/]+)\/creators\/([^/]+)\//); if (!match || match[1] !== this.local.configuration.cellId) throw new Error("Delivery object is not scoped to this cell.");
    if (request.object.scope === "public" && !request.object.key.includes("/renditions/")) throw new Error("Only rendition objects may receive public cacheable delivery tokens.");
    if (Date.parse(request.expiresAt) <= Date.now()) throw new Error("Delivery expiry must be in the future.");
    const keyId = this.local.configuration.activeDeliveryKeyId ?? "local-v1"; const payload = Buffer.from(json({ version: 1, keyId, cellId: match[1], creatorId: match[2], ...request.object, disposition: request.disposition ?? "inline", expiresAt: request.expiresAt })).toString("base64url"); const signature = createHmac("sha256", this.deliveryKey(keyId)).update(payload).digest("base64url"); return { url: `${this.local.configuration.publicBaseUrl.replace(/\/$/, "")}/v1/delivery/${payload}.${signature}`, expiresAt: request.expiresAt };
  }
  verifyDeliveryToken(token: string): { version: 1; keyId: string; cellId: string; creatorId: string; bucket: string; key: string; versionId?: string; scope: StoredObject["scope"]; disposition: "inline" | "attachment"; expiresAt: string } { const [payload, signature, extra] = token.split("."); if (!payload || !signature || extra) throw new Error("Delivery token is malformed."); let claims: ReturnType<LocalFilesystemStorage["verifyDeliveryToken"]>; try { claims = parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { throw new Error("Delivery token claims are malformed."); } const expected = createHmac("sha256", this.deliveryKey(claims.keyId)).update(payload).digest(); const supplied = Buffer.from(signature, "base64url"); if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error("Delivery token signature is invalid."); if (claims.version !== 1 || claims.cellId !== this.local.configuration.cellId || Date.parse(claims.expiresAt) <= Date.now()) throw new Error("Delivery token is expired or belongs to another cell."); requireCreatorScopedObject(claims.key, claims); if (claims.bucket !== claims.cellId || (claims.scope === "public" && !claims.key.includes("/renditions/"))) throw new Error("Delivery claims violate cell cache policy."); return claims; }
  private deliveryKey(keyId: string): Buffer { const configured = this.local.configuration.deliverySigningKeys?.[keyId] ?? (keyId === (this.local.configuration.activeDeliveryKeyId ?? "local-v1") ? this.local.configuration.deliverySigningKey : undefined); if (!configured && this.local.configuration.deliverySigningKeys) throw new Error("Delivery token keyId is unknown."); return createHash("sha256").update(configured ?? this.local.configuration.credentialEncryptionKey ?? `local-delivery:${resolve(this.local.configuration.databasePath)}`).digest(); }
}

export class LocalIdentityAdapter implements PasswordIdentityAdapter {
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
  async write(input: { cellId: string; ownerId: string; value: Uint8Array; expiresAt?: string }): Promise<{ reference: string }> {
    if (input.cellId !== this.local.configuration.cellId) throw new Error("Credential belongs to another cell.");
    const id = randomUUID(), iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.key, iv); const ciphertext = Buffer.concat([cipher.update(input.value), cipher.final()]), tag = cipher.getAuthTag();
    this.local.database.prepare("INSERT INTO ubeeq_credentials (id, cell_id, owner_id, ciphertext, iv, auth_tag, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(id, input.cellId, input.ownerId, ciphertext, iv, tag, input.expiresAt ?? null, now()); return { reference: `local-vault:${input.cellId}:${id}` };
  }
  async read(input: { cellId: string; reference: string }): Promise<Uint8Array | undefined> {
    const prefix = `local-vault:${input.cellId}:`; if (!input.reference.startsWith(prefix) || input.cellId !== this.local.configuration.cellId) return undefined; const id = input.reference.slice(prefix.length);
    const row = this.local.database.prepare("SELECT ciphertext, iv, auth_tag, expires_at, revoked_at FROM ubeeq_credentials WHERE id = ? AND cell_id = ?").get(id, input.cellId) as { ciphertext: Uint8Array; iv: Uint8Array; auth_tag: Uint8Array; expires_at?: string; revoked_at?: string } | undefined;
    if (!row || row.revoked_at || (row.expires_at && row.expires_at <= now())) return undefined;
    const decipher = createDecipheriv("aes-256-gcm", this.key, row.iv); decipher.setAuthTag(Buffer.from(row.auth_tag)); return Buffer.concat([decipher.update(row.ciphertext), decipher.final()]);
  }
  async revoke(input: { cellId: string; reference: string }): Promise<void> { const prefix = `local-vault:${input.cellId}:`; if (input.reference.startsWith(prefix) && input.cellId === this.local.configuration.cellId) this.local.database.prepare("UPDATE ubeeq_credentials SET revoked_at = ? WHERE id = ? AND cell_id = ?").run(now(), input.reference.slice(prefix.length), input.cellId); }
}

/** Local Ed25519 signing is a portable reference; hosted instances may resolve keys from a managed provider. */
export class LocalFederationKey implements FederationSigner, FederationSignatureVerifier, FederationReplayStore {
  readonly keyId = "local-ed25519-v1"; readonly publicKey: string; private readonly privateKey: string;
  constructor(private readonly local: LocalSqliteDatabase) {
    const existing = local.database.prepare("SELECT private_key, public_key FROM ubeeq_federation_keys WHERE id = ?").get(this.keyId) as { private_key?: string; public_key?: string } | undefined;
    if (existing?.private_key && existing.public_key) { this.privateKey = existing.private_key; this.publicKey = existing.public_key; }
    else { const pair = generateKeyPairSync("ed25519"); this.privateKey = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(); this.publicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString(); local.database.prepare("INSERT INTO ubeeq_federation_keys (id, private_key, public_key, created_at) VALUES (?, ?, ?, ?)").run(this.keyId, this.privateKey, this.publicKey, now()); }
  }
  async sign(message: string): Promise<string> { return signMessage(null, Buffer.from(message), this.privateKey).toString("base64url"); }
  async verify(input: { keyId: string; message: string; signature: string }): Promise<boolean> { return input.keyId === this.keyId && verifyMessage(null, Buffer.from(input.message), this.publicKey, Buffer.from(input.signature, "base64url")); }
  async consume(input: { envelopeId: string; expiresAt: string }): Promise<boolean> { const result = this.local.database.prepare("INSERT OR IGNORE INTO ubeeq_federation_replays (id, expires_at, created_at) VALUES (?, ?, ?)").run(input.envelopeId, input.expiresAt, now()); return result.changes === 1; }
}

export class LocalSqliteJobQueue implements JobQueue, Scheduler {
  constructor(private readonly local: LocalSqliteDatabase) {}
  async enqueue<T>(input: Omit<DurableJob<T>, "id" | "state" | "attempt" | "availableAt" | "createdAt" | "updatedAt"> & { availableAt?: string }): Promise<DurableJob<T>> {
    const storedIdempotencyKey = `${input.cellId}:${input.idempotencyKey}`;
    const existing = this.local.database.prepare("SELECT * FROM ubeeq_jobs WHERE cell_id = ? AND idempotency_key = ?").get(input.cellId, storedIdempotencyKey) as Record<string, unknown> | undefined; if (existing) return this.row(existing) as DurableJob<T>;
    const timestamp = now(), job: DurableJob<T> = { id: randomUUID(), cellId: input.cellId, type: input.type, payload: input.payload, idempotencyKey: input.idempotencyKey, state: "queued", attempt: 0, maxAttempts: input.maxAttempts, availableAt: input.availableAt ?? timestamp, createdAt: timestamp, updatedAt: timestamp, correlationId: input.correlationId };
    this.write(job, undefined, storedIdempotencyKey); return job;
  }
  async lease<T>(input: { cellId: string; types?: readonly string[]; leaseDurationSeconds: number; workerId: string }): Promise<JobLease<T> | undefined> {
    // A crashed worker's expired lease becomes recoverable work before another worker claims it.
    this.local.database.prepare("UPDATE ubeeq_jobs SET state = 'retry_scheduled', available_at = ?, lease_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE state = 'leased' AND lease_expires_at <= ?").run(now(), now(), now());
    const typeFilter = input.types?.length ? ` AND type IN (${input.types.map(() => "?").join(",")})` : "";
    const row = this.local.database.prepare(`SELECT * FROM ubeeq_jobs WHERE cell_id = ? AND state IN ('queued', 'retry_scheduled') AND available_at <= ?${typeFilter} ORDER BY available_at, id LIMIT 1`).get(input.cellId, now(), ...(input.types ?? [])) as Record<string, unknown> | undefined; if (!row) return undefined;
    const job = this.row(row) as DurableJob<T>;
    const leaseToken = randomUUID(); job.state = "leased"; job.attempt += 1; job.leaseExpiresAt = new Date(Date.now() + input.leaseDurationSeconds * 1000).toISOString(); job.updatedAt = now(); this.write(job, leaseToken); return { job, leaseToken };
  }
  async complete(input: { id: string; leaseToken: string }): Promise<void> { this.transition(input.id, input.leaseToken, "completed"); }
  async retry(input: { id: string; leaseToken: string; error: { code: string; message: string }; retryAt: string }): Promise<void> { this.transition(input.id, input.leaseToken, "retry_scheduled", input.error, input.retryAt); }
  async deadLetter(input: { id: string; leaseToken: string; error: { code: string; message: string } }): Promise<void> { this.transition(input.id, input.leaseToken, "dead_lettered", input.error); }
  async cancel(input: { id: string; reason?: string }): Promise<void> { this.local.database.prepare("UPDATE ubeeq_jobs SET state = 'cancelled', last_error = ?, updated_at = ? WHERE id = ?").run(input.reason ? json({ code: "cancelled", message: input.reason }) : null, now(), input.id); }
  async recover(input: { id: string; availableAt?: string }): Promise<DurableJob> { const row = this.local.database.prepare("SELECT * FROM ubeeq_jobs WHERE id = ?").get(input.id) as Record<string, unknown> | undefined; if (!row) throw new Error("Unknown job."); const job = this.row(row); job.state = "queued"; job.availableAt = input.availableAt ?? now(); job.lastError = undefined; job.updatedAt = now(); this.write(job); return job; }
  async get(id: string): Promise<DurableJob | undefined> { const row = this.local.database.prepare("SELECT * FROM ubeeq_jobs WHERE id = ?").get(id) as Record<string, unknown> | undefined; return row ? this.row(row) : undefined; }
  async list(input: { cellId: string; states?: readonly DurableJob["state"][]; limit: number }): Promise<readonly DurableJob[]> { const limit = Math.max(1, Math.min(100, input.limit)); const stateFilter = input.states?.length ? ` AND state IN (${input.states.map(() => "?").join(",")})` : ""; const rows = this.local.database.prepare(`SELECT * FROM ubeeq_jobs WHERE cell_id = ?${stateFilter} ORDER BY created_at DESC, id DESC LIMIT ?`).all(input.cellId, ...(input.states ?? []), limit) as Record<string, unknown>[]; return rows.map((row) => this.row(row)); }
  async schedule(input: { cellId: string; type: string; idempotencyKey: string; payload: unknown; runAt: string }): Promise<void> { await this.enqueue({ ...input, maxAttempts: 3, availableAt: input.runAt }); }
  async cancelSchedule(input: { cellId: string; idempotencyKey: string }): Promise<void> { this.local.database.prepare("UPDATE ubeeq_jobs SET state = 'cancelled', updated_at = ? WHERE cell_id = ? AND idempotency_key = ?").run(now(), input.cellId, `${input.cellId}:${input.idempotencyKey}`); }
  private row(row: Record<string, unknown>): DurableJob { const cellId = String(row.cell_id); const storedKey = String(row.idempotency_key); return { id: String(row.id), cellId, type: String(row.type), payload: parse(String(row.payload)), idempotencyKey: storedKey.startsWith(`${cellId}:`) ? storedKey.slice(cellId.length + 1) : storedKey, state: row.state as DurableJob["state"], attempt: Number(row.attempt), maxAttempts: Number(row.max_attempts), availableAt: String(row.available_at), leaseExpiresAt: row.lease_expires_at ? String(row.lease_expires_at) : undefined, createdAt: String(row.created_at), updatedAt: String(row.updated_at), correlationId: row.correlation_id ? String(row.correlation_id) : undefined, lastError: row.last_error ? parse(String(row.last_error)) : undefined }; }
  private write(job: DurableJob, leaseToken?: string, storedIdempotencyKey = `${job.cellId}:${job.idempotencyKey}`): void { this.local.database.prepare("INSERT INTO ubeeq_jobs (id,cell_id,type,payload,idempotency_key,state,attempt,max_attempts,available_at,lease_token,lease_expires_at,created_at,updated_at,correlation_id,last_error) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state, attempt=excluded.attempt, available_at=excluded.available_at, lease_token=excluded.lease_token, lease_expires_at=excluded.lease_expires_at, updated_at=excluded.updated_at, last_error=excluded.last_error").run(job.id, job.cellId, job.type, json(job.payload), storedIdempotencyKey, job.state, job.attempt, job.maxAttempts, job.availableAt, leaseToken ?? null, job.leaseExpiresAt ?? null, job.createdAt, job.updatedAt, job.correlationId ?? null, job.lastError ? json(job.lastError) : null); }
  private transition(id: string, leaseToken: string, state: DurableJob["state"], error?: { code: string; message: string }, availableAt?: string): void { const result = this.local.database.prepare("UPDATE ubeeq_jobs SET state = ?, last_error = ?, available_at = COALESCE(?, available_at), lease_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND state = 'leased' AND lease_token = ?").run(state, error ? json(error) : null, availableAt ?? null, now(), id, leaseToken); if (result.changes !== 1) throw new Error("Job lease is no longer valid."); }
}

/**
 * SQLite control-plane implementation for a single operator.  It is not part
 * of `UbeeqRepositories`: routes are intentionally outside any creator's home
 * cell data set and contain no private creator state.
 */
export class LocalRoutingDirectory implements RoutingDirectory {
  constructor(private readonly local: LocalSqliteDatabase) {}
  async get(creatorId: string): Promise<CellRoute | undefined> {
    const row = this.local.database.prepare("SELECT creator_id, home_cell_id, home_region, endpoint, routing_revision, state, updated_at FROM ubeeq_cell_routes WHERE creator_id = ?").get(creatorId) as Record<string, unknown> | undefined;
    return row ? this.route(row) : undefined;
  }
  async create(route: CellRoute): Promise<CellRoute> {
    validateCellRoute(route);
    try {
      this.local.database.prepare("INSERT INTO ubeeq_cell_routes (creator_id, home_cell_id, home_region, endpoint, routing_revision, state, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(route.creatorId, route.homeCellId, route.homeRegion, route.endpoint, route.routingRevision, route.state, route.updatedAt);
      return route;
    } catch (error) {
      if (error instanceof Error && /unique|constraint/i.test(error.message)) throw new RoutingDirectoryConflictError(`A route already exists for creator ${route.creatorId}.`);
      throw error;
    }
  }
  async compareAndSwap(input: { route: CellRoute; expectedRoutingRevision: number }): Promise<CellRoute> {
    validateCellRoute(input.route);
    if (input.route.routingRevision !== input.expectedRoutingRevision + 1) throw new RoutingDirectoryConflictError("The replacement route must advance routingRevision by exactly one.");
    const result = this.local.database.prepare("UPDATE ubeeq_cell_routes SET home_cell_id = ?, home_region = ?, endpoint = ?, routing_revision = ?, state = ?, updated_at = ? WHERE creator_id = ? AND routing_revision = ?").run(input.route.homeCellId, input.route.homeRegion, input.route.endpoint, input.route.routingRevision, input.route.state, input.route.updatedAt, input.route.creatorId, input.expectedRoutingRevision);
    if (result.changes !== 1) throw new RoutingDirectoryConflictError(`Route revision ${input.expectedRoutingRevision} is no longer current for creator ${input.route.creatorId}.`);
    return input.route;
  }
  async list(input: { limit: number; cursor?: string }): Promise<{ items: readonly CellRoute[]; nextCursor?: string }> {
    const limit = Math.max(1, Math.min(100, input.limit)), after = input.cursor ? Buffer.from(input.cursor, "base64url").toString("utf8") : "";
    const rows = this.local.database.prepare("SELECT creator_id, home_cell_id, home_region, endpoint, routing_revision, state, updated_at FROM ubeeq_cell_routes WHERE creator_id > ? ORDER BY creator_id LIMIT ?").all(after, limit + 1) as Record<string, unknown>[];
    const items = rows.slice(0, limit).map((row) => this.route(row));
    return { items, nextCursor: rows.length > limit ? Buffer.from(items.at(-1)!.creatorId).toString("base64url") : undefined };
  }
  private route(row: Record<string, unknown>): CellRoute { return validateCellRoute({ creatorId: String(row.creator_id), homeCellId: String(row.home_cell_id), homeRegion: String(row.home_region), endpoint: String(row.endpoint), routingRevision: Number(row.routing_revision), state: row.state as CellRoute["state"], updatedAt: String(row.updated_at) }); }
}

/** Durable migration state lets a worker resume after a process restart. */
export class LocalMigrationCheckpoints implements MigrationCheckpointStore {
  constructor(private readonly local: LocalSqliteDatabase) {}
  async get(id: string): Promise<MigrationCheckpoint | undefined> {
    const row = this.local.database.prepare("SELECT payload FROM ubeeq_migration_checkpoints WHERE id = ?").get(id) as { payload?: string } | undefined;
    return row?.payload ? validateMigrationCheckpoint(parse<MigrationCheckpoint>(row.payload)) : undefined;
  }
  async create(checkpoint: MigrationCheckpoint): Promise<MigrationCheckpoint> {
    validateMigrationCheckpoint(checkpoint);
    try {
      this.local.database.prepare("INSERT INTO ubeeq_migration_checkpoints (id, creator_id, payload, updated_at) VALUES (?, ?, ?, ?)").run(checkpoint.id, checkpoint.creatorId, json(checkpoint), checkpoint.updatedAt);
      return checkpoint;
    } catch (error) {
      if (error instanceof Error && /unique|constraint/i.test(error.message)) throw new RoutingDirectoryConflictError(`Migration checkpoint ${checkpoint.id} already exists.`);
      throw error;
    }
  }
  async compareAndSwap(input: { checkpoint: MigrationCheckpoint; expectedUpdatedAt: string }): Promise<MigrationCheckpoint> {
    validateMigrationCheckpoint(input.checkpoint);
    if (input.checkpoint.updatedAt === input.expectedUpdatedAt) throw new RoutingDirectoryConflictError("A migration update must advance updatedAt.");
    const result = this.local.database.prepare("UPDATE ubeeq_migration_checkpoints SET creator_id = ?, payload = ?, updated_at = ? WHERE id = ? AND updated_at = ?").run(input.checkpoint.creatorId, json(input.checkpoint), input.checkpoint.updatedAt, input.checkpoint.id, input.expectedUpdatedAt);
    if (result.changes !== 1) throw new RoutingDirectoryConflictError(`Migration checkpoint ${input.checkpoint.id} has changed.`);
    return input.checkpoint;
  }
  async list(input: { creatorId?: string; limit: number; cursor?: string }): Promise<{ items: readonly MigrationCheckpoint[]; nextCursor?: string }> {
    const limit = Math.max(1, Math.min(100, input.limit)), after = input.cursor ? Buffer.from(input.cursor, "base64url").toString("utf8") : "";
    const rows = input.creatorId
      ? this.local.database.prepare("SELECT id, payload FROM ubeeq_migration_checkpoints WHERE creator_id = ? AND id > ? ORDER BY id LIMIT ?").all(input.creatorId, after, limit + 1)
      : this.local.database.prepare("SELECT id, payload FROM ubeeq_migration_checkpoints WHERE id > ? ORDER BY id LIMIT ?").all(after, limit + 1);
    const typed = rows as Array<{ id: string; payload: string }>, items = typed.slice(0, limit).map((row) => validateMigrationCheckpoint(parse<MigrationCheckpoint>(row.payload)));
    return { items, nextCursor: typed.length > limit ? Buffer.from(items.at(-1)!.id).toString("base64url") : undefined };
  }
}

export const createLocalAdapterSet = (configuration: LocalAdapterConfiguration) => {
  const database = new LocalSqliteDatabase(configuration);
  const storage = new LocalFilesystemStorage(database);
  return { database, repositories: createLocalRepositories(database), storage, identity: new LocalIdentityAdapter(database), credentials: new LocalCredentialVault(database), federation: new LocalFederationKey(database), jobs: new LocalSqliteJobQueue(database), routingDirectory: new LocalRoutingDirectory(database), migrationCheckpoints: new LocalMigrationCheckpoints(database) };
};
