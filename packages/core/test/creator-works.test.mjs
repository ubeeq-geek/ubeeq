import assert from "node:assert/strict";
import test from "node:test";
import { CreatorWorkService } from "../dist/index.js";

const scope = { tenantId: "tenant", creatorId: "creator" };
const record = (id, extra = {}) => ({ ...scope, workId: id, title: id, tags: [], slug: id,
  slugHistory: [id], status: "draft", revision: 1, createdAt: "created", updatedAt: "created", ...extra });
function fixture(allowed = true) {
  const records = new Map();
  let writes = 0;
  const store = {
    async getWork(tenantId, id) { const w = records.get(id); return w?.tenantId === tenantId ? w : null; },
    async listWorksByCreator(tenantId, creatorId) { return [...records.values()].filter((w) => w.tenantId === tenantId && w.creatorId === creatorId && w.status !== "deleted"); },
    async createWork(w) { writes++; records.set(w.workId, w); },
    async updateWork(w) { writes++; records.set(w.workId, w); },
    async commitWorkRevision(w, expected) {
      if (records.get(w.workId)?.revision !== expected) throw Object.assign(new Error("stale"), { code: "revision_conflict" });
      writes++; records.set(w.workId, w);
    }
  };
  const service = new CreatorWorkService(store, async () => allowed, () => "now");
  return { service, records, writes: () => writes };
}

test("Work creation and revision preserve product metadata with authoritative lifecycle bookkeeping", async () => {
  const f = fixture();
  const created = await f.service.create(record("one", { status: "ready", revision: 90, productMetadata: { disclosure: "custom" } }));
  assert.equal(created.status, "draft");
  assert.equal(created.revision, 1);
  const updated = await f.service.revise("tenant", "one", (w, now) => ({ ...w, slug: "renamed", slugHistory: [], revision: 999, createdAt: "changed", status: "archived", policyUpdatedAt: now }));
  assert.equal(updated.revision, 2);
  assert.equal(updated.createdAt, "created");
  assert.equal(updated.updatedAt, "now");
  assert.equal(updated.archivedAt, "now");
  assert.equal(updated.policyUpdatedAt, "now");
  assert.deepEqual(updated.slugHistory, ["one", "renamed"]);
  assert.deepEqual(updated.productMetadata, { disclosure: "custom" });
  const restored = await f.service.revise("tenant", "one", (w) => ({ ...w, status: "ready" }));
  assert.equal(restored.archivedAt, undefined);
  const deleted = await f.service.revise("tenant", "one", (w) => ({ ...w, status: "deleted" }));
  assert.equal(deleted.deletedAt, "now");
  assert.deepEqual(await f.service.list(scope), []);
});

test("Work search covers title, description and tags within the authorized creator", async () => {
  const f = fixture();
  f.records.set("one", record("one", { title: "Blue Sky" }));
  f.records.set("two", record("two", { description: "Blue sea" }));
  f.records.set("three", record("three", { tags: ["BLUE"] }));
  f.records.set("foreign", record("foreign", { creatorId: "other", title: "blue" }));
  assert.deepEqual((await f.service.list(scope, " BLUE ")).map((w) => w.workId), ["one", "two", "three"]);
  assert.deepEqual(await f.service.list(scope, "missing"), []);
});

test("denied Work reads and writes do not execute edits or mutate storage", async () => {
  const f = fixture(false);
  f.records.set("one", record("one"));
  let edited = false;
  for (const operation of [() => f.service.get("tenant", "one"), () => f.service.list(scope),
    () => f.service.create(record("two")), () => f.service.revise("tenant", "one", (w) => { edited = true; return w; })]) {
    await assert.rejects(operation(), { code: "access_denied" });
  }
  assert.equal(edited, false);
  assert.equal(f.writes(), 0);
});

test("slug conflicts preserve stored data even if the rejected callback mutates its input", async () => {
  const f = fixture();
  await f.service.create(record("one"));
  await f.service.revise("tenant", "one", (w) => ({ ...w, slug: "renamed" }));
  await f.service.create(record("two", { tags: ["unchanged"] }));
  for (const slug of ["one", "renamed"]) {
    await assert.rejects(f.service.create(record("new", { slug })), { code: "slug_conflict" });
    await assert.rejects(f.service.revise("tenant", "two", (w) => { w.tags.push("changed"); return { ...w, slug }; }), { code: "slug_conflict" });
  }
  assert.deepEqual(f.records.get("two").tags, ["unchanged"]);
  assert.equal(f.records.get("two").revision, 1);
});

test("Work revisions cannot change identity or ownership and lookups are tenant scoped", async () => {
  const f = fixture();
  f.records.set("one", record("one"));
  await assert.rejects(f.service.get("other", "one"), { code: "not_found" });
  for (const key of ["tenantId", "creatorId", "workId"]) {
    await assert.rejects(f.service.revise("tenant", "one", (w) => ({ ...w, [key]: "other" })), { code: "immutable_identity" });
  }
  assert.equal(f.writes(), 0);
});

test("concurrent shared edits do not silently overwrite one another", async () => {
  const f = fixture();
  f.records.set("one", record("one"));
  const results = await Promise.allSettled([
    f.service.revise("tenant", "one", (w) => ({ ...w, title: "first" })),
    f.service.revise("tenant", "one", (w) => ({ ...w, title: "second" }))
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.find((result) => result.status === "rejected").reason.code, "revision_conflict");
  assert.equal(f.records.get("one").revision, 2);
  assert.equal(f.writes(), 1);
});

test('restoring a deleted Work preflights every retained alias before changing any state', async () => {
  for (const claimed of ['original', 'renamed']) {
    for (const restoredSlug of ['renamed', 'fresh']) {
      const f = fixture();
      await f.service.create(record('one', { slug: 'original', tags: ['retained'] }));
      await f.service.revise('tenant', 'one', w => ({ ...w, slug: 'renamed' }));
      const deleted = await f.service.revise('tenant', 'one', w => ({ ...w, status: 'deleted' }));
      await f.service.create(record('two', { slug: claimed }));
      const before = structuredClone(deleted), writes = f.writes();
      await assert.rejects(f.service.revise('tenant', 'one', w => {
        w.tags.push('must not save');
        return { ...w, status: 'draft', slug: restoredSlug, slugHistory: [] };
      }), { code: 'slug_conflict' });
      assert.deepEqual(f.records.get('one'), before);
      assert.equal(f.writes(), writes);
      await f.service.revise('tenant', 'two', w => ({ ...w, status: 'deleted' }));
      const restored = await f.service.revise('tenant', 'one', w => ({ ...w, status: 'draft', slug: restoredSlug }));
      assert.equal(restored.deletedAt, undefined);
      assert.equal(restored.revision, deleted.revision + 1);
      assert.deepEqual(restored.slugHistory, [...new Set(['original', 'renamed', restoredSlug])]);
    }
  }
});
