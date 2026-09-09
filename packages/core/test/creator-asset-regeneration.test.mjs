import test from 'node:test';
import assert from 'node:assert/strict';
import { CreatorAssetRegenerationService } from '../dist/index.js';

test('crop admission and caller mutation cannot change the snapshotted regeneration request', async () => {
  const request = { tenantId: 'tenant', workId: 'work', assetId: 'asset', sourceVersionId: 'source', expectedRevision: 1, requestId: 'request', squareCrop: { x: 1, y: 2, size: 3 } };
  let saved;
  const store = {
    getWork: async () => { request.squareCrop.x = 999; return { tenantId: 'tenant', creatorId: 'creator', workId: 'work', status: 'draft' }; },
    enqueueAssetRegeneration: async value => { saved = value; return { jobId: 'job', state: 'queued', idempotent: false }; }
  };
  const service = new CreatorAssetRegenerationService(store, async () => true, async value => {
    assert.deepEqual(value.squareCrop, { x: 1, y: 2, size: 3 }); value.squareCrop.size = 999;
  });
  await service.request(request);
  assert.deepEqual(saved.squareCrop, { x: 1, y: 2, size: 3 }); assert.equal(saved.creatorId, 'creator');
});

test('malformed crop requests fail before authorization or persistence', async () => {
  let reads = 0;
  const service = new CreatorAssetRegenerationService({ getWork: async () => { reads++; } }, async () => true, async () => {});
  for (const squareCrop of [null, [], { x: 0, y: 0, size: Infinity }, { x: 0, y: 0, size: -1 }, { x: '1', y: 0, size: 2 }, { x: 0, y: 0, size: 1, unknown: 1 }]) {
    await assert.rejects(service.request({ tenantId: 'tenant', workId: 'work', assetId: 'asset', sourceVersionId: 'source', expectedRevision: 1, requestId: 'request', squareCrop }), { code: 'invalid_request' });
  }
  assert.equal(reads, 0);
});
