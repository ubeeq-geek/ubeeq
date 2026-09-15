import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalSqliteDatabase, LocalActivityWorkflowStore } from '../dist/index.js';
const event = (id, extra = {}) => ({ id, creatorId: 'creator', platform: 'native', sourceAt: '2026-09-15T12:00:00Z', kind: 'favorite_count', count: 5, previousCount: 4, ...extra });
test('durable activity: idempotent ingestion, restart, scope, keysets and atomic batches', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ubeeq-activity-'));
  const config = { databasePath: join(dir, 'state.sqlite'), dataDirectory: dir, cellId: 'cell', publicBaseUrl: 'http://localhost' };
  let local = new LocalSqliteDatabase(config);
  try {
    let store = new LocalActivityWorkflowStore(local, 'instance');
    const selection = { creators: ['creator'], platforms: ['native'] };
    await store.append(event('first')); await store.append(event('first')); await store.append(event('second'));
    await new LocalActivityWorkflowStore(local, 'foreign').append(event('foreign'));
    const page = await store.page(selection, 0, 1); assert.equal(page[0].id, 'first');
    assert.deepEqual((await store.page(selection, page[0].sequence, 10)).map(e => e.id), ['second']);
    assert.equal(await store.commit([{ key: 'profile', revision: null, value: { checkpoint: 2 } }, { key: 'outbox:one', revision: null, value: { status: 'pending' } }]), true);
    assert.equal(await store.commit([{ key: 'profile', revision: 99, value: {} }, { key: 'orphan', revision: null, value: {} }]), false);
    assert.equal(await store.get('orphan'), null);
    assert.equal(await new LocalActivityWorkflowStore(local, 'foreign').get('profile'), null);
    local.database.close(); local = new LocalSqliteDatabase(config); store = new LocalActivityWorkflowStore(local, 'instance');
    assert.equal((await store.get('profile')).value.checkpoint, 2);
    assert.equal((await store.scan('outbox:', '', 10))[0].document.value.status, 'pending');
    assert.equal((await store.page(selection, 0, 10)).length, 2);
    await assert.rejects(store.append(event('bad', { count: -1 })));
    await assert.rejects(store.page(selection, 0, 101));
  } finally { local.database.close(); rmSync(dir, { recursive: true, force: true }); }
});
