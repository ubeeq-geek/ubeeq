import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalSqliteDatabase, LocalCreatorLibraryStore } from '../dist/index.js';
import { CreatorAssetService, CreatorPrimaryAssetService, CreatorAssetOrderService } from '@ubeeq/core';

test('primary selection commits pointer and roles together, preserves order, and rejects stale or invalid membership', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ubeeq-primary-'));
  const configuration = { databasePath: join(directory, 'state.sqlite'), dataDirectory: directory, publicBaseUrl: 'http://localhost', cellId: 'cell' };
  const db = new LocalSqliteDatabase(configuration);
  try {
    const store = new LocalCreatorLibraryStore(db);
    await store.createWork({ tenantId: 'tenant', creatorId: 'creator', workId: 'work', title: 'Keep title', slug: 'work', slugHistory: ['old', 'work'], tags: [], status: 'draft', revision: 1, createdAt: 'before', updatedAt: 'before' });
    const uploads = new CreatorAssetService(store, async () => true);
    for (const assetId of ['a', 'b']) await uploads.attach('tenant', 'work', {
      tenantId: 'tenant', creatorId: 'creator', assetId, status: 'pending', sizeBytes: 1, checksumSha256: 'a'.repeat(64),
      storage: { scope: 'private', byteLength: 1, checksum: 'a'.repeat(64), versionId: 'v1' }
    });
    const service = new CreatorPrimaryAssetService(store, async () => true, () => 'after');
    await assert.rejects(new CreatorPrimaryAssetService(store, async () => false).select('tenant', 'work', 'b', 3), { code: 'access_denied' });
    await assert.rejects(service.select('other', 'work', 'b', 3), { code: 'not_found' });
    await assert.rejects(service.select('tenant', 'work', 'missing', 3), { code: 'invalid_asset' });
    const next = await service.select('tenant', 'work', 'b', 3);
    assert.equal(next.primaryAssetId, 'b'); assert.equal(next.revision, 4);
    assert.equal(next.title, 'Keep title'); assert.deepEqual(next.slugHistory, ['old', 'work']);
    assert.deepEqual((await store.listCanonicalAssetsByWork('tenant', 'work')).map(item => [item.assetId, item.attachment.role, item.attachment.position]), [['a', 'content', 0], ['b', 'primary', 1]]);
    await assert.rejects(service.select('tenant', 'work', 'a', 3), { code: 'revision_conflict' });
    const ordering = new CreatorAssetOrderService(store, async () => true, () => 'ordered');
    await assert.rejects(new CreatorAssetOrderService(store, async () => false).replace('tenant', 'work', ['b', 'a'], 4), { code: 'access_denied' });
    for (const ids of [['a'], ['a', 'a'], ['a', 'missing']]) {
      await assert.rejects(ordering.replace('tenant', 'work', ids, 4), { code: 'invalid_asset' });
      await assert.rejects(store.commitAssetOrder({ tenantId: 'tenant', creatorId: 'creator', workId: 'work', assetIds: ids, expectedRevision: 4, updatedAt: 'bad' }), { code: 'invalid_asset' });
      assert.deepEqual(await store.getWork('tenant', 'work'), next);
    }
    const ordered = await ordering.replace('tenant', 'work', ['b', 'a'], 4);
    assert.equal(ordered.revision, 5); assert.equal(ordered.primaryAssetId, 'b');
    assert.deepEqual((await store.listCanonicalAssetsByWork('tenant', 'work')).map(item => [item.assetId, item.attachment.role, item.attachment.position]), [['b', 'primary', 0], ['a', 'content', 1]]);
    await assert.rejects(ordering.replace('tenant', 'work', ['a', 'b'], 4), { code: 'revision_conflict' });
    const original = store.listCanonicalAssetsByWork.bind(store);
    store.listCanonicalAssetsByWork = async (...args) => {
      const rows = await original(...args);
      db.database.prepare("UPDATE ubeeq_creator_library SET payload = json_set(payload, '$.status', 'deleted') WHERE kind = 'asset' AND id = 'a'").run();
      return rows;
    };
    await assert.rejects(service.select('tenant', 'work', 'a', 5), { code: 'invalid_asset' });
    assert.deepEqual(await store.getWork('tenant', 'work'), ordered);
    assert.deepEqual((await original('tenant', 'work')).map(item => item.attachment.role), ['primary', 'content']);
  } finally { db.database.close(); rmSync(directory, { recursive: true, force: true }); }
});
