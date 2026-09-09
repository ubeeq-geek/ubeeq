import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalSmugMugInventoryRunner, LocalSqliteDatabase } from '../dist/index.js';
import { InMemorySmugMugRepository, SmugMugIntegrationService } from '@ubeeq/integrations';

const fixture = t => {
  const directory = mkdtempSync(join(tmpdir(), 'ubeeq-inventory-runner-'));
  const databases = new Set();
  t.after(() => { for (const db of databases) db.database.close(); rmSync(directory, { recursive: true, force: true }); });
  const close = db => { db.database.close(); databases.delete(db); };
  const compose = async (inventory, options, admit = async () => true) => {
    const repository = new InMemorySmugMugRepository();
    const state = join(directory, 'source.json');
    if (existsSync(state)) repository.restoreState(JSON.parse(readFileSync(state, 'utf8')));
    else await repository.putConnection({ id: 'connection', userId: 'owner', creatorId: 'creator', state: 'CONNECTED', accountId: 'account', encryptedCredentialRef: 'opaque-ref', oauthState: 'state', createdAt: 'now', updatedAt: 'now' });
    const checkpoint = () => writeFileSync(state, JSON.stringify(repository.captureState()));
    const service = new SmugMugIntegrationService({ inventory }, {}, repository, undefined, admit);
    const database = new LocalSqliteDatabase({ databasePath: join(directory, 'jobs.sqlite'), dataDirectory: directory, cellId: 'cell', publicBaseUrl: 'http://localhost' });
    databases.add(database);
    return { database, repository, service, checkpoint, runner: new LocalSmugMugInventoryRunner(database, service, checkpoint, 'cell', options) };
  };
  return { compose, close };
};

test('shared runner persists page chains across restart without spending healthy page retry budgets', async t => {
  const f = fixture(t); let calls = 0;
  const inventory = async (_ref, cursor) => { calls++; const page = Number(cursor || 0); return { images: [], collections: [], ...(page < 4 ? { nextCursor: String(page + 1) } : {}) }; };
  const first = await f.compose(inventory);
  const run = await first.runner.start('connection', 'owner', 'request');
  assert.equal(calls, 0); assert.equal(run.state, 'queued');
  assert.equal((await first.runner.start('connection', 'owner', 'request')).id, run.id);
  await first.runner.runOne(); f.close(first.database);
  const restored = await f.compose(inventory);
  assert.equal((await restored.runner.inspect(run.id, 'owner')).page, 1);
  for (let page = 0; page < 4; page++) assert.equal(await restored.runner.runOne(), true);
  const result = await restored.runner.inspect(run.id, 'owner');
  assert.equal(result.state, 'completed'); assert.equal(result.complete, true); assert.equal(result.attempt, 1);
  assert.equal(result.page, 4); assert.equal(calls, 5); assert.equal(restored.repository.migrations.size, 1);
  assert.equal(await restored.runner.runOne(), false);
});

test('custom compatibility names preserve runs and recover failed result commits using the source receipt', async t => {
  const f = fixture(t); let calls = 0;
  const inventory = async () => { calls++; return { images: [], collections: [] }; };
  const options = { tableName: 'legacy_inventory_runs', jobType: 'legacy.inventory.page' };
  const first = await f.compose(inventory, options), run = await first.runner.start('connection', 'owner', 'request');
  first.database.database.exec("CREATE TRIGGER reject_result BEFORE UPDATE ON legacy_inventory_runs WHEN json_extract(NEW.payload, '$.migrationId') IS NOT NULL BEGIN SELECT RAISE(ABORT, 'fixture'); END");
  await first.runner.runOne();
  const failed = await first.runner.inspect(run.id, 'owner');
  assert.equal(failed.state, 'retry_scheduled'); assert.equal(failed.complete, false);
  first.database.database.exec('DROP TRIGGER reject_result'); f.close(first.database);
  const restored = await f.compose(inventory, options);
  await restored.runner.recover(run.id, 'owner'); await restored.runner.runOne();
  assert.equal((await restored.runner.inspect(run.id, 'owner')).complete, true);
  assert.equal(calls, 1); assert.equal(restored.repository.migrations.size, 1);
});

test('shared runner rejects unsafe identifiers and rechecks owner admission before provider work', async t => {
  const f = fixture(t); let allowed = true, calls = 0;
  const value = await f.compose(async () => { calls++; return { images: [], collections: [] }; }, undefined, async () => allowed);
  for (const options of [{ tableName: 'runs; DROP TABLE ubeeq_jobs' }, { tableName: 'main.runs' }, { tableName: '' }, { tableName: { toString: () => 'runs' } }, { jobType: 123 }, { jobType: '' }, { jobType: 'type with spaces' }]) {
    assert.throws(() => new LocalSmugMugInventoryRunner(value.database, value.service, value.checkpoint, 'cell', options), /Invalid inventory/);
  }
  const run = await value.runner.start('connection', 'owner', 'request');
  await assert.rejects(value.runner.inspect(run.id, 'other'), { code: 'INVENTORY_RUN_NOT_FOUND' });
  allowed = false; await value.runner.runOne(); assert.equal(calls, 0);
  allowed = true;
  const result = await value.runner.inspect(run.id, 'owner');
  assert.equal(result.state, 'dead_lettered'); assert.equal(result.errorCode, 'CREATOR_FORBIDDEN');
  assert.doesNotMatch(JSON.stringify(result), /opaque-ref|oauthState|userId/);
});
