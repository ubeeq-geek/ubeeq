import assert from "node:assert/strict";
import test from "node:test";
import { CreatorCollectionService } from "../dist/index.js";

const scope = { tenantId: "tenant", creatorId: "creator" };
const collection = (id, slug = id) => ({ ...scope, collectionId: id, slug, slugHistory: [slug], status: "draft", updatedAt: "before", productMetadata: { preserved: true } });
const work = (id, extra = {}) => ({ ...scope, workId: id, status: "draft", ...extra });

function fixture(allowed = true) {
  const collections = new Map();
  const works = new Map();
  const memberships = new Map();
  const calls = [];
  let writes = 0;
  const store = {
    async listCreatorCollections(tenantId, creatorId) { return [...collections.values()].filter((c) => c.tenantId === tenantId && c.creatorId === creatorId && c.status !== "deleted"); },
    async getCreatorCollection(tenantId, id) { const c = collections.get(id); return c?.tenantId === tenantId ? c : null; },
    async createCreatorCollection(c) { writes++; collections.set(c.collectionId, c); },
    async updateCreatorCollection(c) { writes++; collections.set(c.collectionId, c); },
    async listCollectionWorks(tenantId, id) { return memberships.get(id) || []; },
    async replaceCollectionWorks(tenantId, id, items) { writes++; memberships.set(id, items); },
    async getWork(tenantId, id) { const w = works.get(id); return w?.tenantId === tenantId ? w : null; }
  };
  const service = new CreatorCollectionService(store, async (requested) => { calls.push(requested); return allowed; }, () => "now");
  return { service, store, collections, works, memberships, calls, writes: () => writes };
}

test('revisioned collection updates and removals require support and forward their preconditions', async () => {
  const f = fixture();
  await f.service.create(collection('one'));
  await assert.rejects(f.service.update(collection('one'), undefined, 0), { code: 'revision_conflict' });
  await assert.rejects(f.service.remove('tenant', 'one', 0), { code: 'revision_conflict' });
  f.store.supportsExpectedCollectionRevision = true;
  const calls = [];
  const update = f.store.updateCreatorCollection;
  f.store.updateCreatorCollection = async (record, status, revision) => { calls.push({ status, revision }); await update(record); };
  assert.equal((await f.service.update(collection('one'), undefined, 4)).revision, 5);
  await f.service.remove('tenant', 'one', 5);
  assert.deepEqual(calls, [{ status: undefined, revision: 4 }, { status: undefined, revision: 5 }]);
  for (const revision of [-1, 0.5, NaN, Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(f.service.update(collection('one'), undefined, revision), { code: 'revision_conflict' });
  }
});

test('collection covers require an atomic adapter and an active private asset in the creator scope', async () => {
  const f = fixture();
  const record = { ...collection('one'), coverAssetId: 'cover' };
  await assert.rejects(f.service.create(record), { code: 'invalid_cover' });
  assert.equal(f.writes(), 0);
  f.store.supportsCollectionCoverValidation = true;
  const asset = { ...scope, assetId: 'cover', status: 'ready', storage: { scope: 'private' } };
  for (const value of [null, { ...asset, assetId: 'wrong' }, { ...asset, tenantId: 'foreign' },
    { ...asset, creatorId: 'foreign' }, { ...asset, status: 'deleted' }, { ...asset, storage: { scope: 'public' } }]) {
    f.store.getProcessingAsset = async () => value;
    await assert.rejects(f.service.create(record), { code: 'invalid_cover' });
    assert.equal(f.writes(), 0);
  }
  f.store.getProcessingAsset = async () => asset;
  assert.equal((await f.service.create(record)).coverAssetId, 'cover');
  f.store.getProcessingAsset = async () => null;
  await assert.rejects(f.service.update({ ...record, slug: 'changed' }), { code: 'invalid_cover' });
  assert.equal(f.collections.get('one').slug, 'one');
  assert.equal((await f.service.update({ ...record, coverAssetId: '' })).coverAssetId, '');
  const denied = fixture(false);
  await assert.rejects(denied.service.create(record), { code: 'access_denied' });
});

test('conditional ordering fails closed when the adapter does not support it', async () => {
  const f = fixture();
  await f.service.create(collection('one'));
  const before = f.writes();
  await assert.rejects(f.service.replaceWorks('tenant', 'one', [], []), { code: 'invalid_works' });
  assert.equal(f.writes(), before);
});

test('conditional lifecycle updates require adapter support and forward the expected status', async () => {
  const f = fixture();
  await f.service.create(collection('one'));
  const before = f.writes();
  await assert.rejects(f.service.update({ ...collection('one'), status: 'archived' }, 'draft'), { code: 'revision_conflict' });
  assert.equal(f.writes(), before);
  f.store.supportsExpectedCollectionStatus = true;
  let expected;
  const update = f.store.updateCreatorCollection;
  f.store.updateCreatorCollection = async (record, status) => { expected = status; await update(record); };
  assert.equal((await f.service.update({ ...collection('one'), status: 'archived' }, 'draft')).status, 'archived');
  assert.equal(expected, 'draft');
});

test("collection lifecycle preserves product fields, slug history, ordered membership and soft deletion", async () => {
  const f = fixture();
  assert.deepEqual((await f.service.create(collection("one"))).workIds, []);
  f.works.set("a", work("a")); f.works.set("b", work("b"));
  const result = await f.service.replaceWorks("tenant", "one", [" b ", "a", "b", ""]);
  assert.deepEqual(result.workIds, ["b", "a"]);
  assert.deepEqual(f.memberships.get("one"), [
    { collectionId: "one", workId: "b", position: 0, addedAt: "now" },
    { collectionId: "one", workId: "a", position: 1, addedAt: "now" }
  ]);
  const renamed = await f.service.update({ ...result, slug: "renamed", slugHistory: [] });
  assert.deepEqual(renamed.slugHistory, ["one", "renamed"]);
  assert.deepEqual(renamed.productMetadata, { preserved: true });
  assert.deepEqual((await f.service.list(scope))[0].workIds, ["b", "a"]);
  await f.service.replaceWorks("tenant", "one", []);
  assert.deepEqual(f.memberships.get("one"), []);
  await f.service.remove("tenant", "one");
  assert.equal(f.collections.get("one").deletedAt, "now");
  assert.deepEqual(await f.service.list(scope), []);
  await assert.rejects(f.service.replaceWorks("tenant", "one", []), { code: "not_found" });
  assert.ok(f.calls.every((requested) => JSON.stringify(requested) === JSON.stringify(scope)));
});

test("all collection entry points require creator authorization before exposing data or writing", async () => {
  const f = fixture(false);
  f.collections.set("one", collection("one"));
  for (const operation of [
    () => f.service.get("tenant", "one"), () => f.service.list(scope),
    () => f.service.create(collection("two")), () => f.service.update(collection("one")),
    () => f.service.remove("tenant", "one"), () => f.service.replaceWorks("tenant", "one", [])
  ]) await assert.rejects(operation(), { code: "access_denied" });
  assert.equal(f.writes(), 0);
});

test("collection renames cannot reuse another collection's current or historical slug", async () => {
  const f = fixture();
  await f.service.create(collection("one"));
  await f.service.update({ ...collection("one"), slug: "renamed" });
  await f.service.create(collection("two"));
  for (const slug of ["one", "renamed"]) {
    await assert.rejects(f.service.create(collection("new", slug)), { code: "slug_conflict" });
    await assert.rejects(f.service.update({ ...collection("two"), slug }), { code: "slug_conflict" });
  }
  assert.equal(f.collections.get("two").slug, "two");
  await f.service.update({ ...f.collections.get("one"), slug: "one" });
});

test('collection creation validates imported historical aliases before any write', async () => {
  const f = fixture();
  await f.service.create(collection('owner', 'reserved'));
  const writes = f.writes();
  await assert.rejects(f.service.create({ ...collection('imported'), slugHistory: ['reserved'] }), { code: 'slug_conflict' });
  assert.equal(f.writes(), writes);
  assert.equal(f.collections.has('imported'), false);
});

test('collection restoration reacquires all authoritative aliases without discarding history', async () => {
  for (const claimed of ['original', 'renamed']) {
    for (const nextSlug of ['renamed', 'fresh']) {
      const f = fixture();
      await f.service.create(collection('one', 'original'));
      await f.service.update({ ...f.collections.get('one'), slug: 'renamed' });
      await f.service.remove('tenant', 'one');
      await f.service.create(collection('two', claimed));
      const before = structuredClone(f.collections.get('one')), writes = f.writes();
      await assert.rejects(f.service.update({ ...before, status: 'draft', slug: nextSlug, slugHistory: [], productMetadata: { replaced: true } }), { code: 'slug_conflict' });
      assert.deepEqual(f.collections.get('one'), before);
      assert.equal(f.writes(), writes);
      await f.service.remove('tenant', 'two');
      const restored = await f.service.update({ ...before, status: 'draft', slug: nextSlug, slugHistory: [] });
      assert.deepEqual(restored.slugHistory, [...new Set(['original', 'renamed', nextSlug])]);
      assert.deepEqual(restored.productMetadata, { preserved: true });
    }
  }
});

test("invalid, foreign and deleted Works never replace the existing membership", async () => {
  const f = fixture();
  f.collections.set("one", collection("one"));
  f.works.set("valid", work("valid"));
  f.works.set("foreign-creator", work("foreign-creator", { creatorId: "other" }));
  f.works.set("foreign-tenant", work("foreign-tenant", { tenantId: "other" }));
  f.works.set("deleted", work("deleted", { status: "deleted" }));
  await f.service.replaceWorks("tenant", "one", ["valid"]);
  for (const id of ["missing", "foreign-creator", "foreign-tenant", "deleted"]) {
    await assert.rejects(f.service.replaceWorks("tenant", "one", ["valid", id]), { code: "invalid_works" });
    assert.deepEqual(f.memberships.get("one").map((item) => item.workId), ["valid"]);
  }
  assert.equal(f.writes(), 1);
});

test("collection lookup is tenant-scoped and ownership cannot be reassigned", async () => {
  const f = fixture();
  f.collections.set("one", collection("one"));
  await assert.rejects(f.service.get("other", "one"), { code: "not_found" });
  await assert.rejects(f.service.update({ ...collection("one"), creatorId: "other" }), { code: "immutable_owner" });
  assert.equal(f.writes(), 0);
});
