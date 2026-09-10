import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalSqliteDatabase, LocalCreatorLibraryStore, LocalSqliteJobQueue } from '../dist/index.js';
import { CreatorAssetService, CreatorAssetRegenerationService } from '@ubeeq/core';

for (const enabled of [false, true]) test(`audio attachment and regeneration are explicitly enabled=${enabled}`, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ubeeq-audio-jobs-'));
  const configuration = { databasePath: join(directory, 'state.sqlite'), dataDirectory: directory, publicBaseUrl: 'http://localhost', cellId: 'cell' };
  let db = new LocalSqliteDatabase(configuration);
  const options = { enqueueAudioProcessing: enabled };
  try {
    let store = new LocalCreatorLibraryStore(db, options), queue = new LocalSqliteJobQueue(db);
    const work = { tenantId: 'tenant', creatorId: 'creator', workId: 'work', title: 'Audio', slug: 'audio', tags: [], status: 'draft', revision: 1, createdAt: 'before', updatedAt: 'before' };
    await store.createWork(work);
    const storage = { bucket: 'private', key: 'source', versionId: 'v1', contentType: 'audio/wav', byteLength: 1, checksum: 'a'.repeat(64), scope: 'private' };
    const asset = { tenantId: 'tenant', creatorId: 'creator', assetId: 'asset', status: 'pending', mimeType: 'audio/wav', sizeBytes: 1,
      checksumSha256: storage.checksum, storage, createdAt: 'before', updatedAt: 'before' };
    const attach = () => new CreatorAssetService(store, async () => true).attach('tenant', 'work', asset);
    await assert.rejects(db.transaction(async () => { await attach(); throw new Error('receipt failed'); }), /receipt failed/);
    assert.equal((await queue.list({ cellId: 'cell', limit: 100 })).length, 0);
    assert.equal((await store.getWork('tenant', 'work')).revision, 1);
    assert.deepEqual(await store.listCanonicalAssetsByWork('tenant', 'work'), []);
    await attach();
    assert.equal((await queue.list({ cellId: 'cell', limit: 100 })).length, enabled ? 1 : 0);
    db.database.close(); db = new LocalSqliteDatabase(configuration);
    store = new LocalCreatorLibraryStore(db, options); queue = new LocalSqliteJobQueue(db);
    const service = new CreatorAssetRegenerationService(store, async () => true, async () => {});
    const request = { tenantId: 'tenant', workId: 'work', assetId: 'asset', sourceVersionId: 'v1', expectedRevision: 2, requestId: 'regenerate' };
    if (!enabled) {
      await assert.rejects(service.request(request), { code: 'processing_unsupported' });
      return;
    }
    const lease = await queue.lease({ cellId: 'cell', workerId: 'worker', leaseDurationSeconds: 60 });
    assert.deepEqual(lease.job.payload, { tenantId: 'tenant', creatorId: 'creator', workId: 'work', assetId: 'asset', sourceVersionId: 'v1' });
    const rendition = { id: 'audio:v1', sourceVersionId: 'v1', role: 'preview', storage: { ...storage, key: 'audio', versionId: 'output', contentType: 'audio/mpeg' } };
    await store.commitAssetProcessing({ ...lease.job.payload, jobId: lease.job.id, leaseToken: lease.leaseToken, metadata: { durationSeconds: 1 }, renditions: [rendition] });
    const previous = await store.getProcessingAsset('tenant', 'asset');
    await assert.rejects(service.request({ ...request, squareCrop: { x: 0, y: 0, size: 1 } }), { code: 'processing_unsupported' });
    await assert.rejects(new CreatorAssetRegenerationService(store, async () => false, async () => {}).request(request), { code: 'access_denied' });
    const receipts = await Promise.all([service.request(request), service.request(request)]);
    assert.equal(receipts[0].jobId, receipts[1].jobId);
    await assert.rejects(service.request({ ...request, requestId: 'other' }), { code: 'processing_busy' });
    assert.deepEqual((await store.getProcessingAsset('tenant', 'asset')).processing, previous.processing);
    assert.deepEqual((await store.getProcessingAsset('tenant', 'asset')).storage, storage);
    db.database.close(); db = new LocalSqliteDatabase(configuration);
    const restored = new CreatorAssetRegenerationService(new LocalCreatorLibraryStore(db, options), async () => true, async () => {});
    assert.equal((await restored.request(request)).jobId, receipts[0].jobId);
  } finally { db.database.close(); rmSync(directory, { recursive: true, force: true }); }
});
