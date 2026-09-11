import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalSqliteDatabase, LocalCreatorLibraryStore, LocalSqliteJobQueue } from '../dist/index.js';
import { CreatorAssetService, CreatorAssetRegenerationService } from '@ubeeq/core';

test('regeneration is scoped, durable, deduplicated and preserves completed outputs until fenced replacement', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ubeeq-regenerate-'));
  const configuration = { databasePath: join(directory, 'state.sqlite'), dataDirectory: directory, publicBaseUrl: 'http://localhost', cellId: 'cell' };
  let db = new LocalSqliteDatabase(configuration);
  try {
    let store = new LocalCreatorLibraryStore(db, { enqueueImageProcessing: true, allowSquareCrop: true }), queue = new LocalSqliteJobQueue(db);
    const work = { tenantId: 'tenant', creatorId: 'creator', workId: 'work', title: 'Keep', slug: 'work', tags: [], status: 'draft', revision: 1, createdAt: 'before', updatedAt: 'before' };
    await store.createWork(work);
    const storage = { bucket: 'private', key: 'source', versionId: 'v1', contentType: 'image/png', byteLength: 1, checksum: 'a'.repeat(64), scope: 'private' };
    const asset = { tenantId: 'tenant', creatorId: 'creator', assetId: 'asset', status: 'pending', mimeType: 'image/png', sizeBytes: 1,
      checksumSha256: storage.checksum, storage, createdAt: 'before', updatedAt: 'before' };
    await new CreatorAssetService(store, async () => true).attach('tenant', 'work', asset);
    const request = { tenantId: 'tenant', workId: 'work', assetId: 'asset', sourceVersionId: 'v1', expectedRevision: 2, requestId: 'upgrade', squareCrop: { x: 3, y: 2, size: 4 } };
    let service = new CreatorAssetRegenerationService(store, async () => true, async () => {});
    await assert.rejects(service.request(request), { code: 'processing_busy' });
    await assert.rejects(new CreatorAssetRegenerationService(store, async () => false, async () => {}).request(request), { code: 'access_denied' });
    await assert.rejects(new CreatorAssetRegenerationService(store, async () => true, async () => { throw new Error('policy hold'); }).request(request), /policy hold/);
    const initial = await queue.lease({ cellId: 'cell', workerId: 'worker', leaseDurationSeconds: 60 });
    const output = { id: 'preview:asset:v1', sourceVersionId: 'v1', role: 'preview', storage: { ...storage, key: 'old', versionId: 'old', contentType: 'image/jpeg' } };
    await store.commitAssetProcessing({ ...initial.job.payload, jobId: initial.job.id, leaseToken: initial.leaseToken, metadata: { width: 10 }, renditions: [output] });
    const before = await store.getProcessingAsset('tenant', 'asset');
    await assert.rejects(new CreatorAssetRegenerationService(new LocalCreatorLibraryStore(db, { enqueueImageProcessing: true }), async () => true, async () => {}).request(request), { code: 'processing_unsupported' });
    for (const squareCrop of [null, { x: 0, y: 0 }, { x: NaN, y: 0, size: 1 }, { x: 0, y: 0, size: 0 }, { x: 0, y: 0, size: 1, extra: true }]) {
      await assert.rejects(service.request({ ...request, squareCrop }), { code: 'invalid_request' });
      await assert.rejects(store.enqueueAssetRegeneration({ ...request, creatorId: 'creator', squareCrop }), { code: 'invalid_request' });
    }
    for (const [change, code] of [[{ requestId: '' }, 'invalid_request'], [{ expectedRevision: 1 }, 'revision_conflict'],
      [{ sourceVersionId: 'stale' }, 'source_changed'], [{ assetId: 'missing' }, 'not_found']]) {
      await assert.rejects(service.request({ ...request, ...change }), { code });
    }
    await assert.rejects(store.enqueueAssetRegeneration({ ...request, creatorId: 'foreign' }), { code: 'not_found' });
    db.database.exec("CREATE TRIGGER fail_regeneration BEFORE UPDATE ON ubeeq_creator_library WHEN NEW.kind = 'asset' BEGIN SELECT RAISE(ABORT, 'injected fence failure'); END");
    await assert.rejects(service.request(request), /injected fence failure/);
    db.database.exec('DROP TRIGGER fail_regeneration');
    assert.equal((await queue.list({ cellId: 'cell', limit: 100 })).length, 1);
    assert.deepEqual(await store.getProcessingAsset('tenant', 'asset'), before);
    const receipts = await Promise.all([service.request(request), service.request(request)]);
    assert.equal(receipts[0].jobId, receipts[1].jobId);
    assert.deepEqual(receipts.map(item => item.idempotent).sort(), [false, true]);
    await assert.rejects(service.request({ ...request, squareCrop: { x: 4, y: 2, size: 4 } }), { code: 'invalid_request' });
    await assert.rejects(service.request({ ...request, squareCrop: undefined }), { code: 'invalid_request' });
    assert.deepEqual(await store.getProcessingAsset('tenant', 'asset'), { ...before, processingJobId: receipts[0].jobId });
    await assert.rejects(service.request({ ...request, requestId: 'competing' }), { code: 'processing_busy' });
    db.database.close(); db = new LocalSqliteDatabase(configuration);
    store = new LocalCreatorLibraryStore(db, { enqueueImageProcessing: true, allowSquareCrop: true }); queue = new LocalSqliteJobQueue(db);
    service = new CreatorAssetRegenerationService(store, async () => true, async () => {});
    assert.equal((await service.request(request)).jobId, receipts[0].jobId);
    const lease = await queue.lease({ cellId: 'cell', workerId: 'worker', leaseDurationSeconds: 60 });
    assert.equal(lease.job.id, receipts[0].jobId);
    assert.deepEqual(lease.job.payload.squareCrop, request.squareCrop);
    await queue.deadLetter({ id: lease.job.id, leaseToken: lease.leaseToken, error: { code: 'test', message: 'failure' } });
    assert.deepEqual((await store.getProcessingAsset('tenant', 'asset')).processing, before.processing);
    const replacement = await service.request({ ...request, requestId: 'new-attempt' });
    // An operator may recover the old failed job. Its lease cannot replace newer admitted output.
    await queue.recover({ id: lease.job.id });
    const recovered = await queue.lease({ cellId: 'cell', workerId: 'worker', leaseDurationSeconds: 60 });
    const another = await queue.lease({ cellId: 'cell', workerId: 'worker', leaseDurationSeconds: 60 });
    const stale = [recovered, another].find(item => item.job.id === lease.job.id);
    const current = [recovered, another].find(item => item.job.id === replacement.jobId);
    await assert.rejects(store.commitAssetProcessing({ ...stale.job.payload, jobId: stale.job.id, leaseToken: stale.leaseToken, metadata: {}, renditions: [output] }), /source or ownership changed/);
    await store.commitAssetProcessing({ ...current.job.payload, jobId: current.job.id, leaseToken: current.leaseToken,
      metadata: { width: 10 }, renditions: [{ ...output, storage: { ...output.storage, key: 'new', versionId: 'new' } }] });
    assert.equal((await store.getProcessingAsset('tenant', 'asset')).processing.renditions[0].storage.versionId, 'new');
    assert.equal((await service.request({ ...request, requestId: 'new-attempt' })).state, 'completed');
    assert.equal((await store.getWork('tenant', 'work')).revision, 2);
  } finally { db.database.close(); rmSync(directory, { recursive: true, force: true }); }
});
