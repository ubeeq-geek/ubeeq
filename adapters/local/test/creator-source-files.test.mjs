import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalSqliteDatabase, LocalCreatorSourceFileStore } from '../dist/index.js';
import { CreatorSourceFileService } from '@ubeeq/core';

test('source-file catalogue persists indexed scoped pages and reserves identifiers across connections', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ubeeq-source-files-'));
  const config = { databasePath: join(directory, 'db.sqlite'), dataDirectory: directory, publicBaseUrl: 'http://localhost', cellId: 'cell' };
  let local = new LocalSqliteDatabase(config);
  try {
    const store = new LocalCreatorSourceFileStore(local, 'tenant');
    const service = new CreatorSourceFileService(store, async id => id === 'creator');
    const record = id => ({ fileId: id, creatorId: 'creator', sourceKind: 'document', mimeType: 'application/pdf',
      storageKey: 'private/source', createdAt: 'now', updatedAt: 'now', custom: { preserved: true } });
    for (let index = 0; index < 102; index++) await service.create('creator', record(`file-${String(index).padStart(3, '0')}`));
    await store.createSourceFile({ ...record('foreign'), creatorId: 'other' });
    const first = await service.listCreator('creator', { limit: 100 });
    assert.equal(first.items.length, 100); assert.ok(first.nextCursor);
    assert.deepEqual(first.items[0].custom, { preserved: true });
    await assert.rejects(service.list(), { code: 'unsupported' });
    await assert.rejects(service.listCreator('other', { limit: 100 }), { code: 'access_denied' });
    for (const request of [{ limit: 101 }, { limit: 1, cursor: '' }, { limit: 1, cursor: 'invalid' }])
      await assert.rejects(store.listCreatorSourceFiles('creator', request), { code: 'invalid_page' });
    await assert.rejects(store.listCreatorSourceFiles('other', { limit: 1, cursor: first.nextCursor }), { code: 'invalid_page' });
    const otherTenant = new LocalCreatorSourceFileStore(local, 'other');
    assert.deepEqual((await otherTenant.listCreatorSourceFiles('creator', { limit: 1 })).items, []);
    await assert.rejects(otherTenant.listCreatorSourceFiles('creator', { limit: 1, cursor: first.nextCursor }), { code: 'invalid_page' });
    const concurrent = new LocalSqliteDatabase(config);
    try {
      await assert.rejects(new LocalCreatorSourceFileStore(concurrent, 'tenant').createSourceFile({ ...record('file-000'), creatorId: 'other' }), /UNIQUE/);
    } finally { concurrent.database.close(); }
    const plan = local.database.prepare("EXPLAIN QUERY PLAN SELECT id, payload FROM ubeeq_creator_library WHERE cell_id = ? AND tenant_id = ? AND creator_id = ? AND kind = 'source_file' AND id > ? ORDER BY id LIMIT ?").all('cell', 'tenant', 'creator', '', 101);
    assert.match(JSON.stringify(plan), /ubeeq_source_file_page/);
    assert.doesNotMatch(JSON.stringify(plan), /TEMP B-TREE/);
    local.database.close(); local = new LocalSqliteDatabase(config);
    const second = await new LocalCreatorSourceFileStore(local, 'tenant').listCreatorSourceFiles('creator', { limit: 100, cursor: first.nextCursor });
    assert.deepEqual(second.items.map(item => item.fileId), ['file-100', 'file-101']); assert.equal(second.nextCursor, undefined);
    const otherCell = new LocalSqliteDatabase({ ...config, cellId: 'other' });
    try { assert.deepEqual((await new LocalCreatorSourceFileStore(otherCell, 'tenant').listCreatorSourceFiles('creator', { limit: 100 })).items, []); }
    finally { otherCell.database.close(); }
  } finally { local.database.close(); rmSync(directory, { recursive: true, force: true }); }
});
