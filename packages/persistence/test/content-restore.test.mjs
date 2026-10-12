import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryCreatorContentStore } from '../dist/index.js';
const graph = () => ({ restoreId: 'restore', fingerprint: 'a'.repeat(64), tenantId: 'tenant', creatorId: 'creator',
  works: [{ tenantId: 'tenant', creatorId: 'creator', workId: 'work', status: 'draft', updatedAt: 'now' }],
  assets: [{ tenantId: 'tenant', creatorId: 'creator', assetId: 'asset' }], attachments: [{ workId: 'work', assetId: 'asset', position: 0 }],
  publications: [], intents: [], collections: [{ tenantId: 'tenant', creatorId: 'creator', collectionId: 'collection', title: 'Collection', status: 'draft' }],
  collectionWorks: [{ collectionId: 'collection', workId: 'work', position: 0 }], discovery: [] });
test('commits a complete graph once and preserves later edits on replay', async () => {
  const store = new MemoryCreatorContentStore(), input = graph();
  const receipt = await store.commitContentRestore(input); assert.equal(store.works.length, 1); assert.equal(store.workAssets.length, 1);
  store.works[0].status = 'archived';
  assert.deepEqual(await store.commitContentRestore(input), receipt); assert.equal(store.works[0].status, 'archived'); assert.equal(store.canonicalAssets.length, 1);
});
test('ID collisions fail atomically across foreign creators in the same tenant', async () => {
  const store = new MemoryCreatorContentStore(); store.canonicalAssets.push({ tenantId: 'tenant', creatorId: 'other', assetId: 'asset' });
  await assert.rejects(store.commitContentRestore(graph())); assert.equal(store.works.length, 0); assert.equal(store.creatorCollections.length, 0); assert.equal(store.contentRestores.length, 0);
});
test('dangling edges, duplicate positions, foreign ownership and changed restore identities are rejected', async () => {
  for (const mutate of [input => input.attachments[0].assetId = 'missing', input => input.assets[0].creatorId = 'foreign',
    input => input.attachments.push({ workId: 'work', assetId: 'asset', position: 0 })]) {
    const store = new MemoryCreatorContentStore(), input = graph(); mutate(input); await assert.rejects(store.commitContentRestore(input)); assert.equal(store.works.length, 0);
  }
  const store = new MemoryCreatorContentStore(); await store.commitContentRestore(graph());
  await assert.rejects(store.commitContentRestore({ ...graph(), fingerprint: 'b'.repeat(64) }));
});
