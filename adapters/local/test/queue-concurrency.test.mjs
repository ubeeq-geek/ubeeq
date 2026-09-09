import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { LocalSqliteDatabase, LocalSqliteJobQueue } from "../dist/index.js";

test('reported failures exhaust their budget across restarts without reviving stale leases', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ubeeq-retry-budget-'));
  const config = { databasePath: join(directory, 'state.sqlite'), dataDirectory: directory, cellId: 'cell', publicBaseUrl: 'http://localhost' };
  let local = new LocalSqliteDatabase(config);
  try {
    let queue = new LocalSqliteJobQueue(local);
    const job = await queue.enqueue({ cellId: 'cell', type: 'process', payload: {}, idempotencyKey: 'bounded', maxAttempts: 2 });
    const claim = () => queue.lease({ cellId: 'cell', leaseDurationSeconds: 60, workerId: 'worker' });
    const first = await claim();
    const error = { code: 'provider_unavailable', message: 'Temporary failure' };
    const retryAt = new Date(Date.now() - 1_000).toISOString();
    await queue.retry({ id: job.id, leaseToken: first.leaseToken, error, retryAt });
    assert.equal((await queue.get(job.id)).state, 'retry_scheduled');
    local.database.close(); local = new LocalSqliteDatabase(config); queue = new LocalSqliteJobQueue(local);
    const second = await claim();
    assert.equal(second.job.attempt, 2);
    await assert.rejects(queue.retry({ id: job.id, leaseToken: first.leaseToken, error, retryAt }), /no longer valid/);
    assert.equal((await queue.get(job.id)).state, 'leased');
    await queue.retry({ id: job.id, leaseToken: second.leaseToken, error, retryAt: '2099-01-01T00:00:00.000Z' });
    const exhausted = await queue.get(job.id);
    assert.equal(exhausted.state, 'dead_lettered');
    assert.equal(exhausted.attempt, 2); assert.equal(exhausted.availableAt, retryAt);
    assert.equal(exhausted.leaseExpiresAt, undefined); assert.deepEqual(exhausted.lastError, error);
    await assert.rejects(queue.complete({ id: job.id, leaseToken: second.leaseToken }), /no longer valid/);
    local.database.close(); local = new LocalSqliteDatabase(config); queue = new LocalSqliteJobQueue(local);
    assert.equal(await claim(), undefined); assert.deepEqual(await queue.get(job.id), exhausted);
    // Recovery remains an explicit caller decision, not an automatic budget reset.
    await queue.recover({ id: job.id });
    const manual = await claim(); assert.equal(manual.job.attempt, 3);
    await queue.retry({ id: job.id, leaseToken: manual.leaseToken, error, retryAt });
    assert.equal((await queue.get(job.id)).state, 'dead_lettered');
  } finally { local.database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("independent worker connections enqueue once and atomically claim one job", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "ubeeq-queue-race-"));
  const config = { databasePath: join(directory, "state.sqlite"), dataDirectory: directory, cellId: "cell", publicBaseUrl: "http://localhost" };
  const local = new LocalSqliteDatabase(config);
  const gate = new SharedArrayBuffer(4), workers = [];
  context.after(async () => { await Promise.all(workers.map((worker) => worker.terminate())); local.database.close(); rmSync(directory, { recursive: true, force: true }); });
  let ready = 0;
  const results = await Promise.all(Array.from({ length: 6 }, () => new Promise((resolve, reject) => {
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      (async () => {
        const { LocalSqliteDatabase, LocalSqliteJobQueue } = await import(workerData.module);
        const local = new LocalSqliteDatabase(workerData.config);
        try {
          const queue = new LocalSqliteJobQueue(local);
          parentPort.postMessage({ ready: true });
          Atomics.wait(new Int32Array(workerData.gate), 0, 0);
          const job = await queue.enqueue({ cellId: 'cell', type: 'process', payload: {}, idempotencyKey: 'same', maxAttempts: 3 });
          const lease = await queue.lease({ cellId: 'cell', types: ['process'], leaseDurationSeconds: 60, workerId: 'worker' });
          parentPort.postMessage({ id: job.id, leased: Boolean(lease) });
        } finally { local.database.close(); }
      })().catch(error => { throw error; });
    `, { eval: true, workerData: { module: new URL("../dist/index.js", import.meta.url).href, config, gate } });
    workers.push(worker);
    worker.on("error", reject);
    worker.on("message", (message) => {
      if (message.ready) {
        if (++ready === 6) { Atomics.store(new Int32Array(gate), 0, 1); Atomics.notify(new Int32Array(gate), 0); }
      } else resolve(message);
    });
  })));
  assert.equal(new Set(results.map((result) => result.id)).size, 1);
  assert.equal(results.filter((result) => result.leased).length, 1);
  assert.equal((await new LocalSqliteJobQueue(local).get(results[0].id)).attempt, 1);
});

test("expired leases are cell-scoped, fenced and eventually dead-lettered", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ubeeq-queue-expiry-"));
  const local = new LocalSqliteDatabase({ databasePath: join(directory, "state.sqlite"), dataDirectory: directory, cellId: "cell", publicBaseUrl: "http://localhost" });
  try {
    const queue = new LocalSqliteJobQueue(local);
    const make = (cellId) => queue.enqueue({ cellId, type: "process", payload: {}, idempotencyKey: "job", maxAttempts: 2 });
    const job = await make("cell"), foreign = await make("foreign");
    const lease = (cellId) => queue.lease({ cellId, leaseDurationSeconds: 60, workerId: "worker" });
    const first = await lease("cell"); await lease("foreign");
    local.database.prepare("UPDATE ubeeq_jobs SET lease_expires_at = '2000-01-01T00:00:00Z'").run();
    await assert.rejects(queue.complete({ id: job.id, leaseToken: first.leaseToken }), /no longer valid/);
    const second = await lease("cell");
    assert.equal(second.job.attempt, 2);
    assert.equal((await queue.get(foreign.id)).state, "leased");
    await assert.rejects(queue.retry({ id: job.id, leaseToken: first.leaseToken, error: { code: "old", message: "old" }, retryAt: new Date().toISOString() }), /no longer valid/);
    local.database.prepare("UPDATE ubeeq_jobs SET lease_expires_at = '2000-01-01T00:00:00Z' WHERE id = ?").run(job.id);
    assert.equal(await lease("cell"), undefined);
    assert.equal((await queue.get(job.id)).state, "dead_lettered");
    assert.equal((await queue.get(job.id)).lastError.code, "lease_attempts_exhausted");
    await assert.rejects(queue.lease({ cellId: "cell", leaseDurationSeconds: 0, workerId: "worker" }), /positive integer/);
  } finally { local.database.close(); rmSync(directory, { recursive: true, force: true }); }
});
