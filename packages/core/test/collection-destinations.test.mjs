import { test } from "node:test";
import assert from "node:assert/strict";
import {
  planCollectionDestination,
  validateCollectionMapping,
  assertCurrentCollectionPlan,
  authorizeCollectionPlan,
  assertIndependentCollectionMembership,
} from "../dist/index.js";
const now = "2026-10-28T12:00:00.000Z";
const mapping = (patch = {}) => ({
  id: "map",
  collectionId: "collection",
  accountId: "account",
  remoteGalleryId: "gallery",
  role: "preview",
  audience: "public",
  authority: "native",
  execution: "manual",
  scope: "selected",
  selections: [{ workId: "work" }],
  reconciliation: "exact",
  representation: "PUBLIC_PREVIEW",
  removalPolicy: "review",
  enabled: true,
  generation: 1,
  revision: 1,
  fieldRules: [],
  ...patch,
});
const caps = {
  revision: 1,
  listMembership: true,
  completeMembership: true,
  addMembership: true,
  removeMembership: true,
  membershipMayChangeAccess: false,
  freshnessMs: 300000,
};
const inputs = {
  membership: 1,
  metadata: 1,
  release: 1,
  access: 1,
  mapping: 1,
  generation: 1,
  capability: 1,
};
const observation = (patch = {}) => ({
  id: "obs",
  mappingId: "map",
  publicationIds: ["preview"],
  resolvedWorks: [{ publicationId: "preview", workId: "work" }],
  complete: true,
  observedAt: now,
  source: "api",
  evidence: [],
  ...patch,
});
const plan = (patch = {}) =>
  planCollectionDestination({
    id: "plan",
    mapping: mapping(),
    inputs,
    capabilities: caps,
    observation: observation(),
    members: [{ workId: "work", released: true, publicationId: "preview" }],
    now,
    ...patch,
  });
test("Publication variants differ even when the canonical Work and counts match", () => {
  const p = plan({
    observation: observation({
      publicationIds: ["premium"],
      resolvedWorks: [{ publicationId: "premium", workId: "work" }],
    }),
  });
  assert.deepEqual(p.additions, ["preview"]);
  assert.deepEqual(p.removals, ["premium"]);
  assert.equal(p.exact, false);
  assert.equal(p.comparison, "changes_pending");
});
test("selected preview scope compares its Publication set", () => {
  assert.equal(plan().exact, true);
  assert.equal(plan().verification, "api_verified");
});
test("partial and restricted observations never infer removals or exactness", () => {
  const p = plan({
    observation: observation({ complete: false, publicationIds: ["extra"] }),
  });
  assert.deepEqual(p.removals, []);
  assert.equal(p.exact, false);
  assert.equal(p.verification, "incomplete");
});
test("a stale or future observation cannot establish exactness", () => {
  for (const observedAt of ["2026-10-27T00:00:00Z", "2026-10-29T00:00:00Z"])
    assert.equal(
      plan({ observation: observation({ observedAt }) }).verification,
      "stale",
    );
});
test("missing Publications remain blockers", () => {
  const p = plan({ members: [{ workId: "work", released: true }] });
  assert.equal(p.blocked.length, 1);
  assert.equal(p.exact, false);
  assert.equal(p.comparison, "unresolved");
});
test("release and policy exclusions remain visible", () => {
  const p = plan({
    mapping: mapping({ scope: "released" }),
    members: [
      { workId: "a", released: false },
      { workId: "b", released: true, exclusion: "Rights unavailable" },
    ],
  });
  assert.equal(p.excluded.length, 2);
});
test("manual confirmation cannot become API verification", () => {
  const p = plan({ observation: observation({ source: "manual" }) });
  assert.equal(p.exact, false);
  assert.equal(p.verification, "manually_confirmed");
});
test("one active owner per account/gallery and one inbound mirror per collection", () => {
  assert.throws(
    () =>
      validateCollectionMapping(mapping({ id: "two" }), [mapping()], ["work"]),
    { code: "gallery_owned" },
  );
  assert.throws(
    () =>
      validateCollectionMapping(
        mapping({ id: "two", remoteGalleryId: "other", authority: "platform" }),
        [mapping({ authority: "platform" })],
        ["work"],
      ),
    { code: "inbound_authority" },
  );
});
test("several outbound mappings on one account are valid", () => {
  validateCollectionMapping(
    mapping({ id: "two", remoteGalleryId: "other" }),
    [mapping()],
    ["work"],
  );
});
test("mapping selections cannot reference foreign Works", () => {
  assert.throws(() => validateCollectionMapping(mapping(), [], ["other"]), {
    code: "invalid_mapping",
  });
});
test("independent edits require detach or duplicate for mirrors", () => {
  assert.throws(
    () =>
      assertIndependentCollectionMembership("collection", [
        mapping({ authority: "platform" }),
      ]),
    { code: "mirror_controlled" },
  );
});
test("each planning input revision fences application", () => {
  const p = plan();
  for (const key of Object.keys(inputs))
    assert.throws(
      () =>
        assertCurrentCollectionPlan(p, mapping(), { ...inputs, [key]: 2 }, now),
      { code: "stale_plan" },
    );
  assert.throws(
    () =>
      assertCurrentCollectionPlan(p, mapping({ enabled: false }), inputs, now),
    { code: "stale_plan" },
  );
});
test("automatic removals, initial application, and access effects require review", () => {
  const p = plan({ observation: observation({ publicationIds: ["extra"] }) });
  assert.throws(
    () =>
      authorizeCollectionPlan(
        p,
        mapping({ execution: "automatic", initialReviewAt: now }),
        false,
      ),
    { code: "review_required" },
  );
  assert.throws(
    () =>
      authorizeCollectionPlan(
        plan(),
        mapping({ execution: "automatic" }),
        false,
      ),
    { code: "review_required" },
  );
  assert.throws(
    () =>
      authorizeCollectionPlan(
        { ...plan(), effects: ["membership", "access"] },
        mapping({ execution: "automatic", initialReviewAt: now }),
        false,
      ),
    { code: "review_required" },
  );
});
test("unresolved inbound source identities block removals", () => {
  const p = plan({
    mapping: mapping({ authority: "platform" }),
    observation: observation({
      publicationIds: ["unknown"],
      resolvedWorks: [],
    }),
  });
  assert.deepEqual(p.inboundRemovals, []);
  assert.equal(p.blocked.length, 1);
});

test("executor records receipts, resumes without repeating writes, and verifies readback", async () => {
  const { executeCollectionDestinationPlan } = await import("../dist/index.js");
  const p = plan({ observation: observation({ publicationIds: [] }) });
  let saved,
    writes = 0,
    remote = [];
  const port = {
    exclusive: async (m, fn) => fn(),
    current: async () => ({
      mapping: mapping(),
      inputs,
      archived: false,
      connected: true,
      capabilities: caps,
    }),
    getExecution: async () => saved,
    saveExecution: async (run) => {
      saved = structuredClone(run);
    },
    validateEffects: async () => {},
    reconcileOperation: async (m, op) =>
      remote.includes(op.publicationId) ? "confirmed" : "not_applied",
    writeMembership: async (m, op) => {
      writes++;
      remote.push(op.publicationId);
      return { receipt: "remote-receipt" };
    },
    observe: async () =>
      observation({ id: "readback", publicationIds: remote }),
  };
  const run = await executeCollectionDestinationPlan({
    plan: p,
    mapping: mapping(),
    reviewed: true,
    port,
    now: () => now,
  });
  assert.equal(run.state, "verified");
  assert.equal(run.operations[0].state, "confirmed");
  assert.equal(writes, 1);
  await executeCollectionDestinationPlan({
    plan: p,
    mapping: mapping(),
    reviewed: true,
    port,
    now: () => now,
  });
  assert.equal(writes, 1);
});
test("an ambiguous remote success is reconciled before a retry and never blindly repeated", async () => {
  const { executeCollectionDestinationPlan } = await import("../dist/index.js");
  const p = plan({ observation: observation({ publicationIds: [] }) });
  let saved,
    writes = 0,
    remote = false;
  const port = {
    exclusive: async (m, fn) => fn(),
    current: async () => ({
      mapping: mapping(),
      inputs,
      archived: false,
      connected: true,
      capabilities: caps,
    }),
    getExecution: async () => saved,
    saveExecution: async (run) => {
      saved = structuredClone(run);
    },
    validateEffects: async () => {},
    reconcileOperation: async () => (remote ? "confirmed" : "not_applied"),
    writeMembership: async () => {
      writes++;
      remote = true;
      throw new Error("timeout after remote acceptance");
    },
    observe: async () => observation(),
  };
  const input = {
    plan: p,
    mapping: mapping(),
    reviewed: true,
    port,
    now: () => now,
  };
  assert.equal(
    (await executeCollectionDestinationPlan(input)).state,
    "partially_applied",
  );
  assert.equal(
    (await executeCollectionDestinationPlan(input)).state,
    "verified",
  );
  assert.equal(writes, 1);
});
test("executor fences a changed generation before further writes", async () => {
  const { executeCollectionDestinationPlan } = await import("../dist/index.js");
  const m = mapping({ scope: "released" }),
    p = plan({
      mapping: m,
      members: [
        { workId: "work", released: true, publicationId: "a" },
        { workId: "other", released: true, publicationId: "b" },
      ],
      observation: observation({ publicationIds: [] }),
    });
  let saved,
    writes = 0,
    generation = 1;
  const port = {
    exclusive: async (m, fn) => fn(),
    current: async () => ({
      mapping: mapping({ scope: "released", generation }),
      inputs: { ...inputs, generation },
      archived: false,
      connected: true,
      capabilities: caps,
    }),
    getExecution: async () => saved,
    saveExecution: async (run) => {
      saved = structuredClone(run);
    },
    validateEffects: async () => {},
    reconcileOperation: async () => "not_applied",
    writeMembership: async () => {
      writes++;
      generation++;
      return {};
    },
    observe: async () => observation(),
  };
  const run = await executeCollectionDestinationPlan({
    plan: p,
    mapping: m,
    reviewed: true,
    port,
    now: () => now,
  });
  assert.equal(run.state, "paused");
  assert.equal(writes, 1);
  assert.equal(run.operations[0].state, "confirmed");
});
