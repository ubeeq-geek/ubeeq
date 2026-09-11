import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalSqliteDatabase, LocalCreatorLibraryStore, LocalSqliteJobQueue } from "../dist/index.js";
import { CreatorWorkService, CreatorCollectionService, CreatorAssetService, CreatorExistingAssetService } from "@ubeeq/core";

test('checksum lookup indexes current private custody and upgrades existing attachment records', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ubeeq-checksum-lookup-'));
  const config = { databasePath: join(directory, 'state.sqlite'), dataDirectory: directory, publicBaseUrl: 'http://localhost', cellId: 'cell' };
  let local = new LocalSqliteDatabase(config);
  try {
    let store = new LocalCreatorLibraryStore(local);
    const work = { tenantId: 'tenant', creatorId: 'creator', workId: 'work', title: 'Source', slug: 'source', slugHistory: ['source'], tags: [], status: 'draft', revision: 1, createdAt: 'now', updatedAt: 'now' };
    const asset = { tenantId: 'tenant', creatorId: 'creator', assetId: 'asset', status: 'ready', mimeType: 'image/png', sizeBytes: 1,
      checksumSha256: 'a'.repeat(64), storage: { bucket: 'originals', key: 'source', versionId: 'version', contentType: 'image/png', byteLength: 1, checksum: 'a'.repeat(64), scope: 'private' },
      processing: { state: 'completed', sourceVersionId: 'version', completedAt: 'now', metadata: {}, renditions: [] }, createdAt: 'now', updatedAt: 'now' };
    await store.createWork(work); await new CreatorAssetService(store, async () => true).attach('tenant', 'work', asset);
    const lookup = () => store.findReusableAssetByChecksum('tenant', 'creator', asset.checksumSha256);
    assert.deepEqual(await lookup(), { assetId: 'asset', sourceWorkId: 'work' });
    assert.equal(await store.findReusableAssetByChecksum('tenant', 'other', asset.checksumSha256), undefined);
    assert.equal(await store.findReusableAssetByChecksum('other', 'creator', asset.checksumSha256), undefined);
    await assert.rejects(store.findReusableAssetByChecksum('tenant', 'creator', 'invalid'), { code: 'invalid_asset' });
    const memberships = JSON.stringify([{ workId: 'work', assetId: 'asset', position: 0, role: 'primary' }]);
    const writeMembers = value => local.database.prepare("UPDATE ubeeq_creator_library SET payload = ? WHERE kind = 'work_assets' AND id = 'work'").run(value);
    await assert.rejects(local.transaction(async () => { writeMembers('[]'); assert.equal(await lookup(), undefined); throw Error('rollback'); }), /rollback/);
    assert.ok(await lookup());
    writeMembers('[]'); assert.equal(await lookup(), undefined); writeMembers(memberships);
    const writeAsset = value => local.database.prepare("UPDATE ubeeq_creator_library SET payload = ? WHERE kind = 'asset' AND id = 'asset'").run(JSON.stringify(value));
    for (const changed of [{ ...asset, status: 'deleted' }, { ...asset, processing: undefined }, { ...asset, storage: { ...asset.storage, scope: 'public' } }, { ...asset, processing: { ...asset.processing, sourceVersionId: 'old' } }]) {
      writeAsset(changed); assert.equal(await lookup(), undefined);
    }
    writeAsset(asset);
    const source = await store.getWork('tenant', 'work');
    await store.updateWork({ ...source, revision: source.revision + 1, status: 'archived' }); assert.equal(await lookup(), undefined);
    await store.updateWork({ ...source, revision: source.revision + 2 });
    // Reconstruct the pre-index schema in this disposable database, then reopen.
    local.database.exec('DROP TRIGGER ubeeq_creator_asset_membership_insert; DROP TRIGGER ubeeq_creator_asset_membership_update; DROP TRIGGER ubeeq_creator_asset_membership_delete; DROP TABLE ubeeq_creator_asset_memberships; DROP INDEX ubeeq_creator_asset_checksum;');
    local.database.prepare('DELETE FROM ubeeq_schema_migrations WHERE id = ?').run('015-creator-asset-lookup');
    local.database.close(); local = new LocalSqliteDatabase(config); store = new LocalCreatorLibraryStore(local);
    assert.deepEqual(await lookup(), { assetId: 'asset', sourceWorkId: 'work' });
    const otherCell = new LocalSqliteDatabase({ ...config, cellId: 'other-cell' });
    try { assert.equal(await new LocalCreatorLibraryStore(otherCell).findReusableAssetByChecksum('tenant', 'creator', asset.checksumSha256), undefined); }
    finally { otherCell.database.close(); }
    local.database.prepare("DELETE FROM ubeeq_creator_library WHERE kind = 'work_assets' AND id = 'work'").run();
    assert.equal(await lookup(), undefined);
    assert.equal(local.database.prepare('SELECT COUNT(*) AS count FROM ubeeq_creator_asset_memberships').get().count, 0);
  } finally { local.database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('existing processed assets attach atomically without replacing custody or scheduling processing', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ubeeq-existing-asset-'));
  const config = { databasePath: join(directory, 'state.sqlite'), dataDirectory: directory, publicBaseUrl: 'http://localhost', cellId: 'cell' };
  let local = new LocalSqliteDatabase(config);
  try {
    const store = new LocalCreatorLibraryStore(local, { enqueueImageProcessing: true });
    const work = { tenantId: 'tenant', creatorId: 'creator', workId: 'source-work', title: 'Source', slug: 'source', slugHistory: ['source'], tags: [], status: 'draft', revision: 1, createdAt: 'now', updatedAt: 'now' };
    for (const id of ['source-work', 'target', 'foreign']) await store.createWork({ ...work, workId: id, slug: id, slugHistory: [id], ...(id === 'foreign' ? { creatorId: 'other' } : {}) });
    const asset = { tenantId: 'tenant', creatorId: 'creator', assetId: 'source', status: 'ready', mimeType: 'image/jpeg', sizeBytes: 1,
      checksumSha256: 'a'.repeat(64), storage: { bucket: 'originals', key: 'source', versionId: 'version', contentType: 'image/jpeg', byteLength: 1, checksum: 'a'.repeat(64), scope: 'private' },
      processing: { state: 'completed', sourceVersionId: 'version', completedAt: 'now', metadata: {}, renditions: [] }, createdAt: 'now', updatedAt: 'now' };
    await new CreatorAssetService(store, async () => true).attach('tenant', 'source-work', asset);
    const service = new CreatorExistingAssetService(store, async () => true);
    const attach = () => service.attach('tenant', 'target', 'source-work', 'source', asset.checksumSha256);
    await assert.rejects(new CreatorExistingAssetService(store, async () => false).attach('tenant', 'target', 'source-work', 'source', asset.checksumSha256), { code: 'access_denied' });
    await assert.rejects(service.attach('tenant', 'foreign', 'source-work', 'source', asset.checksumSha256), { code: 'invalid_asset' });
    await assert.rejects(service.attach('tenant', 'target', 'source-work', 'source', 'b'.repeat(64)), { code: 'invalid_asset' });
    await assert.rejects(local.transaction(async () => { await attach(); throw Error('receipt failed'); }), /receipt failed/);
    assert.deepEqual(await store.listCanonicalAssetsByWork('tenant', 'target'), []);
    assert.equal((await store.getWork('tenant', 'target')).revision, 1);
    const writeAsset = value => local.database.prepare("UPDATE ubeeq_creator_library SET payload = ? WHERE kind = 'asset' AND id = 'source'").run(JSON.stringify(value));
    for (const changed of [{ ...asset, status: 'deleted' }, { ...asset, processing: undefined }, { ...asset, processing: { ...asset.processing, sourceVersionId: 'old' } }, { ...asset, creatorId: 'other' }]) {
      writeAsset(changed); await assert.rejects(attach(), { code: 'invalid_asset' });
    }
    writeAsset(asset);
    const source = await store.getWork('tenant', 'source-work');
    await store.updateWork({ ...source, status: 'archived', revision: source.revision + 1 }); await assert.rejects(attach(), { code: 'invalid_asset' });
    await store.updateWork({ ...source, revision: source.revision + 2 });
    const commit = { tenantId: 'tenant', creatorId: 'creator', workId: 'target', sourceWorkId: 'source-work', assetId: 'source', checksum: asset.checksumSha256, expectedRevision: 99, updatedAt: 'later' };
    await assert.rejects(store.commitExistingAssetAttachment(commit), { code: 'revision_conflict' });
    const result = await local.transaction(attach); assert.equal(result.primaryAssetId, 'source'); assert.equal(result.revision, 2);
    assert.equal((await attach()).revision, 2); // Repeating an attached membership is a no-op.
    await store.createWork({ ...work, workId: 'has-primary', slug: 'has-primary', slugHistory: ['has-primary'], title: 'Keep creator title' });
    await new CreatorAssetService(store, async () => true).attach('tenant', 'has-primary', { ...asset, assetId: 'existing-primary' });
    const withPrimary = await service.attach('tenant', 'has-primary', 'source-work', 'source', asset.checksumSha256);
    assert.equal(withPrimary.primaryAssetId, 'existing-primary'); assert.equal(withPrimary.title, 'Keep creator title');
    assert.deepEqual((await store.listCanonicalAssetsByWork('tenant', 'has-primary')).map(item => [item.assetId, item.attachment.role, item.attachment.position]),
      [['existing-primary', 'primary', 0], ['source', 'content', 1]]);
    assert.deepEqual(await store.getProcessingAsset('tenant', 'source'), asset);
    assert.equal(local.database.prepare('SELECT COUNT(*) AS count FROM ubeeq_jobs').get().count, 0);
    local.database.close(); local = new LocalSqliteDatabase(config);
    const restored = new LocalCreatorLibraryStore(local);
    assert.equal((await restored.listCanonicalAssetsByWork('tenant', 'target'))[0].assetId, 'source');
    local.database.prepare("UPDATE ubeeq_creator_library SET payload = '[]' WHERE kind = 'work_assets' AND id = 'source-work'").run();
    await assert.rejects(restored.commitExistingAssetAttachment({ ...commit, expectedRevision: 2 }), { code: 'invalid_asset' });
  } finally { local.database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('source import attachment, processing job and caller receipt share commit and rollback across restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ubeeq-import-attachment-'));
  const config = { databasePath: join(directory, 'state.sqlite'), dataDirectory: directory, publicBaseUrl: 'http://localhost', cellId: 'cell' };
  let local = new LocalSqliteDatabase(config);
  try {
    const store = new LocalCreatorLibraryStore(local, { enqueueImageProcessing: true });
    const work = { tenantId: 'tenant', creatorId: 'creator', workId: 'work', title: 'Imported work', slug: 'work', slugHistory: ['work'], tags: [], status: 'draft', revision: 1, createdAt: 'now', updatedAt: 'now' };
    await store.createWork(work);
    local.database.exec('CREATE TABLE import_receipts (id TEXT PRIMARY KEY)');
    const asset = { tenantId: 'tenant', creatorId: 'creator', assetId: 'source', status: 'pending', mimeType: 'image/jpeg', sizeBytes: 1,
      checksumSha256: 'a'.repeat(64), storage: { bucket: 'originals', key: 'source', versionId: 'version', contentType: 'image/jpeg', byteLength: 1, checksum: 'a'.repeat(64), scope: 'private' }, createdAt: 'now', updatedAt: 'now' };
    const service = new CreatorAssetService(store, async () => true);
    const attach = async () => {
      await service.attach('tenant', 'work', asset);
      local.database.prepare('INSERT INTO import_receipts (id) VALUES (?)').run('source');
    };
    const unchanged = async () => {
      assert.equal(await store.getProcessingAsset('tenant', 'source'), null);
      assert.deepEqual(await store.listCanonicalAssetsByWork('tenant', 'work'), []);
      assert.equal((await store.getWork('tenant', 'work')).revision, 1);
      assert.equal(local.database.prepare('SELECT COUNT(*) AS count FROM ubeeq_jobs').get().count, 0);
      assert.equal(local.database.prepare('SELECT COUNT(*) AS count FROM import_receipts').get().count, 0);
    };
    await assert.rejects(local.transaction(async () => { await attach(); throw Error('receipt acknowledgement failed'); }), /receipt acknowledgement failed/);
    await unchanged();
    local.database.exec("CREATE TRIGGER reject_import_job BEFORE INSERT ON ubeeq_jobs BEGIN SELECT RAISE(ABORT, 'queue unavailable'); END");
    await assert.rejects(local.transaction(async () => {
      await assert.rejects(attach(), /queue unavailable/);
      // Catching a nested commit failure must not make a partial import committable.
    }), /rollback-only/);
    await unchanged(); local.database.exec('DROP TRIGGER reject_import_job');
    await local.transaction(attach);
    local.database.close(); local = new LocalSqliteDatabase(config);
    const restored = new LocalCreatorLibraryStore(local);
    assert.equal((await restored.getWork('tenant', 'work')).revision, 2);
    assert.equal((await restored.getProcessingAsset('tenant', 'source')).status, 'pending');
    assert.equal((await restored.listCanonicalAssetsByWork('tenant', 'work')).length, 1);
    assert.equal(local.database.prepare('SELECT COUNT(*) AS count FROM import_receipts').get().count, 1);
    const jobs = await new LocalSqliteJobQueue(local).list({ cellId: 'cell', limit: 10 });
    assert.equal(jobs.length, 1); assert.equal(jobs[0].state, 'queued'); assert.equal(jobs[0].type, 'creator-asset.process');
  } finally { local.database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('collection cover writes atomically enforce asset scope and reject a post-read deletion', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ubeeq-collection-covers-'));
  const configuration = { databasePath: join(directory, 'state.sqlite'), dataDirectory: directory, publicBaseUrl: 'http://localhost', cellId: 'cell' };
  const first = new LocalSqliteDatabase(configuration), second = new LocalSqliteDatabase(configuration);
  try {
    const store = new LocalCreatorLibraryStore(first);
    const insert = (id, extra = {}, cell = 'cell') => {
      const asset = { tenantId: 'tenant', creatorId: 'creator', assetId: id, status: 'ready', storage: { scope: 'private' }, ...extra };
      first.database.prepare("INSERT INTO ubeeq_creator_library (cell_id, tenant_id, kind, id, creator_id, payload) VALUES (?, ?, 'asset', ?, ?, ?)")
        .run(cell, asset.tenantId, id, asset.creatorId, JSON.stringify(asset));
    };
    insert('valid'); insert('foreign-owner', { creatorId: 'other' }); insert('foreign-tenant', { tenantId: 'other' });
    insert('foreign-cell', {}, 'other'); insert('deleted', { status: 'deleted' }); insert('public', { storage: { scope: 'public' } });
    const record = { tenantId: 'tenant', creatorId: 'creator', collectionId: 'collection', slug: 'original', slugHistory: ['original'], status: 'draft', updatedAt: 'before' };
    for (const coverAssetId of ['missing', 'foreign-owner', 'foreign-tenant', 'foreign-cell', 'deleted', 'public']) {
      await assert.rejects(store.createCreatorCollection({ ...record, coverAssetId }), { code: 'invalid_cover' });
    }
    assert.equal(await store.getCreatorCollection('tenant', 'collection'), null);
    await store.createCreatorCollection({ ...record, coverAssetId: 'valid' });
    const before = await store.getCreatorCollection('tenant', 'collection');
    await assert.rejects(store.updateCreatorCollection({ ...before, coverAssetId: 'foreign-owner' }, undefined, 0), { code: 'invalid_cover' });
    assert.deepEqual(await store.getCreatorCollection('tenant', 'collection'), before);
    insert('racy');
    const getAsset = store.getProcessingAsset.bind(store);
    store.getProcessingAsset = async (tenant, id) => {
      const snapshot = await getAsset(tenant, id);
      second.database.prepare("UPDATE ubeeq_creator_library SET payload = json_set(payload, '$.status', 'deleted') WHERE kind = 'asset' AND id = ?").run(id);
      return snapshot;
    };
    const service = new CreatorCollectionService(store, async () => true);
    await assert.rejects(service.update({ ...before, coverAssetId: 'racy' }, undefined, 0), { code: 'invalid_cover' });
    assert.deepEqual(await store.getCreatorCollection('tenant', 'collection'), before);
    // Clearing a cover never deletes its original, and deletion is possible even when a prior cover is gone.
    await store.updateCreatorCollection({ ...before, coverAssetId: '' }, undefined, 0);
    assert.equal((await store.getCreatorCollection('tenant', 'collection')).coverAssetId, '');
    assert.equal((await getAsset('tenant', 'valid')).status, 'ready');
    await store.updateCreatorCollection({ ...before, coverAssetId: 'missing', status: 'deleted' }, undefined, 1);
    assert.deepEqual(await store.listCreatorCollections('tenant', 'creator'), []);
  } finally {
    first.database.close(); second.database.close(); rmSync(directory, { recursive: true, force: true });
  }
});

test('collection revisions fence competing writers, legacy rows and status ABA changes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ubeeq-collection-revisions-'));
  const configuration = { databasePath: join(directory, 'state.sqlite'), dataDirectory: directory, publicBaseUrl: 'http://localhost', cellId: 'cell' };
  const first = new LocalSqliteDatabase(configuration), second = new LocalSqliteDatabase(configuration);
  try {
    const a = new LocalCreatorLibraryStore(first), b = new LocalCreatorLibraryStore(second);
    const record = { tenantId: 'tenant', creatorId: 'creator', collectionId: 'collection', slug: 'original', slugHistory: ['original'], status: 'draft', updatedAt: 'before' };
    await a.createCreatorCollection(record); // Historical records need no migration to acquire revision 1.
    const results = await Promise.allSettled([
      a.updateCreatorCollection({ ...record, title: 'A' }, 'draft', 0),
      b.updateCreatorCollection({ ...record, title: 'B' }, 'draft', 0)
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.find(result => result.status === 'rejected').reason.code, 'revision_conflict');
    const winner = await a.getCreatorCollection('tenant', 'collection');
    assert.equal(winner.revision, 1);
    await b.updateCreatorCollection({ ...winner, status: 'archived' }, 'draft', 1);
    await b.updateCreatorCollection({ ...winner, status: 'draft' }, 'archived', 2);
    await assert.rejects(a.updateCreatorCollection({ ...winner, title: 'Stale edit' }, 'draft', 1), { code: 'revision_conflict' });
    await assert.rejects(a.updateCreatorCollection({ ...winner, status: 'deleted' }, undefined, 1), { code: 'revision_conflict' });
    const current = await a.getCreatorCollection('tenant', 'collection');
    assert.equal(current.revision, 3);
    assert.equal(current.title, winner.title);
    for (const revision of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
      await assert.rejects(a.updateCreatorCollection(current, undefined, revision), { code: 'revision_conflict' });
    }
    // Compatibility writes also advance the counter; they cannot reset it using payload fields.
    await b.updateCreatorCollection({ ...current, revision: 0 });
    assert.equal((await a.getCreatorCollection('tenant', 'collection')).revision, 4);
  } finally {
    first.database.close(); second.database.close(); rmSync(directory, { recursive: true, force: true });
  }
});

test('a stale collection edit cannot revive a deletion committed by another connection', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ubeeq-collection-tombstone-'));
  const configuration = { databasePath: join(directory, 'state.sqlite'), dataDirectory: directory, publicBaseUrl: 'http://localhost', cellId: 'cell' };
  const first = new LocalSqliteDatabase(configuration), second = new LocalSqliteDatabase(configuration);
  try {
    const editor = new LocalCreatorLibraryStore(first), remover = new LocalCreatorLibraryStore(second);
    const record = { tenantId: 'tenant', creatorId: 'creator', collectionId: 'collection', slug: 'original', slugHistory: ['original'], status: 'archived', updatedAt: 'before' };
    await editor.createCreatorCollection(record);
    const stale = await editor.getCreatorCollection('tenant', 'collection');
    const deleted = { ...record, status: 'deleted', deletedAt: 'deleted', updatedAt: 'deleted' };
    await remover.updateCreatorCollection(deleted);
    for (const status of ['draft', 'archived', 'published']) {
      await assert.rejects(editor.updateCreatorCollection({ ...stale, status, updatedAt: 'after' }, stale.status), { code: 'revision_conflict' });
      assert.deepEqual(await editor.getCreatorCollection('tenant', 'collection'), { ...deleted, revision: 1 });
    }
    assert.deepEqual(await editor.listCreatorCollections('tenant', 'creator'), []);
  } finally {
    first.database.close(); second.database.close(); rmSync(directory, { recursive: true, force: true });
  }
});

test("image attachment and processing job are atomic and survive reopening", async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ubeeq-image-job-'));
  const configuration = { databasePath: join(directory, 'state.sqlite'), dataDirectory: directory, publicBaseUrl: 'http://localhost', cellId: 'cell' };
  let local = new LocalSqliteDatabase(configuration);
  try {
    const store = new LocalCreatorLibraryStore(local, { enqueueImageProcessing: true });
    await store.createWork({ tenantId: 'tenant', creatorId: 'creator', workId: 'work', title: 'Work', slug: 'work', tags: [], status: 'draft', revision: 1, createdAt: 'now', updatedAt: 'now' });
    const asset = { tenantId: 'tenant', creatorId: 'creator', assetId: 'image', status: 'pending', mimeType: 'image/png', sizeBytes: 1,
      checksumSha256: 'a'.repeat(64), storage: { bucket: 'originals', key: 'image', versionId: 'v1', contentType: 'image/png', byteLength: 1, checksum: 'a'.repeat(64), scope: 'private' }, createdAt: 'now', updatedAt: 'now' };
    const service = new CreatorAssetService(store, async () => true);
    local.database.exec("CREATE TRIGGER reject_image_job BEFORE INSERT ON ubeeq_jobs BEGIN SELECT RAISE(ABORT, 'queue unavailable'); END");
    await assert.rejects(service.attach('tenant', 'work', asset), /queue unavailable/);
    assert.deepEqual(await store.listCanonicalAssetsByWork('tenant', 'work'), []);
    assert.equal((await store.getWork('tenant', 'work')).revision, 1);
    local.database.exec('DROP TRIGGER reject_image_job');
    await service.attach('tenant', 'work', asset);
    local.database.close();
    local = new LocalSqliteDatabase(configuration);
    const queue = new LocalSqliteJobQueue(local);
    const jobs = await queue.list({ cellId: 'cell', limit: 10 });
    assert.equal(jobs.length, 1);
    assert.deepEqual(jobs[0].payload, { tenantId: 'tenant', creatorId: 'creator', workId: 'work', assetId: 'image', sourceVersionId: 'v1' });
    assert.equal(jobs[0].type, 'creator-asset.process');
    const leaseInput = { cellId: 'cell', types: ['creator-asset.process'], workerId: 'worker', leaseDurationSeconds: 60 };
    const lease = await queue.lease(leaseInput);
    assert.equal(lease.job.id, jobs[0].id);
    const reopened = new LocalCreatorLibraryStore(local);
    const result = { ...jobs[0].payload, jobId: jobs[0].id, leaseToken: lease.leaseToken, metadata: { width: 1 },
      renditions: [{ id: 'preview', role: 'preview', sourceVersionId: 'v1', body: new Uint8Array([1]),
        storage: { ...asset.storage, key: 'preview', versionId: 'preview-v1', contentType: 'image/jpeg', body: new Uint8Array([1]) } }] };
    await assert.rejects(reopened.commitAssetProcessing({ ...result, creatorId: 'foreign' }), /scope/);
    await assert.rejects(reopened.commitAssetProcessing({ ...result, sourceVersionId: 'v2' }), /scope/);
    await assert.rejects(reopened.commitAssetProcessing({ ...result, renditions: [{ ...result.renditions[0], sourceVersionId: 'v2' }] }), /rendition/);
    local.database.prepare("UPDATE ubeeq_jobs SET lease_expires_at = ? WHERE id = ?").run('2000-01-01T00:00:00.000Z', jobs[0].id);
    await assert.rejects(reopened.commitAssetProcessing(result), /lease/);
    const replacement = await queue.lease(leaseInput);
    assert.ok(replacement);
    await assert.rejects(reopened.commitAssetProcessing(result), /lease/);
    result.leaseToken = replacement.leaseToken;
    local.database.exec("CREATE TRIGGER reject_processing_complete BEFORE UPDATE ON ubeeq_jobs WHEN NEW.state = 'completed' BEGIN SELECT RAISE(ABORT, 'completion failure'); END");
    await assert.rejects(reopened.commitAssetProcessing(result), /completion failure/);
    assert.equal((await reopened.getProcessingAsset('tenant', 'image')).processing, undefined);
    assert.equal((await queue.get(jobs[0].id)).state, 'leased');
    local.database.exec('DROP TRIGGER reject_processing_complete');
    // A changed source cannot receive a result from the old source version.
    local.database.prepare("UPDATE ubeeq_creator_library SET payload = json_set(payload, '$.storage.versionId', 'v2') WHERE kind = 'asset'").run();
    await assert.rejects(reopened.commitAssetProcessing(result), /source/);
    local.database.prepare("UPDATE ubeeq_creator_library SET payload = json_set(payload, '$.storage.versionId', 'v1') WHERE kind = 'asset'").run();
    await reopened.commitAssetProcessing(result);
    await assert.rejects(reopened.commitAssetProcessing(result), /lease/);
    local.database.close(); local = new LocalSqliteDatabase(configuration);
    const processed = await new LocalCreatorLibraryStore(local).getProcessingAsset('tenant', 'image');
    assert.equal(processed.processing.state, 'completed');
    assert.equal(processed.status, 'pending'); // Processing does not grant publication/safety approval.
    assert.equal(processed.processing.renditions[0].body, undefined);
    assert.equal(processed.processing.renditions[0].storage.body, undefined);
    assert.equal((await new LocalSqliteJobQueue(local).get(jobs[0].id)).state, 'completed');
  } finally { local.database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("asset attachment commits metadata and Work revision together, rolling back on failure", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ubeeq-asset-"));
  const local = new LocalSqliteDatabase({ databasePath: join(directory, "state.sqlite"), dataDirectory: directory, publicBaseUrl: "http://localhost", cellId: "cell" });
  try {
    const store = new LocalCreatorLibraryStore(local);
    const work = { tenantId: "tenant", creatorId: "creator", workId: "work", title: "Work", slug: "work", slugHistory: ["work"], tags: [], status: "draft", revision: 1, createdAt: "now", updatedAt: "now" };
    await store.createWork(work);
    const asset = (id) => ({ tenantId: "tenant", creatorId: "creator", assetId: id, status: "pending", mimeType: "text/plain", sizeBytes: 1,
      checksumSha256: "a".repeat(64), storage: { bucket: "originals", key: id, versionId: id, contentType: "text/plain", byteLength: 1, checksum: "a".repeat(64), scope: "private" }, createdAt: "now", updatedAt: "now" });
    const service = new CreatorAssetService(store, async () => true);
    await assert.rejects(new CreatorAssetService(store, async () => false).attach("tenant", "work", asset("denied")), { code: "access_denied" });
    await assert.rejects(service.attach("tenant", "work", { ...asset("foreign"), creatorId: "other" }), { code: "invalid_asset" });
    local.database.exec("CREATE TRIGGER reject_asset_work_update BEFORE UPDATE ON ubeeq_creator_library WHEN NEW.kind = 'work' BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
    await assert.rejects(service.attach("tenant", "work", asset("failed")), /injected failure/);
    assert.deepEqual(await store.listCanonicalAssetsByWork("tenant", "work"), []);
    assert.equal(local.database.prepare("SELECT count(*) AS count FROM ubeeq_creator_library WHERE kind = 'asset'").get().count, 0);
    assert.equal((await store.getWork("tenant", "work")).revision, 1);
    local.database.exec("DROP TRIGGER reject_asset_work_update");
    const results = await Promise.allSettled([service.attach("tenant", "work", asset("one")), service.attach("tenant", "work", asset("two"))]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(results.find((r) => r.status === "rejected").reason.code, "revision_conflict");
    const first = (await store.listCanonicalAssetsByWork("tenant", "work"))[0];
    assert.equal(first.attachment.role, "primary");
    assert.equal((await store.getWork("tenant", "work")).primaryAssetId, first.assetId);
    const next = await service.attach("tenant", "work", asset("next"));
    assert.equal(next.attachment.role, "content");
    assert.equal(next.attachment.position, 1);
    assert.equal(next.work.revision, 3);
    await assert.rejects(store.commitWorkRevision({ ...work, title: 'stale', revision: 2 }, 1), { code: 'revision_conflict' });
    assert.equal((await store.getWork('tenant', 'work')).primaryAssetId, first.assetId);
  } finally { local.database.close(); rmSync(directory, { recursive: true, force: true }); }
});

for (const kind of ["work", "collection"]) {
  test(`SQLite ${kind} slug reservations protect concurrent service writes and restoration history`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "ubeeq-slug-"));
    const config = { databasePath: join(directory, "state.sqlite"), dataDirectory: directory, publicBaseUrl: "http://localhost", cellId: "cell" };
    const first = new LocalSqliteDatabase(config), second = new LocalSqliteDatabase(config);
    try {
      const a = new LocalCreatorLibraryStore(first), b = new LocalCreatorLibraryStore(second);
      const Service = kind === "work" ? CreatorWorkService : CreatorCollectionService;
      const one = new Service(a, async () => true), two = new Service(b, async () => true);
      const record = (id, slug = id) => ({ tenantId: "tenant", creatorId: "creator", workId: id, collectionId: id,
        title: id, slug, slugHistory: [slug], tags: [], status: "draft", revision: 1, createdAt: "now", updatedAt: "now" });
      const create = (store, value) => kind === "work" ? store.createWork(value) : store.createCreatorCollection(value);
      const update = (store, value) => kind === "work" ? store.updateWork(value) : store.updateCreatorCollection(value);
      const get = (store, id) => kind === "work" ? store.getWork("tenant", id) : store.getCreatorCollection("tenant", id);
      // Both asynchronous prechecks can observe an empty library. The SQL write
      // must make the final decision across independent database connections.
      const attempts = await Promise.allSettled([one.create(record("one", "shared")), two.create(record("two", "shared"))]);
      assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(attempts.find((result) => result.status === "rejected").reason.code, "slug_conflict");
      const winnerId = attempts[0].status === "fulfilled" ? "one" : "two";
      const winner = await get(a, winnerId);
      await update(a, { ...winner, slug: "renamed", slugHistory: ["shared", "renamed"], revision: 2 });
      await assert.rejects(create(b, record("other", "shared")), { code: "slug_conflict" });
      await assert.rejects(create(b, record("other", "renamed")), { code: "slug_conflict" });
      await create(b, record("other"));
      await assert.rejects(update(b, { ...record("other"), slug: "shared", revision: 2 }), { code: "slug_conflict" });
      assert.equal((await get(a, "other")).slug, "other");
      const renamed = await get(a, winnerId);
      await update(a, { ...renamed, status: "deleted", revision: 3 });
      await create(b, record("reuse", "shared"));
      // Restoring the current slug alone would overlook the reused old alias.
      await assert.rejects(update(a, { ...renamed, status: "draft", revision: 4 }), { code: "slug_conflict" });
      assert.equal((await get(a, winnerId)).status, "deleted");
      await update(a, { ...renamed, status: "deleted", revision: 4 });
      // Slugs are scoped to a creator and tenant, not globally reserved.
      await create(a, { ...record("foreign", "shared"), creatorId: "another" });
      await create(a, { ...record("foreign", "shared"), tenantId: "another" });
    } finally { first.database.close(); second.database.close(); rmSync(directory, { recursive: true, force: true }); }
  });
}

test("SQLite creator library preserves tenant/cell boundaries and rejects stale Work revisions", () => {
  return (async () => {
    const directory = mkdtempSync(join(tmpdir(), "ubeeq-library-"));
    const config = { databasePath: join(directory, "state.sqlite"), dataDirectory: directory, publicBaseUrl: "http://localhost", cellId: "one" };
    const first = new LocalSqliteDatabase(config), second = new LocalSqliteDatabase({ ...config, cellId: "two" });
    try {
      const store = new LocalCreatorLibraryStore(first), foreign = new LocalCreatorLibraryStore(second);
      const work = { tenantId: "tenant", creatorId: "creator", workId: "work", title: "Original", slug: "original", slugHistory: ["original"], tags: [], status: "draft", revision: 1, createdAt: "now", updatedAt: "now" };
      await store.createWork(work);
      assert.equal(await foreign.getWork("tenant", "work"), null);
      assert.equal(await store.getWork("other", "work"), null);
      await store.updateWork({ ...work, revision: 2, title: "Updated" });
      await assert.rejects(store.updateWork({ ...work, revision: 2, title: "Stale" }), /revision conflict/);
      assert.equal((await store.getWork("tenant", "work")).title, "Updated");
      await store.createCreatorCollection({ tenantId: "tenant", creatorId: "creator", collectionId: "collection", title: "Collection", slug: "collection", slugHistory: ["collection"], status: "draft", updatedAt: "now" });
      const memberships = [{ collectionId: "collection", workId: "work", position: 0, addedAt: "now" }];
      await store.replaceCollectionWorks("tenant", "collection", memberships);
      assert.deepEqual(await store.listCollectionWorks("tenant", "collection"), memberships);
      await assert.rejects(store.replaceCollectionWorks("tenant", "collection", [{ ...memberships[0], collectionId: "foreign" }]), { code: 'invalid_works' });
      assert.deepEqual(await store.listCollectionWorks("tenant", "collection"), memberships);
      assert.deepEqual(await foreign.listCollectionWorks("tenant", "collection"), []);
    } finally { first.database.close(); second.database.close(); rmSync(directory, { recursive: true, force: true }); }
  })();
});
