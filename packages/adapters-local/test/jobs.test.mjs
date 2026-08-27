import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalAdapterSet } from "../dist/index.js";

test("SQLite jobs retain idempotency and support retry, recovery, and cancellation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ubeeq-local-jobs-"));
  try {
    const { jobs } = createLocalAdapterSet({ databasePath: join(directory, "state.sqlite"), dataDirectory: directory, publicBaseUrl: "http://127.0.0.1:4100" });
    const created = await jobs.enqueue({ type: "asset.process", payload: { assetId: "asset-1" }, idempotencyKey: "asset-1:v1", maxAttempts: 3 });
    assert.equal((await jobs.enqueue({ type: "asset.process", payload: { assetId: "asset-1" }, idempotencyKey: "asset-1:v1", maxAttempts: 3 })).id, created.id);
    const lease = await jobs.lease({ types: ["asset.process"], leaseDurationSeconds: 60, workerId: "test-worker" });
    assert.ok(lease);
    await jobs.retry({ id: created.id, leaseToken: lease.leaseToken, error: { code: "temporary", message: "retry me" }, retryAt: new Date(Date.now() - 1_000).toISOString() });
    assert.equal((await jobs.get(created.id))?.state, "retry_scheduled");
    const recovered = await jobs.recover({ id: created.id });
    assert.equal(recovered.state, "queued");
    await jobs.cancel({ id: created.id, reason: "manual recovery test" });
    assert.equal((await jobs.get(created.id))?.state, "cancelled");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
