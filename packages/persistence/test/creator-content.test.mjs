import assert from "node:assert/strict";
import test from "node:test";
import { MemoryCreatorContentStore } from "../dist/index.js";

const work = (tenantId, workId, extra = {}) => ({ tenantId, workId, creatorId: "creator", status: "draft", updatedAt: "2026-09-04T00:00:00Z", ...extra });

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
