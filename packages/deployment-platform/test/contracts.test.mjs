import assert from "node:assert/strict";
import test from "node:test";
import { advanceMigration, createMigrationCheckpoint, cutoverCellRoute, rollbackCellRoute, validateDeploymentArtifactManifest, validateRegionalDeploymentPlan } from "../dist/index.js";

test("validates neutral artifact provenance and regional rollout contracts", () => {
  assert.equal(validateDeploymentArtifactManifest({ schemaVersion: 1, product: "example", revision: "a".repeat(40), artifacts: { api: { path: "api", fileCount: 1, sha256: "b".repeat(64) } } }, { product: "example", revision: "a".repeat(40), artifacts: ["api"] }).product, "example");
  assert.equal(validateRegionalDeploymentPlan({ regions: ["us-east-2", "eu-central-1"], artifactRegistryStackName: "ArtifactRegistry" }).regions.length, 2);
});

test("uses auditable verification and compare-and-swap routing for a cell migration", () => {
  const now = "2026-08-27T00:00:00.000Z";
  const route = { creatorId: "creator-1", homeCellId: "cell-a", homeRegion: "us-east-2", endpoint: "https://a.example/", routingRevision: 4, state: "active", updatedAt: now };
  let migration = createMigrationCheckpoint({ id: "move-1", creatorId: route.creatorId, source: route, destination: { cellId: "cell-b", region: "eu-central-1", endpoint: "https://b.example/" }, now });
  migration = advanceMigration(migration, "source_hold", { now });
  migration = advanceMigration(migration, "exported", { now, manifestChecksum: "a".repeat(64) });
  migration = advanceMigration(migration, "transferred", { now });
  assert.throws(() => advanceMigration(migration, "verified", { now, objectCount: 2, verifiedObjectCount: 1 }), /verification/);
  migration = advanceMigration(migration, "verified", { now, objectCount: 2, verifiedObjectCount: 2 });
  const cutover = cutoverCellRoute(route, migration, now);
  assert.equal(cutover.homeCellId, "cell-b"); assert.equal(cutover.routingRevision, 5);
  migration = advanceMigration(migration, "cutover", { now, rollbackUntil: "2026-08-28T00:00:00.000Z" });
  const rollback = rollbackCellRoute(cutover, migration, "2026-08-27T01:00:00.000Z");
  assert.equal(rollback.homeCellId, "cell-a"); assert.equal(rollback.endpoint, "https://a.example/"); assert.equal(rollback.routingRevision, 6);
});
