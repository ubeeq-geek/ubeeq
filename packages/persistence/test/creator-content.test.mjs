import assert from "node:assert/strict";
import test from "node:test";
import { MemoryCreatorContentStore } from "../dist/index.js";

const work = (tenantId, workId, extra = {}) => ({ tenantId, workId, creatorId: "creator", status: "draft", updatedAt: "2026-09-04T00:00:00Z", ...extra });
test('atomic source commits append after sparse positions and reject stale positions', async () => {
  const store = new MemoryCreatorContentStore();
  await store.createWork(work('one', 'target', { revision: 1 }));
  await store.attachAssetToWork('one', { workId: 'target', assetId: 'existing', position: 3 });
  const asset = { tenantId: 'one', creatorId: 'creator', assetId: 'new', status: 'ready', checksumSha256: 'a'.repeat(64) };
  const input = { previousRevision: 1, work: work('one', 'target', { revision: 2 }), asset, attachment: { workId: 'target', assetId: 'new', position: 4 } };
  await assert.rejects(store.commitAssetAttachment({ ...input, attachment: { ...input.attachment, position: 1 } }));
  await store.commitAssetAttachment(input);
  await store.createWork(work('one', 'reuse-target', { revision: 1 }));
  await store.attachAssetToWork('one', { workId: 'reuse-target', assetId: 'other', position: 8 });
  const reuse = { previousRevision: 1, work: work('one', 'reuse-target', { revision: 2 }), sourceWorkId: 'target', expectedAsset: asset,
    attachment: { workId: 'reuse-target', assetId: 'new', position: 9 }, receipt: { tenantId: 'one', creatorId: 'creator', workId: 'reuse-target', assetId: 'new', checksum: 'a'.repeat(64), receiptId: 'receipt', sourceIdentity: 'source' } };
  await assert.rejects(store.commitSourceReuse({ ...reuse, attachment: { ...reuse.attachment, position: 1 } }));
  await store.commitSourceReuse(reuse);
  assert.equal((await store.getSourceReceipt('one', 'receipt')).assetId, 'new');
});

test('creator asset inventory includes detached records beyond a first page without leaking scope or mutable state', async () => {
  const store = new MemoryCreatorContentStore();
  for (let i = 0; i < 102; i++) await store.createCanonicalAsset({ tenantId: 'one', creatorId: 'creator', assetId: `asset-${i}`, storage: { key: `original-${i}` } });
  await store.createCanonicalAsset({ tenantId: 'two', creatorId: 'creator', assetId: 'foreign' });
  await store.createCanonicalAsset({ tenantId: 'one', creatorId: 'other', assetId: 'other' });
  await store.attachAssetToWork('one', { workId: 'work', assetId: 'asset-0', position: 0 });
  await store.detachAssetFromWork('one', 'work', 'asset-0');
  const inventory = await store.listCanonicalAssetsByCreator('one', 'creator');
  assert.equal(inventory.length, 102);
  assert.equal(inventory[101].assetId, 'asset-101');
  inventory[0].storage.key = 'mutated';
  assert.equal((await store.getCanonicalAsset('one', 'asset-0')).storage.key, 'original-0');
});

test('memory collection recovery remains opt-in and tenant/creator scoped', async () => {
  const store = new MemoryCreatorContentStore();
  for (const [id, tenantId, creatorId, status] of [['active', 'one', 'creator', 'draft'], ['removed', 'one', 'creator', 'deleted'], ['foreign', 'two', 'creator', 'deleted'], ['other', 'one', 'other', 'deleted']]) {
    await store.createCreatorCollection({ collectionId: id, title: id, tenantId, creatorId, status, updatedAt: 'now' });
  }
  assert.deepEqual((await store.listCreatorCollections('one', 'creator')).map(c => c.collectionId), ['active']);
  assert.deepEqual((await store.listCreatorCollections('one', 'creator', { includeDeleted: true })).map(c => c.collectionId), ['active', 'removed']);
});

test('source reuse receipts commit with membership and preserve removals and later creator edits', async () => {
  const store = new MemoryCreatorContentStore();
  const source = work('one', 'source', { revision: 1 }), target = work('one', 'target', { revision: 1 });
  await store.createWork(source); await store.createWork(target);
  const asset = { tenantId: 'one', creatorId: 'creator', assetId: 'asset', status: 'ready', checksumSha256: 'a'.repeat(64), storage: { mode: 'hosted', objectKey: 'private-original' } };
  await store.createCanonicalAsset(asset); await store.attachAssetToWork('one', { workId: 'source', assetId: 'asset', role: 'source', position: 0 });
  const input = { previousRevision: 1, work: { ...target, revision: 2, primaryAssetId: 'asset' }, sourceWorkId: 'source', expectedAsset: structuredClone(asset),
    attachment: { workId: 'target', assetId: 'asset', role: 'source', position: 0 },
    receipt: { tenantId: 'one', creatorId: 'creator', receiptId: 'receipt', sourceIdentity: 'opaque-source', workId: 'target', assetId: 'asset', checksum: asset.checksumSha256 } };
  const snapshot = () => JSON.stringify(store);
  const before = snapshot();
  for (const invalid of [{ ...input, previousRevision: 0 }, { ...input, sourceWorkId: 'missing' },
    { ...input, receipt: { ...input.receipt, creatorId: 'other' } }, { ...input, expectedAsset: { ...asset, status: 'deleted' } },
    { ...input, attachment: { ...input.attachment, position: 1 } }]) {
    await assert.rejects(store.commitSourceReuse(invalid), { code: 'revision_conflict' }); assert.equal(snapshot(), before);
  }
  await assert.rejects(store.commitSourceReuse({ ...input, work: { ...input.work, unserializable: () => {} } }));
  assert.equal(snapshot(), before);
  await store.commitSourceReuse(input);
  assert.equal(store.sourceReceipts.length, 1); assert.equal(store.canonicalAssets.length, 1);
  assert.equal((await store.listCanonicalAssetsByWork('one', 'target')).length, 1);
  const receipt = await store.getSourceReceipt('one', 'receipt'); receipt.assetId = 'changed';
  assert.equal((await store.getSourceReceipt('one', 'receipt')).assetId, 'asset');
  assert.equal(await store.getSourceReceipt('other', 'receipt'), null);
  const restored = Object.assign(new MemoryCreatorContentStore(), JSON.parse(snapshot()));
  await restored.updateWork({ ...input.work, title: 'Creator edit', revision: 3 });
  await restored.detachAssetFromWork('one', 'source', 'asset');
  await restored.commitSourceReuse(input);
  assert.equal((await restored.getWork('one', 'target')).title, 'Creator edit');
  assert.equal((await restored.getWork('one', 'target')).revision, 3);
  await assert.rejects(restored.commitSourceReuse({ ...input, receipt: { ...input.receipt, sourceIdentity: 'different' } }), { code: 'revision_conflict' });
  await restored.detachAssetFromWork('one', 'target', 'asset');
  await assert.rejects(restored.commitSourceReuse(input), { code: 'revision_conflict' });
  assert.equal((await restored.listCanonicalAssetsByWork('one', 'target')).length, 0);
  assert.equal(restored.sourceReceipts.length, 1);
});

test("asset metadata commit rejects stale or foreign writes without partial state", async () => {
  const store = new MemoryCreatorContentStore();
  const original = work("one", "work", { revision: 1 });
  await store.createWork(original);
  const input = { previousRevision: 1, work: { ...original, revision: 2, primaryAssetId: "asset" },
    asset: { tenantId: "one", creatorId: "creator", assetId: "asset", storage: { mode: "hosted", objectKey: "original" } },
    attachment: { workId: "work", assetId: "asset", position: 0, role: "primary" } };
  for (const invalid of [{ ...input, previousRevision: 0 }, { ...input, asset: { ...input.asset, tenantId: "other" } },
    { ...input, attachment: { ...input.attachment, position: 2 } }]) {
    await assert.rejects(store.commitAssetAttachment(invalid), { code: "revision_conflict" });
    assert.equal(store.canonicalAssets.length, 0);
    assert.equal(store.workAssets.length, 0);
    assert.equal(store.works[0].revision, 1);
  }
  await store.commitAssetAttachment(input);
  assert.equal(store.works[0].revision, 2);
  await assert.rejects(store.commitWorkRevision({ ...original, title: 'Stale edit', revision: 2 }, 1), { code: 'revision_conflict' });
  assert.equal(store.works[0].primaryAssetId, 'asset');
  assert.deepEqual(store.canonicalAssets[0].storage, input.asset.storage);
  await assert.rejects(store.commitAssetAttachment(input), { code: "revision_conflict" });
  assert.equal(store.canonicalAssets.length, 1);
  assert.equal(store.workAssets.length, 1);
  await store.commitWorkRevision({ ...store.works[0], title: 'Current edit', revision: 3 }, 2);
  assert.equal(store.works[0].title, 'Current edit');
  assert.equal(store.works[0].primaryAssetId, 'asset');
});

test("canonical records preserve tenant boundaries, lifecycle filtering and metadata", async () => {
  const store = new MemoryCreatorContentStore();
  await store.createWork(work("one", "same", { customField: { retained: true } }));
  await store.createWork(work("two", "same"));
  await store.createWork(work("one", "deleted", { status: "deleted" }));
  assert.deepEqual((await store.listWorksByCreator("one", "creator")).map(item => item.workId), ["same"]);
  assert.deepEqual((await store.listWorksByCreator("one", "creator", { includeDeleted: true })).map(item => item.workId), ["same", "deleted"]);
  assert.deepEqual(await store.listWorksByCreator("one", "foreign", { includeDeleted: true }), []);
  assert.deepEqual((await store.getWork("one", "same")).customField, { retained: true });
  assert.equal(await store.getWork("foreign", "same"), null);
  await store.updateWork(work("one", "same", { status: "ready" }));
  assert.equal((await store.getWork("two", "same")).status, "draft");
});

test("asset attachment order, detached assets and collection membership remain independent", async () => {
  const store = new MemoryCreatorContentStore();
  for (const tenantId of ["one", "two"]) {
    await store.createWork(work(tenantId, "work"));
    await store.createCanonicalAsset({ tenantId, creatorId: "creator", assetId: "image" });
    await store.attachAssetToWork(tenantId, { workId: "work", assetId: "image", position: 1 });
    await store.createCreatorCollection({ tenantId, creatorId: "creator", collectionId: "collection", title: "Collection", status: "published" });
    await store.replaceCollectionWorks(tenantId, "collection", [{ collectionId: "collection", workId: "work", position: 0 }]);
  }
  await store.attachAssetToWork("one", { workId: "work", assetId: "image", position: 0 });
  const assets = await store.listCanonicalAssetsByWork("one", "work");
  assert.equal(assets.length, 1);
  assert.equal(assets[0].attachment.position, 0);
  assert.equal("tenantId" in assets[0].attachment, false);
  await store.detachAssetFromWork("one", "work", "image");
  assert.equal((await store.listCanonicalAssetsByWork("one", "work")).length, 0);
  assert.equal((await store.listCanonicalAssetsByWork("two", "work")).length, 1);
  assert.ok(await store.getCanonicalAsset("one", "image"));
  await store.replaceCollectionWorks("one", "collection", []);
  assert.equal((await store.listCollectionWorks("two", "collection")).length, 1);
  await assert.rejects(store.replaceCollectionWorks("missing", "collection", []), /Collection not found/);
});

test("publication validation runs before replacement and snapshot-shaped state can be restored", async () => {
  class ProductStore extends MemoryCreatorContentStore {
    async validatePublication(previous, next) {
      if (previous?.immutable !== undefined && previous.immutable !== next.immutable) throw Error("immutable history");
    }
  }
  const store = new ProductStore();
  const publication = { tenantId: "one", workId: "work", publicationId: "publication", destination: "product", updatedAt: "2026-09-04T00:00:00Z", immutable: "original" };
  await store.upsertPublication(publication);
  await assert.rejects(store.upsertPublication({ ...publication, immutable: "replacement" }), /immutable history/);
  assert.equal((await store.getPublication("one", "publication")).immutable, "original");
  await store.upsertPublicationIntent({ tenantId: "one", workId: "work", publicationIntentId: "intent", updatedAt: publication.updatedAt });
  await store.upsertWorkDiscoveryParticipation({ tenantId: "one", workId: "work", state: "none" });
  const snapshot = JSON.parse(JSON.stringify(store));
  const restored = Object.assign(new ProductStore(), snapshot);
  assert.deepEqual(await restored.listPublicationsByDestination("one", "product"), [publication]);
  assert.equal((await restored.listPublicationIntentsByWork("one", "work")).length, 1);
  assert.equal((await restored.getWorkDiscoveryParticipation("one", "work")).state, "none");
  await restored.deletePublicationIntent("one", "intent");
  assert.equal(await restored.getPublicationIntent("one", "intent"), null);
});
