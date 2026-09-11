import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalAdapterSet, LocalCreatorLibraryStore, LocalLibraryPublicationView } from '@ubeeq/adapter-local';
import { PublicationService } from '@ubeeq/api';

test('library publication shares atomic receipts without copying Works or exposing originals', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ubeeq-library-publication-'));
  const configuration = { databasePath: join(directory, 'state.sqlite'), dataDirectory: directory, publicBaseUrl: 'http://localhost', cellId: 'cell' };
  let local = createLocalAdapterSet(configuration);
  const scope = { tenantId: 'tenant', creatorId: 'creator', workId: 'work' };
  const input = { workId: 'work', actorId: 'owner', destination: 'local', idempotencyKey: 'request' };
  const create = (admit = async () => {}, select = asset => asset.processing?.renditions[0]?.id) => {
    const view = new LocalLibraryPublicationView(local.database, scope, select);
    const service = new PublicationService(view, async (id, actor) => {
      if (actor !== 'owner') throw new Error('ownership denied');
      const work = await view.works.get(id);
      if (!work) throw new Error('Work not found');
      return work;
    }, admit);
    return { view, service };
  };
  const put = (kind, id, payload) => local.database.database.prepare('INSERT OR REPLACE INTO ubeeq_creator_library (cell_id, tenant_id, kind, id, creator_id, payload) VALUES (?, ?, ?, ?, ?, ?)')
    .run('cell', 'tenant', kind, id, 'creator', JSON.stringify(payload));
  const emptyReceipts = async () => {
    for (const name of ['publicationIntents', 'publications', 'auditEvents']) assert.deepEqual((await local.repositories[name].list({ limit: 100 })).items, []);
    assert.equal((await new LocalCreatorLibraryStore(local.database).getWork('tenant', 'work')).revision, 1);
  };
  try {
    await local.repositories.creators.create({ id: 'creator', instanceId: 'tenant', homeCellId: 'cell', dataHomeRegion: 'local', dataHomeAssignedAt: '2026-01-01T00:00:00Z', routingRevision: 1, handle: 'owner', displayName: 'Owner', subjectId: 'owner' });
    const work = { ...scope, title: 'Existing Work', slug: 'original', slugHistory: ['older', 'original'], tags: ['preserved'], status: 'draft', revision: 1, createdAt: '2026-01-01', updatedAt: '2026-01-01', body: [{ type: 'paragraph', text: 'Keep me' }], primaryAssetId: 'asset' };
    await new LocalCreatorLibraryStore(local.database).createWork(work);
    const storage = { bucket: 'cell', key: 'private-original', versionId: 'source-v1', scope: 'private', contentType: 'image/png', byteLength: 10, checksum: 'a'.repeat(64) };
    const rendition = { id: 'preview', role: 'preview', sourceVersionId: 'source-v1', storage: { ...storage, key: 'selected-preview', versionId: 'preview-v1', contentType: 'image/webp' } };
    const asset = { ...scope, assetId: 'asset', status: 'pending', mimeType: 'image/png', sizeBytes: 10, checksumSha256: storage.checksum, storage, createdAt: work.createdAt, updatedAt: work.updatedAt,
      processing: { state: 'completed', sourceVersionId: 'source-v1', completedAt: work.updatedAt, metadata: {}, renditions: [rendition] } };
    put('asset', 'asset', asset);
    put('work_assets', 'work', [{ workId: 'work', assetId: 'asset', role: 'primary', position: 0 }]);

    for (const invalidScope of [{ ...scope, tenantId: 'other' }, { ...scope, creatorId: 'other' }, { ...scope, workId: 'missing' }]) {
      const view = new LocalLibraryPublicationView(local.database, invalidScope, () => 'preview');
      await assert.rejects(view.works.get(invalidScope.workId), { code: 'not_found' });
    }
    const pageView = create(undefined, snapshot => { snapshot.storage.key = 'mutated'; return 'preview'; }).view;
    const attachments = [{ workId: 'work', assetId: 'asset', role: 'primary', position: 0 }];
    for (let index = 1; index <= 101; index++) {
      const assetId = `asset-${index}`;
      put('asset', assetId, { ...asset, assetId });
      attachments.push({ workId: 'work', assetId, role: 'content', position: index });
    }
    put('work_assets', 'work', attachments);
    const page = await pageView.assets.list({ limit: 100 });
    assert.equal(page.items.length, 100); assert.ok(page.nextCursor);
    const last = await pageView.assets.list({ limit: 100, cursor: page.nextCursor });
    assert.equal(last.items.length, 2); assert.equal(last.nextCursor, undefined);
    assert.equal((await new LocalCreatorLibraryStore(local.database).getProcessingAsset('tenant', 'asset')).storage.key, 'private-original');
    put('work_assets', 'work', [attachments[0]]);

    await assert.rejects(create().service.publish({ ...input, actorId: 'stranger' }), /ownership denied/);
    await assert.rejects(create(async () => { throw new Error('held'); }).service.publish(input), /held/);
    await emptyReceipts();
    // Missing selection, stale source processing, and failed/deleted assets never become ready.
    await assert.rejects(create(undefined, () => undefined).service.publish(input), { code: 'processing_incomplete' });
    for (const invalid of [
      { ...asset, storage: { ...storage, versionId: 'source-v2' } },
      { ...asset, status: 'failed' }, { ...asset, status: 'deleted' },
      { ...asset, processing: { ...asset.processing, renditions: [{ ...rendition, sourceVersionId: 'older' }] } }
    ]) {
      put('asset', 'asset', invalid);
      await assert.rejects(create().service.publish(input), { code: 'processing_incomplete' });
      await emptyReceipts();
    }
    put('asset', 'asset', asset);
    // Change an admitted asset before commit: no partial receipt or status may survive.
    await assert.rejects(create(async () => { put('asset', 'asset', { ...asset, storage: { ...storage, versionId: 'source-v2' } }); }).service.publish(input), { name: 'OptimisticConcurrencyError' });
    await emptyReceipts(); put('asset', 'asset', asset);
    await assert.rejects(create(async () => { put('work_assets', 'work', []); }).service.publish(input), { name: 'OptimisticConcurrencyError' });
    await emptyReceipts(); put('work_assets', 'work', [attachments[0]]);
    const failing = create();
    failing.view.auditEvents.create = async () => { throw new Error('final audit failure'); };
    await assert.rejects(failing.service.publish(input), /final audit failure/);
    await emptyReceipts();

    let selected;
    const first = await create(async (_work, assets) => { selected = assets; }).service.publish(input);
    assert.equal(first.idempotent, false);
    assert.equal(first.work.id, 'work'); assert.equal(first.work.workId, 'work');
    assert.equal(first.work.revision, 2); assert.equal(first.work.status, 'published');
    assert.deepEqual(first.work.body, work.body); assert.deepEqual(first.work.slugHistory, work.slugHistory);
    assert.equal(selected[0].id, 'asset'); assert.equal(selected[0].storage.key, 'selected-preview');
    assert.equal(selected[0].objectVersion, 'preview-v1');
    assert.equal(JSON.stringify(selected).includes('private-original'), false);
    assert.equal((await new LocalCreatorLibraryStore(local.database).getWork('tenant', 'work')).status, 'published');
    assert.deepEqual((await local.repositories.works.list({ limit: 100 })).items, []);
    assert.deepEqual((await local.repositories.assets.list({ limit: 100 })).items, []);
    local.database.database.close(); local = createLocalAdapterSet(configuration);
    const replay = await create(async () => { throw new Error('replay must not publish again'); }).service.publish(input);
    assert.equal(replay.idempotent, true); assert.equal(replay.work.revision, 2);
    assert.deepEqual(replay.publication, first.publication);
    for (const name of ['publicationIntents', 'publications', 'auditEvents']) assert.equal((await local.repositories[name].list({ limit: 100 })).items.length, 1);
    await assert.rejects(create().view.works.update('work', 2, { status: 'published' }), /owned transaction/);
  } finally { local.database.database.close(); rmSync(directory, { recursive: true, force: true }); }
});
