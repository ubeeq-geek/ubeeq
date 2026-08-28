import assert from "node:assert/strict";
import test from "node:test";
import { advanceMigration, createMigrationCheckpoint, cutoverCellRoute, rollbackCellRoute, validateDeploymentArtifactManifest, validateRegionalDeploymentPlan, MigrationOrchestrator, RemoteMigrationExecutor } from "../dist/index.js";

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

test("orchestrator resumes a held migration, cuts over once, and preserves rollback/retirement controls", async () => {
  let tick = 0; const now = () => new Date(Date.parse("2026-08-27T00:00:00.000Z") + ++tick * 1_000).toISOString();
  let route = { creatorId: "creator-1", homeCellId: "cell-a", homeRegion: "us-east-2", endpoint: "https://a.example/", routingRevision: 1, state: "active", updatedAt: now() };
  const checkpoints = new Map(); const calls = [];
  const routes = { get: async () => route, create: async (value) => route = value, compareAndSwap: async ({ route: next, expectedRoutingRevision }) => { assert.equal(route.routingRevision, expectedRoutingRevision); route = next; return route; }, list: async () => ({ items: [route] }) };
  const store = { get: async (id) => checkpoints.get(id), create: async (value) => { checkpoints.set(value.id, value); return value; }, compareAndSwap: async ({ checkpoint, expectedUpdatedAt }) => { assert.equal(checkpoints.get(checkpoint.id).updatedAt, expectedUpdatedAt); checkpoints.set(checkpoint.id, checkpoint); return checkpoint; }, list: async () => ({ items: [...checkpoints.values()] }) };
  const executor = { placeSourceHold: async () => calls.push("hold"), exportSource: async () => (calls.push("export"), { manifestChecksum: "a".repeat(64), objectCount: 2 }), transferObjects: async () => calls.push("transfer"), importDestination: async () => calls.push("import"), verifyDestination: async () => (calls.push("verify"), { objectCount: 2, verifiedObjectCount: 2 }), enableDestination: async () => calls.push("enable"), rollbackDestination: async () => calls.push("rollback"), retireSource: async () => calls.push("retire") };
  const orchestration = new MigrationOrchestrator(routes, store, executor, now);
  const requested = await orchestration.request({ id: "move-1", creatorId: "creator-1", destination: { cellId: "cell-b", region: "eu-central-1", endpoint: "https://b.example/" } });
  const completed = await orchestration.resume(requested.id, 60);
  assert.equal(completed.state, "cutover"); assert.equal(route.homeCellId, "cell-b"); assert.deepEqual(calls, ["hold", "export", "transfer", "import", "verify", "enable"]);
  const rolledBack = await orchestration.rollback(completed.id); assert.equal(rolledBack.state, "rolled_back"); assert.equal(route.homeCellId, "cell-a");
});

test("orchestrator resumes after an atomic route cutover before checkpoint persistence", async () => {
  let tick = 0; const now = () => new Date(Date.parse("2026-08-27T00:00:00.000Z") + ++tick * 1_000).toISOString();
  const source = { creatorId: "creator-1", homeCellId: "cell-a", homeRegion: "us-east-2", endpoint: "https://a.example/", routingRevision: 1, state: "active", updatedAt: now() };
  let checkpoint = createMigrationCheckpoint({ id: "move-resume", creatorId: source.creatorId, source, destination: { cellId: "cell-b", region: "eu-central-1", endpoint: "https://b.example/" }, now: now() });
  checkpoint = advanceMigration(checkpoint, "source_hold", { now: now() });
  checkpoint = advanceMigration(checkpoint, "exported", { now: now(), manifestChecksum: "a".repeat(64) });
  checkpoint = advanceMigration(checkpoint, "transferred", { now: now() });
  checkpoint = advanceMigration(checkpoint, "verified", { now: now(), objectCount: 0, verifiedObjectCount: 0 });
  let route = cutoverCellRoute(source, checkpoint, now()); // checkpoint write intentionally has not happened yet
  const routes = { get: async () => route, create: async () => route, compareAndSwap: async () => { throw new Error("cutover must not repeat"); }, list: async () => ({ items: [route] }) };
  const store = { get: async () => checkpoint, create: async () => checkpoint, compareAndSwap: async ({ checkpoint: next }) => (checkpoint = next), list: async () => ({ items: [checkpoint] }) };
  const executor = { placeSourceHold: async () => {}, exportSource: async () => ({ manifestChecksum: "a".repeat(64), objectCount: 0 }), transferObjects: async () => {}, importDestination: async () => {}, verifyDestination: async () => ({ objectCount: 0, verifiedObjectCount: 0 }), enableDestination: async () => {}, rollbackDestination: async () => {}, retireSource: async () => {} };
  const resumed = await new MigrationOrchestrator(routes, store, executor, now).resume("move-resume");
  assert.equal(resumed.state, "cutover"); assert.equal(route.routingRevision, 2);
});

test("remote migration executor calls only private cell commands and verifies the declared inventory", async () => {
  const now = "2026-08-28T00:00:00.000Z";
  const checkpoint = { ...createMigrationCheckpoint({ id: "remote-move", creatorId: "creator-1", source: { creatorId: "creator-1", homeCellId: "cell-a", homeRegion: "us-east-2", endpoint: "https://a.example/", routingRevision: 1, state: "active", updatedAt: now }, destination: { cellId: "cell-b", region: "eu-central-1", endpoint: "https://b.example/" }, now }), state: "source_hold" };
  const inventory = [{ id: "asset-1", source: { bucket: "source", key: "cells/cell-a/creators/creator-1/originals/a" }, destination: { bucket: "destination", key: "cells/cell-b/creators/creator-1/originals/a" }, checksum: "a".repeat(64), byteLength: 1 }];
  const calls = [];
  const source = { execute: async (command) => { calls.push(`source:${command.operation}`); return command.operation === "export" ? { manifestChecksum: "b".repeat(64), objectInventory: inventory } : {}; } };
  const destination = { execute: async (command) => { calls.push(`destination:${command.operation}`); return {}; } };
  const transfer = { transfer: async (_checkpoint, objects) => { calls.push(`transfer:${objects.length}`); }, verify: async (_checkpoint, objects) => { calls.push(`verify:${objects.length}`); return { objectCount: objects.length, verifiedObjectCount: objects.length }; } };
  const executor = new RemoteMigrationExecutor(source, destination, transfer, "destination");
  await executor.placeSourceHold(checkpoint);
  const exported = await executor.exportSource(checkpoint);
  const exportedCheckpoint = { ...checkpoint, state: "exported", manifestChecksum: exported.manifestChecksum, objectCount: exported.objectCount, objectInventory: exported.objectInventory };
  await executor.transferObjects(exportedCheckpoint);
  await executor.importDestination(exportedCheckpoint);
  assert.deepEqual(await executor.verifyDestination(exportedCheckpoint), { objectCount: 1, verifiedObjectCount: 1 });
  await executor.enableDestination(exportedCheckpoint); await executor.rollbackDestination(exportedCheckpoint); await executor.retireSource(exportedCheckpoint);
  assert.deepEqual(calls, ["source:source_hold", "source:export", "transfer:1", "destination:import", "verify:1", "destination:enable", "destination:rollback", "source:retire"]);
});
