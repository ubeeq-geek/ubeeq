import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalAdapterSet } from "../dist/index.js";
import { verifyCellScopedRepositoryContract, verifyRevisionedRepositoryContract } from "@ubeeq/persistence";
import { verifyObjectStorageContract, verifyUploadContentAdapterContract } from "@ubeeq/storage";
import { verifyPasswordIdentityContract } from "@ubeeq/auth";
import { verifyCredentialVaultContract } from "@ubeeq/integrations";
import { advanceMigration, createMigrationCheckpoint, cutoverCellRoute, RoutingDirectoryConflictError } from "@ubeeq/deployment-platform";

test("every SQLite repository port satisfies the shared persistence contract", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ubeeq-local-contract-"));
  try {
    const { repositories } = createLocalAdapterSet({ databasePath: join(directory, "state.sqlite"), dataDirectory: directory, publicBaseUrl: "http://127.0.0.1", cellId: "cell-a" });
    const names = Object.keys(repositories).filter((name) => name !== "transaction");
    for (const name of names) {
      const repository = repositories[name];
      await verifyRevisionedRepositoryContract({ repository, createRecord: (id) => ({ id, instanceId: "local", homeCellId: "cell-a", dataHomeRegion: "test", dataHomeAssignedAt: "2026-01-01T00:00:00.000Z", routingRevision: 1, contractValue: name }), change: () => ({ contractValue: `updated-${name}` }) });
      if (name !== "federationActors" && name !== "remotePublicationReferences") await verifyCellScopedRepositoryContract({ repository, unscopedRepository: repository.repository, cellId: "cell-a" });
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("local password identity satisfies the shared development identity contract", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ubeeq-local-identity-contract-"));
  try { await verifyPasswordIdentityContract(createLocalAdapterSet({ databasePath: join(directory, "state.sqlite"), dataDirectory: directory, publicBaseUrl: "http://127.0.0.1", cellId: "cell-a" }).identity); }
  finally { rmSync(directory, { recursive: true, force: true }); }
});

test("local filesystem storage satisfies the shared object storage contract", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ubeeq-local-storage-contract-"));
  try { await verifyObjectStorageContract(createLocalAdapterSet({ databasePath: join(directory, "state.sqlite"), dataDirectory: directory, publicBaseUrl: "http://127.0.0.1", cellId: "cell-a" }).storage); }
  finally { rmSync(directory, { recursive: true, force: true }); }
});

test("local upload sessions satisfy the shared scoped upload contract", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ubeeq-local-upload-contract-"));
  try { await verifyUploadContentAdapterContract(createLocalAdapterSet({ databasePath: join(directory, "state.sqlite"), dataDirectory: directory, publicBaseUrl: "http://127.0.0.1", cellId: "cell-a" }).storage); }
  finally { rmSync(directory, { recursive: true, force: true }); }
});

test("local credential storage satisfies the shared cell-scoped vault contract", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ubeeq-local-vault-contract-"));
  try { await verifyCredentialVaultContract(createLocalAdapterSet({ databasePath: join(directory, "state.sqlite"), dataDirectory: directory, publicBaseUrl: "http://127.0.0.1", cellId: "cell-a" }).credentials); }
  finally { rmSync(directory, { recursive: true, force: true }); }
});

test("local delivery tokens are signed, expiring, and cell scoped", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ubeeq-local-delivery-contract-"));
  try {
    const { storage } = createLocalAdapterSet({ databasePath: join(directory, "state.sqlite"), dataDirectory: directory, publicBaseUrl: "http://127.0.0.1", cellId: "cell-a", deliverySigningKeys: { old: "old-key", current: "current-key" }, activeDeliveryKeyId: "current" });
    const delivery = await storage.issue({ object: { bucket: "cell-a", key: "cells/cell-a/creators/creator-a/renditions/rendition-a", versionId: "v1", scope: "public" }, expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const token = delivery.url.split("/").at(-1); assert.equal(storage.verifyDeliveryToken(token).creatorId, "creator-a");
    await assert.rejects(async () => storage.verifyDeliveryToken(`${token.slice(0, -1)}x`), /signature/);
    assert.throws(() => storage.verifyDeliveryToken("malformed"), /malformed/);
    await assert.rejects(() => storage.issue({ object: { bucket: "cell-a", key: "cells/cell-a/creators/creator-a/uploads/source", scope: "public" }, expiresAt: new Date(Date.now() + 60_000).toISOString() }), /rendition/);
    const foreignDirectory = mkdtempSync(join(tmpdir(), "ubeeq-local-delivery-foreign-")); const foreign = createLocalAdapterSet({ databasePath: join(foreignDirectory, "state.sqlite"), dataDirectory: foreignDirectory, publicBaseUrl: "http://127.0.0.1", cellId: "cell-b", deliverySigningKeys: { current: "current-key" }, activeDeliveryKeyId: "current" }).storage;
    assert.throws(() => foreign.verifyDeliveryToken(token), /another cell/); rmSync(foreignDirectory, { recursive: true, force: true });
    const expiring = await storage.issue({ object: { bucket: "cell-a", key: "cells/cell-a/creators/creator-a/renditions/expiring", scope: "public" }, expiresAt: new Date(Date.now() + 5).toISOString() }); await new Promise((resolve) => setTimeout(resolve, 10)); assert.throws(() => storage.verifyDeliveryToken(expiring.url.split("/").at(-1)), /expired/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("local routing metadata is durable, compare-and-swap guarded, and contains no cell data", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ubeeq-local-routing-"));
  try {
    const { routingDirectory, migrationCheckpoints } = createLocalAdapterSet({ databasePath: join(directory, "state.sqlite"), dataDirectory: directory, publicBaseUrl: "http://127.0.0.1", cellId: "cell-a" });
    const timestamp = "2026-08-27T00:00:00.000Z";
    const source = { creatorId: "creator-1", homeCellId: "cell-a", homeRegion: "us-east-2", endpoint: "https://cell-a.example/", routingRevision: 1, state: "active", updatedAt: timestamp };
    await routingDirectory.create(source);
    await assert.rejects(() => routingDirectory.create(source), RoutingDirectoryConflictError);
    let checkpoint = createMigrationCheckpoint({ id: "migration-1", creatorId: source.creatorId, source, destination: { cellId: "cell-b", region: "eu-central-1", endpoint: "https://cell-b.example/" }, now: timestamp });
    await migrationCheckpoints.create(checkpoint);
    checkpoint = advanceMigration(checkpoint, "source_hold", { now: "2026-08-27T00:01:00.000Z" });
    await migrationCheckpoints.compareAndSwap({ checkpoint, expectedUpdatedAt: timestamp });
    await assert.rejects(() => migrationCheckpoints.compareAndSwap({ checkpoint: { ...checkpoint, updatedAt: "2026-08-27T00:02:00.000Z" }, expectedUpdatedAt: timestamp }), RoutingDirectoryConflictError);
    checkpoint = advanceMigration(checkpoint, "exported", { now: "2026-08-27T00:02:00.000Z", manifestChecksum: "a".repeat(64) });
    checkpoint = advanceMigration(checkpoint, "transferred", { now: "2026-08-27T00:03:00.000Z" });
    checkpoint = advanceMigration(checkpoint, "verified", { now: "2026-08-27T00:04:00.000Z", objectCount: 2, verifiedObjectCount: 2 });
    const destination = cutoverCellRoute(source, checkpoint, "2026-08-27T00:05:00.000Z");
    await routingDirectory.compareAndSwap({ route: destination, expectedRoutingRevision: source.routingRevision });
    assert.equal((await routingDirectory.get(source.creatorId))?.homeCellId, "cell-b");
    await assert.rejects(() => routingDirectory.compareAndSwap({ route: { ...destination, routingRevision: 3, updatedAt: "2026-08-27T00:06:00.000Z" }, expectedRoutingRevision: 1 }), RoutingDirectoryConflictError);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
