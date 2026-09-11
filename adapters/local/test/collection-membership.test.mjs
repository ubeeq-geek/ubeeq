import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalSqliteDatabase, LocalCreatorLibraryStore } from '../dist/index.js';
import { CreatorCollectionService } from '@ubeeq/core';

test('collection membership joins an import transaction and rolls back all records on nested failure', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ubeeq-membership-import-'));
  const database = new LocalSqliteDatabase({ databasePath: join(directory, 'state.sqlite'), dataDirectory: directory, publicBaseUrl: 'http://localhost', cellId: 'cell' });
  const store = new LocalCreatorLibraryStore(database);
  const work = { tenantId: 'tenant', creatorId: 'creator', workId: 'work', title: 'Imported', slug: 'work', slugHistory: ['work'], tags: [], status: 'draft', revision: 1, createdAt: 'now', updatedAt: 'now' };
  const collection = { tenantId: 'tenant', creatorId: 'creator', collectionId: 'collection', slug: 'collection', slugHistory: ['collection'], status: 'draft', updatedAt: 'now' };
  const membership = { collectionId: 'collection', workId: 'work', position: 0, addedAt: 'now' };
  const create = async () => { await store.createWork(work); await store.createCreatorCollection(collection); };
  try {
    await assert.rejects(database.transaction(async () => {
      await create();
      await store.replaceCollectionWorks('tenant', 'collection', [membership]);
      throw Error('outer checkpoint failed');
    }), /outer checkpoint failed/);
    assert.equal(await store.getWork('tenant', 'work'), null);
    assert.equal(await store.getCreatorCollection('tenant', 'collection'), null);
    assert.deepEqual(await store.listCollectionWorks('tenant', 'collection'), []);

    await assert.rejects(database.transaction(async () => {
      await create();
      // Even a caller catching the nested error cannot commit a partial import.
      await assert.rejects(store.replaceCollectionWorks('tenant', 'collection', [{ ...membership, workId: 'missing' }]), { code: 'invalid_works' });
    }), /rollback-only/);
    assert.equal(await store.getWork('tenant', 'work'), null);
    assert.equal(await store.getCreatorCollection('tenant', 'collection'), null);

    await database.transaction(async () => { await create(); await store.replaceCollectionWorks('tenant', 'collection', [membership], []); });
    assert.deepEqual(await store.listCollectionWorks('tenant', 'collection'), [membership]);
    const competing = store.replaceCollectionWorks('tenant', 'collection', [], ['wrong']);
    await assert.rejects(competing, { code: 'revision_conflict' });
    assert.deepEqual(await store.listCollectionWorks('tenant', 'collection'), [membership]);
  } finally { database.database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('membership commit revalidates Works changed after service validation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ubeeq-membership-race-'));
  const configuration = { databasePath: join(directory, 'state.sqlite'), dataDirectory: directory, publicBaseUrl: 'http://localhost', cellId: 'cell' };
  const first = new LocalSqliteDatabase(configuration), second = new LocalSqliteDatabase(configuration);
  try {
    const store = new LocalCreatorLibraryStore(first), other = new LocalCreatorLibraryStore(second);
    const base = { tenantId: 'tenant', creatorId: 'creator', title: 'Work', tags: [], status: 'draft', revision: 1, createdAt: 'now', updatedAt: 'now' };
    for (const id of ['keep', 'racing']) await store.createWork({ ...base, workId: id, slug: id, slugHistory: [id] });
    const collection = { tenantId: 'tenant', creatorId: 'creator', collectionId: 'collection', slug: 'collection', slugHistory: ['collection'], status: 'draft', updatedAt: 'now' };
    await store.createCreatorCollection(collection);
    const service = new CreatorCollectionService(store, async () => true);
    await service.replaceWorks('tenant', 'collection', ['keep']);
    const otherService = new CreatorCollectionService(other, async () => true);
    const results = await Promise.allSettled([
      service.replaceWorks('tenant', 'collection', ['racing'], ['keep']),
      otherService.replaceWorks('tenant', 'collection', [], ['keep'])
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.find(result => result.status === 'rejected').reason.code, 'revision_conflict');
    await service.replaceWorks('tenant', 'collection', ['keep']);
    const originalGet = store.getWork.bind(store);
    store.getWork = async (tenant, id) => {
      const snapshot = await originalGet(tenant, id);
      if (id === 'racing') await other.updateWork({ ...snapshot, status: 'deleted', revision: snapshot.revision + 1 });
      return snapshot;
    };
    await assert.rejects(service.replaceWorks('tenant', 'collection', ['racing']), { code: 'invalid_works' });
    assert.deepEqual((await store.listCollectionWorks('tenant', 'collection')).map(row => row.workId), ['keep']);
    store.getWork = originalGet;
    first.database.exec("CREATE TRIGGER reject_membership BEFORE UPDATE ON ubeeq_creator_library WHEN NEW.kind = 'membership' BEGIN SELECT RAISE(ABORT, 'membership failure'); END");
    await assert.rejects(service.replaceWorks('tenant', 'collection', []), /membership failure/);
    assert.equal((await store.listCollectionWorks('tenant', 'collection')).length, 1);
    first.database.exec('DROP TRIGGER reject_membership');
    await other.updateCreatorCollection({ ...collection, status: 'deleted' });
    await assert.rejects(store.replaceCollectionWorks('tenant', 'collection', []), { code: 'not_found' });
    assert.equal((await store.listCollectionWorks('tenant', 'collection')).length, 1);
  } finally { first.database.close(); second.database.close(); rmSync(directory, { recursive: true, force: true }); }
});
