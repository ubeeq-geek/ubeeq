import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PostgresDatabase, PostgresJobQueue, PostgresPasswordIdentity, S3CompatibleStorage, createPostgresRepositories } from "../dist/index.js";
import { verifyCellScopedRepositoryContract, verifyRevisionedRepositoryContract } from "@ubeeq/persistence";
import { verifyJobQueueContract } from "@ubeeq/jobs";
import { verifyObjectStorageContract } from "@ubeeq/storage";
import { verifyPasswordIdentityContract } from "@ubeeq/auth";

const connectionString = process.env.UBEEQ_POSTGRES_TEST_URL;

test('PostgreSQL acknowledgements condition retry budgets and lease expiry in one write', async () => {
  const calls = []; let rowCount = 1;
  const queue = new PostgresJobQueue({ pool: { query: async (sql, parameters) => { calls.push({ sql, parameters }); return { rowCount }; } } });
  const input = { id: 'job', leaseToken: 'lease', error: { code: 'temporary', message: 'retry' }, retryAt: '2026-01-01T00:00:00.000Z' };
  await queue.retry(input);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /CASE WHEN \$1 = 'retry_scheduled' AND attempt >= max_attempts THEN 'dead_lettered' ELSE \$1 END/);
  assert.match(calls[0].sql, /AND state = 'leased' AND lease_token = \$5 AND lease_expires_at > NOW\(\)/);
  assert.deepEqual(calls[0].parameters, ['retry_scheduled', JSON.stringify(input.error), input.retryAt, input.id, input.leaseToken]);
  rowCount = 0;
  for (const method of ['retry', 'complete', 'deadLetter']) await assert.rejects(queue[method](input), /no longer valid/);
  assert.equal(calls.length, 4);
});

test("PostgreSQL repositories and queue satisfy shared durable contracts", { skip: !connectionString }, async () => {
  const database = new PostgresDatabase({ connectionString, cellId: "cell-a", applicationName: "ubeeq-machine-contract" });
  await database.migrate();
  const repositories = createPostgresRepositories(database);
  try {
    await database.pool.query("TRUNCATE ubeeq_idempotency, ubeeq_records, ubeeq_jobs, ubeeq_sessions, ubeeq_accounts CASCADE");
    for (const [name, repository] of Object.entries(repositories).filter(([name]) => name !== "transaction")) {
      await verifyRevisionedRepositoryContract({ repository, createRecord: (id) => ({ id, instanceId: "machine", homeCellId: "cell-a", dataHomeRegion: "test", dataHomeAssignedAt: "2026-01-01T00:00:00.000Z", routingRevision: 1, contractValue: name }), change: () => ({ contractValue: `${name}-updated` }) });
      if (name !== "federationActors" && name !== "remotePublicationReferences") await verifyCellScopedRepositoryContract({ repository, unscopedRepository: repository.repository, cellId: "cell-a" });
    }
    await verifyJobQueueContract(new PostgresJobQueue(database), `postgres-contract-${randomUUID()}`);
    await verifyPasswordIdentityContract(new PostgresPasswordIdentity(database));
  } finally { await database.close(); }
});

test("S3-compatible object storage satisfies the shared storage and cell-boundary contracts", async () => {
  const values = new Map();
  const client = { send: async (command) => {
    const input = command.input;
    if (command.constructor.name === "PutObjectCommand") { values.set(input.Key, input); return {}; }
    if (command.constructor.name === "GetObjectCommand") { const value = values.get(input.Key); if (!value) throw new Error("NoSuchKey"); return { VersionId: "v1", ContentType: value.ContentType, Metadata: value.Metadata, Body: { transformToByteArray: async () => value.Body } }; }
    if (command.constructor.name === "DeleteObjectCommand") { values.delete(input.Key); return {}; }
    throw new Error(`Unexpected command ${command.constructor.name}`);
  } };
  const storage = new S3CompatibleStorage({ endpoint: "http://minio.invalid", bucket: "objects" }, client);
  await verifyObjectStorageContract(storage);
  const scoped = new S3CompatibleStorage({ endpoint: "http://minio.invalid", bucket: "objects", cellId: "cell-a" }, client);
  await assert.rejects(() => scoped.put({ object: { bucket: "objects", key: "cells/cell-b/creators/creator-b/originals/file", contentType: "image/png", byteLength: 1, scope: "private" }, body: Buffer.from("x") }), /cell-a/);
});
