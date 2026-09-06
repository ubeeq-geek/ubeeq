import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { LocalSqliteDatabase, LocalSqliteJobQueue } from "../dist/index.js";

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
