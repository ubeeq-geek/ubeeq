import test from "node:test";
import assert from "node:assert/strict";
import {
  planNativeCollectionPublication,
  nativeCollectionIsReleased,
} from "../dist/index.js";
const now = "2026-10-29T12:00:00Z",
  p = {
    collectionId: "collection",
    destination: "native",
    revision: 1,
    release: "published",
    audience: "public",
    scope: "released",
    selectedWorkIds: [],
    releasedWorkIds: ["one", "two"],
    includedWorkIds: [],
    excluded: [],
    updatedAt: now,
  };
test("native publication preserves order and reports unreleased and policy exclusions", () => {
  const result = planNativeCollectionPublication({
    publication: p,
    memberIds: ["one", "two", "incoming"],
    eligibility: [
      { workId: "one", allowed: true },
      { workId: "two", allowed: false, reason: "Unavailable on this channel." },
    ],
    now,
  });
  assert.deepEqual(result.includedWorkIds, ["one"]);
  assert.deepEqual(result.excluded, [
    { workId: "two", reason: "Unavailable on this channel." },
    { workId: "incoming", reason: "Not released for this destination." },
  ]);
});
test("selected subset does not claim the full collection", () => {
  const result = planNativeCollectionPublication({
    publication: { ...p, scope: "selected", selectedWorkIds: ["two"] },
    memberIds: ["one", "two"],
    eligibility: [{ workId: "two", allowed: true }],
    now,
  });
  assert.deepEqual(result.includedWorkIds, ["two"]);
  assert.equal(result.scope, "selected");
});
test("foreign or duplicate selection fails and no eligibility result means exclusion", () => {
  assert.throws(() =>
    planNativeCollectionPublication({
      publication: { ...p, releasedWorkIds: ["foreign"] },
      memberIds: ["one"],
      eligibility: [],
      now,
    }),
  );
  const result = planNativeCollectionPublication({
    publication: { ...p, releasedWorkIds: ["one"] },
    memberIds: ["one"],
    eligibility: [],
    now,
  });
  assert.equal(result.includedWorkIds.length, 0);
  assert.equal(result.excluded.length, 1);
});
test("schedule is effective only when due and unpublished is distinct from management state", () => {
  const scheduled = {
    ...p,
    release: "scheduled",
    scheduledAt: "2026-10-30T12:00:00Z",
  };
  assert.equal(nativeCollectionIsReleased(scheduled, now), false);
  assert.equal(
    nativeCollectionIsReleased(scheduled, "2026-10-31T12:00:00Z"),
    true,
  );
  assert.equal(
    nativeCollectionIsReleased({ ...p, release: "unpublished" }, now),
    false,
  );
});
