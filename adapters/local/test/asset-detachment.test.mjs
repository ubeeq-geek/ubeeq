import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalSqliteDatabase, LocalCreatorLibraryStore, LocalSqliteJobQueue } from '../dist/index.js';
import { CreatorAssetService, CreatorAssetDetachmentService } from '@ubeeq/core';

test('detachment preserves stored assets, guards references and atomically cancels only matching active jobs', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ubeeq-detach-'));
  const db = new LocalSqliteDatabase({ databasePath: join(directory, 'state.sqlite'), dataDirectory: directory, publicBaseUrl: 'http://localhost', cellId: 'cell' });
  try {
    const store = new LocalCreatorLibraryStore(db, { enqueueImageProcessing: true }), queue = new LocalSqliteJobQueue(db);
    const work = { tenantId: 'tenant', creatorId: 'creator', workId: 'work', title: 'Keep', slug: 'work', slugHistory: ['work'], tags: [], status: 'draft', revision: 1, createdAt: 'before', updatedAt: 'before' };
    await store.createWork(work);
    const uploads = new CreatorAssetService(store, async () => true);
    const asset = id => ({ tenantId: 'tenant', creatorId: 'creator', assetId: id, status: 'pending', mimeType: 'image/png', sizeBytes: 1, checksumSha256: 'a'.repeat(64), storage: { scope: 'private', byteLength: 1, checksum: 'a'.repeat(64), versionId: 'v1' } });
    await uploads.attach('tenant', 'work', asset('a'));
    const lease = await queue.lease({ cellId: 'cell', workerId: 'worker', leaseDurationSeconds: 60 });
    await uploads.attach('tenant', 'work', asset('b'));
    const detach = new CreatorAssetDetachmentService(store, async () => true);
    await assert.rejects(new CreatorAssetDetachmentService(store, async () => false).detach('tenant', 'work', 'a', 3), { code: 'access_denied' });
    await assert.rejects(detach.detach('tenant', 'work', 'missing', 3), { code: 'not_found' });
    const referenced = { ...await store.getWork('tenant', 'work'), revision: 4, body: [{ id: 'image', type: 'image', assetId: 'a' }] };
    await store.commitWorkRevision(referenced, 3);
    await assert.rejects(detach.detach('tenant', 'work', 'a', 4), { code: 'asset_in_use' });
    await assert.rejects(store.commitAssetDetachment({ ...work, assetId: 'a', expectedRevision: 4 }), { code: 'asset_in_use' });
    assert.equal((await queue.get(lease.job.id)).state, 'leased');
    await store.commitWorkRevision({ ...referenced, body: [], revision: 5 }, 4);
    const next = await detach.detach('tenant', 'work', 'a', 5);
    assert.equal(next.primaryAssetId, 'b'); assert.equal(next.revision, 6);
    assert.deepEqual((await store.listCanonicalAssetsByWork('tenant', 'work')).map(item => [item.assetId, item.attachment.role, item.attachment.position]), [['b', 'primary', 0]]);
    assert.deepEqual(await store.getProcessingAsset('tenant', 'a'), asset('a'));
    assert.equal((await queue.get(lease.job.id)).state, 'cancelled');
    await assert.rejects(queue.recover({ id: lease.job.id }), { code: 'job_not_recoverable' });
    assert.equal((await queue.get(lease.job.id)).state, 'cancelled');
    await assert.rejects(queue.complete({ id: lease.job.id, leaseToken: lease.leaseToken }));
    assert.deepEqual((await queue.list({ cellId: 'cell', states: ['queued'], limit: 10 })).map(job => job.payload.assetId), ['b']);
    await assert.rejects(detach.detach('tenant', 'work', 'b', 5), { code: 'revision_conflict' });
    const empty = await detach.detach('tenant', 'work', 'b', 6);
    assert.equal(empty.primaryAssetId, undefined);
    assert.deepEqual(await store.listCanonicalAssetsByWork('tenant', 'work'), []);
    assert.equal((await queue.list({ cellId: 'cell', states: ['cancelled'], limit: 10 })).length, 2);
  } finally { db.database.close(); rmSync(directory, { recursive: true, force: true }); }
});
