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

test("native destination alias aggregation and resolution supports multi-destination aliases without ambiguity", async () => {
  const {
    isNativeDestination,
    aggregateNativePublications,
    resolveNativePublication,
    evaluateWorkNativePublicationEligibility,
  } = await import("../dist/index.js");

  const aliases = ["native", "custom-alias", "partner-channel"];

  assert.equal(isNativeDestination("native", aliases), true);
  assert.equal(isNativeDestination("custom-alias", aliases), true);
  assert.equal(isNativeDestination("partner-channel", aliases), true);
  assert.equal(isNativeDestination("unknown-store", aliases), false);

  const publications = [
    { id: "pub-1", creatorId: "creator-1", workId: "w-1", destination: "native", status: "live", visibility: "public" },
    { id: "pub-2", creatorId: "creator-1", workId: "w-1", destination: "custom-alias", status: "live", visibility: "public" },
    { id: "pub-3", creatorId: "creator-1", workId: "w-2", destination: "partner-channel", status: "live", visibility: "unlisted" },
    { id: "pub-4", creatorId: "creator-1", workId: "w-3", destination: "native", status: "removed", visibility: "public" },
    { id: "pub-5", creatorId: "creator-1", workId: "w-4", destination: "other-destination", status: "live", visibility: "public" },
  ];

  const aggregated = aggregateNativePublications(publications, aliases);
  assert.equal(aggregated.length, 3);
  assert.deepEqual(aggregated.map(p => p.id), ["pub-1", "pub-2", "pub-3"]);

  // resolveNativePublication prefers canonical 'native'
  const resolvedW1 = resolveNativePublication(publications.filter(p => p.workId === "w-1"), aliases);
  assert.equal(resolvedW1?.id, "pub-1");

  // resolveNativePublication falls back to valid alias if canonical 'native' is not present
  const resolvedW2 = resolveNativePublication(publications.filter(p => p.workId === "w-2"), aliases);
  assert.equal(resolvedW2?.id, "pub-3");

  // evaluateWorkNativePublicationEligibility allows multi-alias publications without ambiguity error
  const eligibilityW1 = await evaluateWorkNativePublicationEligibility({
    workId: "w-1",
    creatorId: "creator-1",
    publications: publications.filter(p => p.workId === "w-1"),
    destination: "custom-alias",
    options: { nativeDestinationAliases: aliases },
  });
  assert.equal(eligibilityW1.allowed, true);

  const eligibilityW3 = await evaluateWorkNativePublicationEligibility({
    workId: "w-3",
    creatorId: "creator-1",
    publications: publications.filter(p => p.workId === "w-3"),
    destination: "native",
    options: { nativeDestinationAliases: aliases },
  });
  assert.equal(eligibilityW3.allowed, false);
  assert.match(eligibilityW3.reason ?? "", /No released native Work Publication/);
});

