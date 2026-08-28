/**
 * Provider-neutral machine adapters. PostgreSQL is the canonical durable store
 * for a scalable machine cell; no application service imports this package.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { CellScopedRepository, OptimisticConcurrencyError, type CellOwnedRecord, type Page, type PageRequest, type PersistenceTransaction, type RevisionedRecord, type RevisionedRepository, type UbeeqRepositories } from "@ubeeq/persistence";
import type { DurableJob, JobLease, JobQueue, Scheduler } from "@ubeeq/jobs";
import { requireCellScopedObject, requireCreatorScopedObject, type DeliveryAdapter, type ObjectStorage, type StoredObject, type UploadAdapter, type UploadCompletion, type UploadInitiation } from "@ubeeq/storage";

const timestamp = (): string => new Date().toISOString();
const limit = (value: number): number => Math.max(1, Math.min(100, value));
const cursor = (id: string): string => Buffer.from(id).toString("base64url");
const afterCursor = (value?: string): string => value ? Buffer.from(value, "base64url").toString("utf8") : "";

export interface PostgresAdapterConfiguration {
  connectionString: string;
  cellId: string;
  applicationName?: string;
  idempotencyRetentionDays?: number;
}

type Queryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;
type MachineTransaction = PersistenceTransaction & { client: PoolClient };

/** Applies explicit SQL migrations and exposes atomic repository transactions. */
export class PostgresDatabase {
  readonly pool: Pool;
  private readonly transactions = new Map<string, PoolClient>();

  constructor(readonly configuration: PostgresAdapterConfiguration, pool?: Pool) {
    if (!configuration.connectionString.trim() || !configuration.cellId.trim()) throw new Error("PostgreSQL adapters require connectionString and cellId.");
    this.pool = pool ?? new Pool({ connectionString: configuration.connectionString, application_name: configuration.applicationName ?? "ubeeq-machine" });
  }

  async migrate(): Promise<void> {
    await this.pool.query("CREATE TABLE IF NOT EXISTS ubeeq_schema_migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL)");
    const id = "001-core";
    const applied = await this.pool.query<{ id: string }>("SELECT id FROM ubeeq_schema_migrations WHERE id = $1", [id]);
    if (applied.rowCount) return;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const again = await client.query<{ id: string }>("SELECT id FROM ubeeq_schema_migrations WHERE id = $1 FOR UPDATE", [id]);
      if (!again.rowCount) {
        await client.query(readFileSync(join(__dirname, "migrations", `${id}.sql`), "utf8"));
        await client.query("INSERT INTO ubeeq_schema_migrations (id, applied_at) VALUES ($1, NOW())", [id]);
      }
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  async transaction<T>(operation: (transaction: PersistenceTransaction) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const transaction: MachineTransaction = { id: `postgres-${randomUUID()}`, client };
    this.transactions.set(transaction.id, client);
    try {
      await client.query("BEGIN");
      const result = await operation(transaction);
      await client.query("COMMIT");
      return result;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { this.transactions.delete(transaction.id); client.release(); }
  }

  queryable(transaction?: PersistenceTransaction): Queryable {
    if (!transaction) return this.pool;
    const client = this.transactions.get(transaction.id) ?? (transaction as Partial<MachineTransaction>).client;
    if (!client) throw new Error("PostgreSQL repository received an unknown transaction.");
    return client;
  }

  async close(): Promise<void> { await this.pool.end(); }
}

type Options = { transaction?: PersistenceTransaction; idempotencyKey?: string };

export class PostgresRevisionedRepository<T extends RevisionedRecord> implements RevisionedRepository<T> {
  constructor(private readonly database: PostgresDatabase, private readonly repository: string) {}
  private query(options?: Options): Queryable { return this.database.queryable(options?.transaction); }

  async create(record: Omit<T, "revision" | "createdAt" | "updatedAt">, options?: Options): Promise<T> {
    const db = this.query(options);
    if (options?.idempotencyKey) {
      const existing = await db.query<{ record_id: string }>("SELECT record_id FROM ubeeq_idempotency WHERE repository = $1 AND idempotency_key = $2", [this.repository, options.idempotencyKey]);
      if (existing.rowCount) return (await this.get(existing.rows[0].record_id, options))!;
    }
    const value = { ...record, revision: 1, createdAt: timestamp(), updatedAt: timestamp() } as T;
    try {
      await db.query("INSERT INTO ubeeq_records (repository, id, revision, payload, created_at, updated_at) VALUES ($1, $2, $3, $4::jsonb, $5, $6)", [this.repository, value.id, value.revision, JSON.stringify(value), value.createdAt, value.updatedAt]);
    } catch (error) {
      const current = await this.get(value.id, options);
      if (current && options?.idempotencyKey) return current;
      throw error;
    }
    if (options?.idempotencyKey) {
      try { await db.query("INSERT INTO ubeeq_idempotency (repository, idempotency_key, record_id, created_at) VALUES ($1, $2, $3, NOW())", [this.repository, options.idempotencyKey, value.id]); }
      catch (error) {
        const existing = await db.query<{ record_id: string }>("SELECT record_id FROM ubeeq_idempotency WHERE repository = $1 AND idempotency_key = $2", [this.repository, options.idempotencyKey]);
        if (existing.rowCount) return (await this.get(existing.rows[0].record_id, options))!;
        throw error;
      }
    }
    return value;
  }
  async get(id: string, options?: { transaction?: PersistenceTransaction }): Promise<T | undefined> {
    const result = await this.database.queryable(options?.transaction).query<{ payload: T }>("SELECT payload FROM ubeeq_records WHERE repository = $1 AND id = $2", [this.repository, id]);
    return result.rows[0]?.payload;
  }
  async list(request: PageRequest, options?: { transaction?: PersistenceTransaction }): Promise<Page<T>> {
    const result = await this.database.queryable(options?.transaction).query<{ id: string; payload: T }>("SELECT id, payload FROM ubeeq_records WHERE repository = $1 AND id > $2 ORDER BY id LIMIT $3", [this.repository, afterCursor(request.cursor), limit(request.limit) + 1]);
    const items = result.rows.slice(0, limit(request.limit)).map((row) => row.payload);
    return { items, nextCursor: result.rows.length > limit(request.limit) ? cursor(items.at(-1)!.id) : undefined };
  }
  async update(id: string, expectedRevision: number, change: Partial<Omit<T, "id" | "revision" | "createdAt" | "updatedAt">>, options?: Options): Promise<T> {
    const current = await this.get(id, options);
    if (!current || current.revision !== expectedRevision) throw new OptimisticConcurrencyError(id, expectedRevision);
    const value = { ...current, ...change, revision: current.revision + 1, updatedAt: timestamp() } as T;
    const result = await this.query(options).query("UPDATE ubeeq_records SET revision = $1, payload = $2::jsonb, updated_at = $3 WHERE repository = $4 AND id = $5 AND revision = $6", [value.revision, JSON.stringify(value), value.updatedAt, this.repository, id, expectedRevision]);
    if (result.rowCount !== 1) throw new OptimisticConcurrencyError(id, expectedRevision);
    return value;
  }
  async remove(id: string, expectedRevision: number, options?: { transaction?: PersistenceTransaction }): Promise<void> {
    const result = await this.database.queryable(options?.transaction).query("DELETE FROM ubeeq_records WHERE repository = $1 AND id = $2 AND revision = $3", [this.repository, id, expectedRevision]);
    if (result.rowCount !== 1) throw new OptimisticConcurrencyError(id, expectedRevision);
  }
}

const repository = <T extends RevisionedRecord>(database: PostgresDatabase, name: string) => new PostgresRevisionedRepository<T>(database, name);
const cellRepository = <T extends RevisionedRecord & CellOwnedRecord>(database: PostgresDatabase, name: string): RevisionedRepository<T> => new CellScopedRepository(repository<T>(database, name), database.configuration.cellId);

export const createPostgresRepositories = (database: PostgresDatabase): UbeeqRepositories => ({
  transaction: (operation) => database.transaction(operation),
  creators: cellRepository(database, "creators"), works: cellRepository(database, "works"), assets: cellRepository(database, "assets"), collections: cellRepository(database, "collections"), workMemberships: cellRepository(database, "workMemberships"), publicationIntents: cellRepository(database, "publicationIntents"), publications: cellRepository(database, "publications"), reconciliationSnapshots: cellRepository(database, "reconciliationSnapshots"), moderationEvidence: cellRepository(database, "moderationEvidence"), moderationHolds: cellRepository(database, "moderationHolds"), reviewCases: cellRepository(database, "reviewCases"), auditEvents: cellRepository(database, "auditEvents"), usageEvents: cellRepository(database, "usageEvents"), creditLots: cellRepository(database, "creditLots"), creditReservations: cellRepository(database, "creditReservations"), balances: cellRepository(database, "balances"), integrationAccounts: cellRepository(database, "integrationAccounts"), syncCursors: cellRepository(database, "syncCursors"), integrationJobs: cellRepository(database, "integrationJobs"), exportManifests: cellRepository(database, "exportManifests"), importCheckpoints: cellRepository(database, "importCheckpoints"), federationActors: repository(database, "federationActors"), remotePublicationReferences: repository(database, "remotePublicationReferences"),
});

type JobRow = QueryResultRow & { id: string; cell_id: string; type: string; payload: unknown; idempotency_key: string; state: DurableJob["state"]; attempt: number; max_attempts: number; available_at: Date | string; lease_expires_at?: Date | string; created_at: Date | string; updated_at: Date | string; correlation_id?: string; last_error?: DurableJob["lastError"] };
const date = (value: Date | string): string => value instanceof Date ? value.toISOString() : new Date(value).toISOString();
const jobFromRow = (row: JobRow): DurableJob => ({ id: row.id, cellId: row.cell_id, type: row.type, payload: row.payload, idempotencyKey: row.idempotency_key, state: row.state, attempt: row.attempt, maxAttempts: row.max_attempts, availableAt: date(row.available_at), leaseExpiresAt: row.lease_expires_at ? date(row.lease_expires_at) : undefined, createdAt: date(row.created_at), updatedAt: date(row.updated_at), correlationId: row.correlation_id, lastError: row.last_error });

/** PostgreSQL leases use SKIP LOCKED so horizontally-scaled workers never run one job concurrently. */
export class PostgresJobQueue implements JobQueue, Scheduler {
  constructor(private readonly database: PostgresDatabase) {}
  async enqueue<T>(input: Omit<DurableJob<T>, "id" | "state" | "attempt" | "availableAt" | "createdAt" | "updatedAt"> & { availableAt?: string }): Promise<DurableJob<T>> {
    const id = randomUUID(), now = timestamp();
    const result = await this.database.pool.query<JobRow>("INSERT INTO ubeeq_jobs (id, cell_id, type, payload, idempotency_key, state, attempt, max_attempts, available_at, created_at, updated_at, correlation_id) VALUES ($1, $2, $3, $4::jsonb, $5, 'queued', 0, $6, $7, $8, $8, $9) ON CONFLICT (cell_id, idempotency_key) DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key RETURNING *", [id, input.cellId, input.type, JSON.stringify(input.payload), input.idempotencyKey, input.maxAttempts, input.availableAt ?? now, now, input.correlationId]);
    return jobFromRow(result.rows[0]) as DurableJob<T>;
  }
  async lease<T>(input: { cellId: string; types?: readonly string[]; leaseDurationSeconds: number; workerId: string }): Promise<JobLease<T> | undefined> {
    return this.database.transaction(async (transaction) => {
      const client = (transaction as MachineTransaction).client;
      await client.query("UPDATE ubeeq_jobs SET state = 'retry_scheduled', available_at = NOW(), lease_token = NULL, lease_expires_at = NULL, updated_at = NOW() WHERE cell_id = $1 AND state = 'leased' AND lease_expires_at <= NOW()", [input.cellId]);
      const filters = input.types?.length ? " AND type = ANY($2::text[])" : "";
      const parameters: unknown[] = input.types?.length ? [input.cellId, input.types] : [input.cellId];
      const selected = await client.query<JobRow>(`SELECT * FROM ubeeq_jobs WHERE cell_id = $1 AND state IN ('queued', 'retry_scheduled') AND available_at <= NOW()${filters} ORDER BY available_at, id FOR UPDATE SKIP LOCKED LIMIT 1`, parameters);
      if (!selected.rowCount) return undefined;
      const leaseToken = randomUUID();
      const updated = await client.query<JobRow>("UPDATE ubeeq_jobs SET state = 'leased', attempt = attempt + 1, lease_token = $1, lease_expires_at = NOW() + ($2 * INTERVAL '1 second'), updated_at = NOW() WHERE id = $3 RETURNING *", [leaseToken, input.leaseDurationSeconds, selected.rows[0].id]);
      return { job: jobFromRow(updated.rows[0]) as DurableJob<T>, leaseToken };
    });
  }
  private async transition(input: { id: string; leaseToken: string; state: DurableJob["state"]; error?: { code: string; message: string }; retryAt?: string }): Promise<void> {
    const result = await this.database.pool.query("UPDATE ubeeq_jobs SET state = $1, last_error = $2::jsonb, available_at = COALESCE($3::timestamptz, available_at), lease_token = NULL, lease_expires_at = NULL, updated_at = NOW() WHERE id = $4 AND state = 'leased' AND lease_token = $5", [input.state, input.error ? JSON.stringify(input.error) : null, input.retryAt ?? null, input.id, input.leaseToken]);
    if (result.rowCount !== 1) throw new Error("Job lease is no longer valid.");
  }
  async complete(input: { id: string; leaseToken: string }): Promise<void> { await this.transition({ ...input, state: "completed" }); }
  async retry(input: { id: string; leaseToken: string; error: { code: string; message: string }; retryAt: string }): Promise<void> { await this.transition({ ...input, state: "retry_scheduled" }); }
  async deadLetter(input: { id: string; leaseToken: string; error: { code: string; message: string } }): Promise<void> { await this.transition({ ...input, state: "dead_lettered" }); }
  async cancel(input: { id: string; reason?: string }): Promise<void> { await this.database.pool.query("UPDATE ubeeq_jobs SET state = 'cancelled', last_error = $1::jsonb, updated_at = NOW() WHERE id = $2", [input.reason ? JSON.stringify({ code: "cancelled", message: input.reason }) : null, input.id]); }
  async recover(input: { id: string; availableAt?: string }): Promise<DurableJob> { const result = await this.database.pool.query<JobRow>("UPDATE ubeeq_jobs SET state = 'queued', available_at = COALESCE($1::timestamptz, NOW()), lease_token = NULL, lease_expires_at = NULL, last_error = NULL, updated_at = NOW() WHERE id = $2 RETURNING *", [input.availableAt ?? null, input.id]); if (!result.rowCount) throw new Error("Unknown job."); return jobFromRow(result.rows[0]); }
  async get(id: string): Promise<DurableJob | undefined> { const result = await this.database.pool.query<JobRow>("SELECT * FROM ubeeq_jobs WHERE id = $1", [id]); return result.rows[0] ? jobFromRow(result.rows[0]) : undefined; }
  async list(input: { cellId: string; states?: readonly DurableJob["state"][]; limit: number }): Promise<readonly DurableJob[]> { const query = input.states?.length ? "SELECT * FROM ubeeq_jobs WHERE cell_id = $1 AND state = ANY($2::text[]) ORDER BY created_at DESC, id DESC LIMIT $3" : "SELECT * FROM ubeeq_jobs WHERE cell_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2"; const values = input.states?.length ? [input.cellId, input.states, limit(input.limit)] : [input.cellId, limit(input.limit)]; const result = await this.database.pool.query<JobRow>(query, values); return result.rows.map(jobFromRow); }
  async schedule(input: { cellId: string; type: string; idempotencyKey: string; payload: unknown; runAt: string }): Promise<void> { await this.enqueue({ ...input, maxAttempts: 3, availableAt: input.runAt }); }
  async cancelSchedule(input: { cellId: string; idempotencyKey: string }): Promise<void> { await this.database.pool.query("UPDATE ubeeq_jobs SET state = 'cancelled', updated_at = NOW() WHERE cell_id = $1 AND idempotency_key = $2", [input.cellId, input.idempotencyKey]); }
}

export const createPostgresAdapterSet = async (configuration: PostgresAdapterConfiguration) => {
  const database = new PostgresDatabase(configuration);
  await database.migrate();
  return { database, repositories: createPostgresRepositories(database), jobs: new PostgresJobQueue(database) };
};

export interface S3CompatibleConfiguration {
  endpoint: string;
  region?: string;
  bucket: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle?: boolean;
  /** Omit only for adapter-level storage conformance; deployed cells must set it. */
  cellId?: string;
}

const s3Checksum = (checksum: string): string => /^[a-f0-9]{64}$/i.test(checksum) ? Buffer.from(checksum, "hex").toString("base64") : checksum;
const encodeUpload = (object: StoredObject): string => Buffer.from(JSON.stringify(object)).toString("base64url");
const decodeUpload = (value: string): StoredObject => {
  try {
    const object = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as StoredObject;
    if (!object.bucket || !object.key || !object.contentType || !object.checksum) throw new Error("missing fields");
    return object;
  } catch { throw new Error("S3-compatible upload identifier is invalid."); }
};

/** S3 protocol adapter suitable for MinIO, Ceph RGW, and other compatible regional object stores. */
export class S3CompatibleStorage implements ObjectStorage, UploadAdapter, DeliveryAdapter {
  readonly client: S3Client;
  constructor(readonly configuration: S3CompatibleConfiguration, client?: S3Client) {
    if (!configuration.endpoint.startsWith("http") || !configuration.bucket.trim()) throw new Error("S3-compatible storage requires endpoint and bucket.");
    this.client = client ?? new S3Client({ endpoint: configuration.endpoint, region: configuration.region ?? "us-east-1", forcePathStyle: configuration.forcePathStyle ?? true, credentials: configuration.accessKeyId && configuration.secretAccessKey ? { accessKeyId: configuration.accessKeyId, secretAccessKey: configuration.secretAccessKey } : undefined });
  }
  private local(key: string): void { if (this.configuration.cellId) requireCellScopedObject(key, this.configuration.cellId); }
  async put(input: { object: StoredObject; body: Uint8Array }): Promise<void> {
    this.local(input.object.key);
    await this.client.send(new PutObjectCommand({ Bucket: this.configuration.bucket, Key: input.object.key, Body: input.body, ContentType: input.object.contentType, Metadata: { scope: input.object.scope, ...(input.object.checksum ? { checksum: input.object.checksum } : {}), byteLength: String(input.object.byteLength) } }));
  }
  async get(input: Pick<StoredObject, "bucket" | "key" | "versionId">): Promise<{ object: StoredObject; body: Uint8Array }> {
    this.local(input.key);
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.configuration.bucket, Key: input.key, VersionId: input.versionId }));
    const body = new Uint8Array(await response.Body!.transformToByteArray());
    return { object: { bucket: this.configuration.bucket, key: input.key, versionId: response.VersionId, contentType: response.ContentType ?? "application/octet-stream", byteLength: body.byteLength, checksum: response.Metadata?.checksum, scope: (response.Metadata?.scope as StoredObject["scope"]) ?? "private" }, body };
  }
  async remove(input: Pick<StoredObject, "bucket" | "key" | "versionId">): Promise<void> { this.local(input.key); await this.client.send(new DeleteObjectCommand({ Bucket: this.configuration.bucket, Key: input.key, VersionId: input.versionId })); }
  async initiate(input: { object: StoredObject; checksumAlgorithm: "sha256"; multipart?: boolean; expiresAt: string }): Promise<UploadInitiation> {
    if (input.multipart) throw new Error("Multipart S3-compatible uploads require a multipart adapter.");
    this.local(input.object.key);
    const checksum = input.object.checksum;
    if (!checksum) throw new Error("S3-compatible direct uploads require a SHA-256 checksum before initiation.");
    if (Date.parse(input.expiresAt) <= Date.now()) throw new Error("S3-compatible upload expiry must be in the future.");
    const object = { ...input.object, bucket: this.configuration.bucket };
    const expiresIn = Math.max(1, Math.min(900, Math.floor((Date.parse(input.expiresAt) - Date.now()) / 1_000)));
    const signedObject = { ...object, checksum };
    const url = await getSignedUrl(this.client, new PutObjectCommand({ Bucket: this.configuration.bucket, Key: signedObject.key, ContentType: signedObject.contentType, ChecksumSHA256: s3Checksum(checksum), Metadata: { checksum, scope: signedObject.scope, byteLength: String(signedObject.byteLength) } }), { expiresIn, unhoistableHeaders: new Set(["x-amz-checksum-sha256", "x-amz-meta-checksum", "x-amz-meta-scope", "x-amz-meta-bytelength"]) });
    return { uploadId: encodeUpload(signedObject), object: signedObject, parts: [{ partNumber: 1, url, expiresAt: input.expiresAt }], expiresAt: input.expiresAt };
  }
  async complete(input: UploadCompletion): Promise<StoredObject> {
    const object = decodeUpload(input.uploadId);
    this.local(object.key); requireCreatorScopedObject(object.key, input);
    const response = await this.client.send(new HeadObjectCommand({ Bucket: this.configuration.bucket, Key: object.key }));
    if (!response.VersionId || response.ContentLength !== input.byteLength || response.Metadata?.checksum !== input.checksum || (response.ChecksumSHA256 && response.ChecksumSHA256 !== s3Checksum(input.checksum))) throw new Error("S3-compatible upload completion did not match the signed object checksum, size, or version.");
    return { ...object, versionId: response.VersionId, contentType: response.ContentType ?? object.contentType, byteLength: response.ContentLength, checksum: input.checksum, scope: (response.Metadata?.scope as StoredObject["scope"]) ?? object.scope };
  }
  async abort(_input: { uploadId: string; cellId: string; creatorId: string }): Promise<void> { /* A signed single-part PUT has no server-side session to abort. */ }
  async issue(input: Parameters<DeliveryAdapter["issue"]>[0]): Promise<{ url: string; expiresAt: string }> {
    this.local(input.object.key);
    const expiresIn = Math.max(1, Math.min(7 * 24 * 60 * 60, Math.floor((Date.parse(input.expiresAt) - Date.now()) / 1_000)));
    return { url: await getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.configuration.bucket, Key: input.object.key, VersionId: input.object.versionId, ResponseContentDisposition: input.disposition === "attachment" ? "attachment" : undefined }), { expiresIn }), expiresAt: input.expiresAt };
  }
}
