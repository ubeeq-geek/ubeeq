import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalAdapterSet } from "../dist/index.js";
import { verifyJobQueueContract } from "@ubeeq/jobs";
import { signFederationEnvelope, verifyFederationEnvelope } from "@ubeeq/federation";

test("SQLite jobs retain idempotency and support retry, recovery, and cancellation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ubeeq-local-jobs-"));
  try {
    const { jobs } = createLocalAdapterSet({ databasePath: join(directory, "state.sqlite"), dataDirectory: directory, publicBaseUrl: "http://127.0.0.1:4100", cellId: "cell-a" });
    const created = await jobs.enqueue({ cellId: "cell-a", type: "asset.process", payload: { assetId: "asset-1" }, idempotencyKey: "asset-1:v1", maxAttempts: 3 });
    assert.equal((await jobs.enqueue({ cellId: "cell-a", type: "asset.process", payload: { assetId: "asset-1" }, idempotencyKey: "asset-1:v1", maxAttempts: 3 })).id, created.id);
    const otherCell = await jobs.enqueue({ cellId: "cell-b", type: "asset.process", payload: { assetId: "asset-1" }, idempotencyKey: "asset-1:v1", maxAttempts: 3 });
    assert.notEqual(otherCell.id, created.id);
    assert.equal(await jobs.lease({ cellId: "cell-b", types: ["asset.process"], leaseDurationSeconds: 60, workerId: "foreign-worker" }), undefined);
    const lease = await jobs.lease({ cellId: "cell-a", types: ["asset.process"], leaseDurationSeconds: 60, workerId: "test-worker" });
    assert.ok(lease);
    await jobs.retry({ id: created.id, leaseToken: lease.leaseToken, error: { code: "temporary", message: "retry me" }, retryAt: new Date(Date.now() - 1_000).toISOString() });
    assert.equal((await jobs.get(created.id))?.state, "retry_scheduled");
    const recovered = await jobs.recover({ id: created.id });
    assert.equal(recovered.state, "queued");
    await jobs.cancel({ id: created.id, reason: "manual recovery test" });
    assert.equal((await jobs.get(created.id))?.state, "cancelled");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("SQLite job queue satisfies the shared durable queue contract", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ubeeq-local-job-contract-"));
  try { await verifyJobQueueContract(createLocalAdapterSet({ databasePath: join(directory, "state.sqlite"), dataDirectory: directory, publicBaseUrl: "http://127.0.0.1:4100", cellId: "cell-a" }).jobs); }
  finally { rmSync(directory, { recursive: true, force: true }); }
});

test("local credential vault returns only opaque encrypted references and honors revocation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ubeeq-local-vault-"));
  try {
    const { credentials } = createLocalAdapterSet({ databasePath: join(directory, "state.sqlite"), dataDirectory: directory, publicBaseUrl: "http://127.0.0.1:4100", cellId: "cell-a", credentialEncryptionKey: "test-only-key" });
    const stored = await credentials.write({ cellId: "cell-a", ownerId: "creator-1", value: Buffer.from("not-exported-token") });
    assert.match(stored.reference, /^local-vault:/);
    assert.deepEqual(Buffer.from(await credentials.read({ cellId: "cell-a", reference: stored.reference })), Buffer.from("not-exported-token"));
    assert.equal(await credentials.read({ cellId: "cell-b", reference: stored.reference }), undefined);
    await credentials.revoke({ cellId: "cell-a", reference: stored.reference });
    assert.equal(await credentials.read({ cellId: "cell-a", reference: stored.reference }), undefined);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("local federation key signs messages and retains replay protection", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ubeeq-local-federation-"));
  try {
    const { federation } = createLocalAdapterSet({ databasePath: join(directory, "state.sqlite"), dataDirectory: directory, publicBaseUrl: "http://127.0.0.1:4100", cellId: "cell-a" });
    const envelope = await signFederationEnvelope({ id: "delivery", issuedAt: "2026-01-01T00:00:00.000Z", expiresAt: "2027-01-01T00:00:00.000Z", payload: { reference: "remote" } }, federation);
    await verifyFederationEnvelope(envelope, federation, federation, new Date("2026-02-01T00:00:00.000Z"));
    await assert.rejects(() => verifyFederationEnvelope(envelope, federation, federation, new Date("2026-02-01T00:00:00.000Z")), /already delivered/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
