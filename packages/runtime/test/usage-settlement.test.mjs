import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createLocalAdapterSet } from '@ubeeq/adapter-local';
import { createDefaultOpenCorePorts } from '@ubeeq/extension-sdk';
import { createCoreRuntime } from '../dist/index.js';
import { UsageSettlementOutbox } from '../dist/usage-settlement-outbox.js';
const cellId = 'cell', instanceId = 'instance', creatorId = 'creator';
const home = { homeCellId: cellId, dataHomeRegion: 'local', dataHomeAssignedAt: new Date().toISOString(), routingRevision: 1 };
function quotaFixture() {
  const reservations = new Map(), settlements = new Map();
  return { reservations, settlements, consumed: 0, fault: '',
    async checkAndReserveQuota(input) { const previous = reservations.get(input.idempotencyKey); if (previous) assert.deepEqual(input, previous); else reservations.set(input.idempotencyKey, structuredClone(input)); return { allowed: true, reservationId: input.idempotencyKey }; },
    async recordUsageSettlement(input) {
      if (this.fault === 'before') throw new Error('Quota unavailable');
      if (settlements.has(input.idempotencyKey)) { assert.deepEqual(input, settlements.get(input.idempotencyKey)); return; }
      assert.ok(reservations.has(input.idempotencyKey)); settlements.set(input.idempotencyKey, structuredClone(input)); this.consumed += input.processingCreditsUsed ?? 0;
      if (this.fault === 'after') throw new Error('Provider reply lost after commit');
    },
  };
}
async function fixture(t, quota = quotaFixture()) {
  const directory = await mkdtemp(join(tmpdir(), 'usage-outbox-'));
  let local, runtime, processCalls = 0, failProcessing = false, pause;
  const start = () => {
    local = createLocalAdapterSet({ databasePath: join(directory, 'core.sqlite'), dataDirectory: directory, publicBaseUrl: 'http://localhost', cellId });
    runtime = createCoreRuntime({ adapters: { repositories: local.repositories, storage: local.storage, uploads: local.storage, delivery: local.storage, jobs: local.jobs, identity: local.identity, localIdentity: local.identity }, instanceId, cellId, publicBaseUrl: 'http://localhost', operatorAuthorization: { anyRoles: ['creator'] }, hostPorts: createDefaultOpenCorePorts({ usageQuota: quota }), mediaProcessor: { async process() { processCalls++; if (failProcessing) throw new Error('Processor unavailable'); if (pause) await pause; return { metadata: { actual: true }, renditions: [], measuredUnits: 1 }; } } });
  };
  start();
  const stop = async () => { await runtime.close(); local.database.close(); };
  t.after(async () => { await stop(); await rm(directory, { recursive: true, force: true }); });
  const source = Buffer.from('Actual source bytes'), checksum = createHash('sha256').update(source).digest('hex');
  const storage = { bucket: 'local', key: 'cells/cell/creators/creator/source/asset', versionId: 'v1', contentType: 'text/plain', byteLength: source.length, checksum, scope: 'private' };
  await local.storage.put({ object: storage, body: source });
  await local.repositories.assets.create({ id: 'asset', instanceId, creatorId, mimeType: 'text/plain', checksum, objectVersion: 'v1', status: 'pending', storage, ...home });
  const job = await local.jobs.enqueue({ cellId, type: 'asset.process', payload: { assetId: 'asset' }, idempotencyKey: 'asset-job', maxAttempts: 1 });
  return { quota, job, get local() { return local; }, get runtime() { return runtime; }, get processCalls() { return processCalls; }, failProcessing(value) { failProcessing = value; }, pauseProcessing(value) { pause = value; }, restart: async () => { await stop(); start(); } };
}
test('completed asset and durable usage intent survive quota outage and process restart without repeated processing', async t => {
  const f = await fixture(t); f.quota.fault = 'before';
  await f.runtime.runNextJob('worker');
  assert.equal((await f.local.repositories.assets.get('asset')).status, 'ready');
  assert.equal((await f.local.jobs.get(f.job.id)).state, 'completed');
  assert.equal(f.quota.consumed, 0);
  const pending = (await f.local.repositories.hostRecords.list({ limit: 100 })).items.filter(row => row.namespace === 'runtime-usage-settlement');
  assert.equal(pending.length, 1); assert.equal(pending[0].value.state, 'pending'); assert.equal(pending[0].value.input.processingCreditsUsed, 1);
  await f.restart(); f.quota.fault = '';
  await f.runtime.runNextJob('restarted-worker'); await f.runtime.runNextJob('replay-worker');
  assert.equal(f.processCalls, 1); assert.equal(f.quota.consumed, 1);
  assert.equal((await f.local.repositories.hostRecords.get(pending[0].id)).value.state, 'settled');
});
test('lost settlement response never refunds a completed effect or double charges on replay', async t => {
  const f = await fixture(t); f.quota.fault = 'after';
  await f.runtime.runNextJob('worker');
  assert.equal(f.quota.consumed, 1);
  await f.restart(); f.quota.fault = '';
  await f.runtime.runNextJob('restarted-worker');
  assert.equal(f.quota.consumed, 1); assert.equal(f.processCalls, 1);
  assert.deepEqual([...f.quota.settlements.values()].map(input => input.processingCreditsUsed), [1]);
});
test('terminal processing failure atomically marks the asset failed and queues an independently recoverable release', async t => {
  const f = await fixture(t); f.failProcessing(true); f.quota.fault = 'before';
  await assert.rejects(() => f.runtime.runNextJob('worker'), /Processor unavailable/);
  assert.equal((await f.local.repositories.assets.get('asset')).status, 'failed');
  assert.equal((await f.local.jobs.get(f.job.id)).state, 'dead_lettered');
  const pending = (await f.local.repositories.hostRecords.list({ limit: 100 })).items.find(row => row.namespace === 'runtime-usage-settlement');
  assert.equal(pending.value.input.processingCreditsUsed, 0);
  await f.restart(); f.quota.fault = '';
  await f.runtime.runNextJob('recovery-worker');
  assert.equal(f.quota.consumed, 0); assert.equal(f.quota.settlements.size, 1);
  assert.equal((await f.local.repositories.hostRecords.get(pending.id)).value.state, 'settled');
});
test('crash-exhausted final leases recover reservations after restart even without a processor catch block', async t => {
  const f = await fixture(t), lease = await f.local.jobs.lease({ cellId, types: ['asset.process'], leaseDurationSeconds: 60, workerId: 'crashed-worker' });
  const asset = await f.local.repositories.assets.get('asset'), key = 'asset-processing:asset:v1', input = { creatorId, operation: 'asset.process', processingCreditsDelta: 1, idempotencyKey: key };
  const outbox = new UsageSettlementOutbox(f.local.repositories, f.quota, instanceId, cellId);
  await outbox.trackReservation(input, asset, lease.job);
  await f.quota.checkAndReserveQuota(input);
  await f.local.repositories.assets.update(asset.id, asset.revision, { status: 'processing' });
  f.local.database.database.prepare('UPDATE ubeeq_jobs SET lease_expires_at=? WHERE id=?').run('2000-01-01T00:00:00.000Z', f.job.id);
  await f.restart();
  // Queue lease maintenance first records exhaustion; the following turn reconciles its journal.
  await f.runtime.runNextJob('restarted-worker'); await f.runtime.runNextJob('recovery-worker');
  assert.equal((await f.local.jobs.get(f.job.id)).state, 'dead_lettered');
  assert.equal((await f.local.repositories.assets.get('asset')).status, 'failed');
  assert.equal(f.processCalls, 0);
  assert.ok(f.quota.settlements.get(key), JSON.stringify({ records: (await f.local.repositories.hostRecords.list({ limit: 100 })).items, audit: (await f.local.repositories.auditEvents.list({ limit: 100 })).items }));
  assert.equal(f.quota.settlements.get(key).processingCreditsUsed, 0);
});
test('explicit HTTP recovery uses a new reservation generation after a terminal release', async t => {
  const f = await fixture(t); f.failProcessing(true);
  await assert.rejects(() => f.runtime.runNextJob('worker'), /Processor unavailable/);
  assert.equal([...f.quota.settlements.values()][0].processingCreditsUsed, 0);
  await f.local.identity.register({ email: 'operator@example.test', password: 'Disposable long password 123!' });
  const { token } = await f.local.identity.authenticate({ email: 'operator@example.test', password: 'Disposable long password 123!' });
  await new Promise(resolve => f.runtime.server.listen(0, '127.0.0.1', resolve));
  const response = await fetch(`http://127.0.0.1:${f.runtime.server.address().port}/v1/operations/jobs/${f.job.id}/recover`, { method: 'POST', headers: { authorization: 'Bearer ' + token } });
  assert.equal(response.status, 200);
  const asset = await f.local.repositories.assets.get('asset');
  assert.equal(asset.status, 'pending'); assert.match(asset.processingUsageKey, /:recovery:/);
  f.failProcessing(false); await f.runtime.runNextJob('recovered-worker');
  assert.equal((await f.local.repositories.assets.get('asset')).status, 'ready');
  assert.equal(f.quota.consumed, 1); assert.equal(f.quota.settlements.size, 2);
  assert.deepEqual([...f.quota.settlements.values()].map(input => input.processingCreditsUsed).sort(), [0, 1]);
});
test('cancellation waits for the lease deadline and prevents an old processor from committing after release', async t => {
  const f = await fixture(t); let resume;
  f.pauseProcessing(new Promise(resolve => { resume = resolve; }));
  t.after(() => resume());
  const processing = f.runtime.runNextJob('old-worker').then(() => undefined, error => error);
  for (let i = 0; i < 100 && f.processCalls === 0; i++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(f.processCalls, 1);
  await f.local.jobs.cancel({ id: f.job.id });
  await f.runtime.runNextJob('new-worker');
  assert.equal(f.quota.settlements.size, 0, 'a currently executing lease retains its reservation');
  const journal = (await f.local.repositories.hostRecords.list({ limit: 100 })).items.find(row => row.namespace === 'runtime-processing-reservation');
  await f.local.repositories.hostRecords.update(journal.id, journal.revision, { value: { ...journal.value, leaseExpiresAt: '2000-01-01T00:00:00.000Z' } });
  await f.runtime.runNextJob('expired-worker');
  assert.equal(f.quota.settlements.size, 1); assert.equal(f.quota.consumed, 0);
  resume(); assert.ok(await processing instanceof Error);
  assert.equal((await f.local.repositories.assets.get('asset')).status, 'failed');
  assert.equal(f.quota.consumed, 0, 'a stale processing revision cannot become a free ready asset');
});
