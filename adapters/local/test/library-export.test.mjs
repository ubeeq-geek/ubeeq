import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalSqliteDatabase, LocalCreatorLibraryStore, LocalFavoriteStore, LocalCreatorSourceFileStore, readCreatorLibrarySnapshot } from '../dist/index.js';
import { CreatorAssetService } from '@ubeeq/core';

test('library snapshot retains all metadata and relationships across restart without worker state', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ubeeq-library-export-'));
  const configuration = { databasePath: join(directory, 'state.sqlite'), dataDirectory: directory, publicBaseUrl: 'http://localhost', cellId: 'cell' };
  let db = new LocalSqliteDatabase(configuration);
  try {
    const store = new LocalCreatorLibraryStore(db);
    const scope = { tenantId: 'tenant', creatorId: 'creator' };
    const work = index => ({ ...scope, workId: `work-${index}`, title: 'Retained', slug: `work-${index}`, slugHistory: [`old-${index}`],
      tags: [], status: index === 100 ? 'deleted' : 'draft', revision: 1, createdAt: 'before', updatedAt: 'before', body: [{ id: 'paragraph', type: 'paragraph', text: 'Preserve' }] });
    for (let index = 0; index < 102; index++) await store.createWork(work(index));
    await store.createWork({ ...work('foreign'), creatorId: 'foreign' });
    const storage = { bucket: 'private', key: 'original', versionId: 'v1', scope: 'private', contentType: 'image/png', byteLength: 1, checksum: 'a'.repeat(64) };
    const asset = { ...scope, assetId: 'asset', status: 'pending', mimeType: 'image/png', sizeBytes: 1, checksumSha256: storage.checksum,
      storage, createdAt: 'before', updatedAt: 'before', processingJobId: 'excluded-job',
      processing: { state: 'completed', sourceVersionId: 'v1', completedAt: 'before', metadata: { width: 10 }, renditions: [
        { id: 'preview:asset:v1', sourceVersionId: 'v1', role: 'preview', storage: { ...storage, key: 'rendition', versionId: 'r1' } }
      ] } };
    await new CreatorAssetService(store, async () => true).attach('tenant', 'work-0', asset);
    const collection = { ...scope, collectionId: 'collection', title: 'Order', slug: 'order', status: 'draft', visibility: 'private', revision: 1 };
    await store.createCreatorCollection(collection);
    await store.replaceCollectionWorks('tenant', 'collection', [{ collectionId: 'collection', workId: 'work-1', position: 0 }, { collectionId: 'collection', workId: 'work-0', position: 1 }]);
    const source = { fileId: 'source', creatorId: 'creator', sourceKind: 'document', mimeType: 'application/pdf', storageKey: 'private/source', createdAt: 'before', updatedAt: 'before', metadata: { label: 'retained' } };
    const files = new LocalCreatorSourceFileStore(db, 'tenant');
    await files.createSourceFile(source);
    await files.createSourceFile({ ...source, fileId: 'foreign-source', creatorId: 'foreign' });
    assert.equal(await files.hasSourceFileId('foreign-source'), true);
    assert.equal(await files.hasSourceFileId('missing'), false);
    assert.equal(await new LocalCreatorSourceFileStore(db, 'other').hasSourceFileId('source'), false);
    const snapshot = readCreatorLibrarySnapshot(db, scope);
    assert.deepEqual(snapshot.sourceFiles, [source]);
    const favorite = { userId: 'actor', ownerProfileType: 'creator', ownerProfileId: 'creator', targetType: 'work', targetId: 'work-100', visibility: 'private', createdAt: 'before' };
    await new LocalFavoriteStore(db, 'tenant').addFavorite(favorite);
    await new LocalFavoriteStore(db, 'foreign').addFavorite(favorite);
    await new LocalFavoriteStore(db, 'tenant').addFavorite({ ...favorite, ownerProfileId: 'foreign' });
    assert.deepEqual(readCreatorLibrarySnapshot(db, scope).favorites, [favorite]);
    snapshot.favorites = [favorite];
    assert.equal(snapshot.works.length, 102);
    assert.equal(snapshot.works.find(work => work.workId === 'work-100').status, 'deleted');
    assert.deepEqual(snapshot.works.find(work => work.workId === 'work-101'), work(101));
    assert.deepEqual(snapshot.assets[0].processing, asset.processing);
    assert.equal(snapshot.assets[0].processingJobId, undefined);
    assert.equal((await store.getProcessingAsset('tenant', 'asset')).processingJobId, 'excluded-job');
    assert.deepEqual(snapshot.memberships.map(item => item.workId), ['work-1', 'work-0']);
    assert.equal(snapshot.attachments[0].assetId, 'asset');
    db.database.close(); db = new LocalSqliteDatabase(configuration);
    assert.deepEqual(readCreatorLibrarySnapshot(db, scope), snapshot);
    assert.throws(() => readCreatorLibrarySnapshot(db, scope, { maxRows: 100 }), /budget/);
    assert.throws(() => readCreatorLibrarySnapshot(db, scope, { maxBytes: 1 }), /budget/);
    // Detachment must not cause retained originals/renditions to disappear from export.
    db.database.prepare("UPDATE ubeeq_creator_library SET payload = '[]' WHERE kind = 'work_assets' AND id = 'work-0'").run();
    const detached = readCreatorLibrarySnapshot(db, scope);
    assert.equal(detached.attachments.length, 0); assert.deepEqual(detached.assets, snapshot.assets);
    db.database.prepare("UPDATE ubeeq_creator_library SET payload = ? WHERE kind = 'membership'").run(JSON.stringify([{ collectionId: 'collection', workId: 'foreign', position: 0 }]));
    assert.throws(() => readCreatorLibrarySnapshot(db, scope), /relationship/);
  } finally { db.database.close(); rmSync(directory, { recursive: true, force: true }); }
});
