import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReferenceApi } from "../dist/server.js";
import { createMigrationCellEndpoint } from "../dist/migration-cell.js";
import { createLocalAdapterSet } from "@ubeeq/adapter-local";
import { signFederationEnvelope } from "@ubeeq/federation";
import { MigrationOrchestrator, RemoteMigrationExecutor } from "@ubeeq/deployment-platform";

const request = async (base, path, options = {}) => {
  const response = await fetch(`${base}${path}`, { ...options, headers: { "content-type": "application/json", ...(options.headers || {}) } });
  const body = response.status === 204 ? undefined : await response.json();
  return { response, body };
};

test("runs the portable signed-in upload, publish, delivery, and export workflow", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ubeeq-reference-e2e-"));
  const api = createReferenceApi({ databasePath: join(directory, "state.sqlite"), dataDirectory: directory, publicBaseUrl: "http://127.0.0.1:0", cellId: "cell-a" });
  await new Promise((resolve) => api.server.listen(0, "127.0.0.1", resolve));
  const address = api.server.address(); const base = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await request(base, "/health")).response.status, 200);
    const discovery = await request(base, "/.well-known/ubeeq");
    assert.equal(discovery.response.status, 200); assert.equal(discovery.body.protocolVersion, "1"); assert.equal(discovery.body.federationEnabled, false);
    assert.equal((await request(base, "/v1/auth/sign-up", { method: "POST", body: JSON.stringify({ email: "creator@example.test", password: "a-safe-local-password" }) })).response.status, 201);
    const signIn = await request(base, "/v1/auth/sign-in", { method: "POST", body: JSON.stringify({ email: "creator@example.test", password: "a-safe-local-password" }) });
    const headers = { authorization: `Bearer ${signIn.body.token}` };
    assert.equal((await request(base, "/v1/operations/holds")).response.status, 401);
    assert.equal((await request(base, "/v1/operations/review-cases", { method: "POST", body: JSON.stringify({ subjectId: "unknown" }) })).response.status, 401);
    const creator = await request(base, "/v1/creators", { method: "POST", headers, body: JSON.stringify({ handle: "creator", displayName: "Creator" }) });
    assert.equal(creator.response.status, 201);
    const collection = await request(base, "/v1/collections", { method: "POST", headers, body: JSON.stringify({ title: "A local collection", visibility: "public" }) });
    assert.equal(collection.response.status, 201);
    const work = await request(base, "/v1/works", { method: "POST", headers, body: JSON.stringify({ title: "A local work" }) });
    const bytes = Buffer.from("portable image bytes"); const checksum = createHash("sha256").update(bytes).digest("hex");
    const upload = await request(base, "/v1/uploads", { method: "POST", headers, body: JSON.stringify({ workId: work.body.work.id, mimeType: "image/png", byteLength: bytes.length, checksum }) });
    await request(base, `/v1/uploads/${upload.body.upload.uploadId}/content`, { method: "PUT", headers, body: JSON.stringify({ base64: bytes.toString("base64") }) });
    const asset = await request(base, `/v1/uploads/${upload.body.upload.uploadId}/complete`, { method: "POST", headers, body: JSON.stringify({ workId: work.body.work.id, checksum, byteLength: bytes.length }) });
    assert.equal(asset.response.status, 202);
    const incomplete = await request(base, `/v1/works/${work.body.work.id}/publications`, { method: "POST", headers, body: JSON.stringify({ destination: "local" }) });
    assert.equal(incomplete.response.status, 409);
    assert.equal(incomplete.body.error.code, "processing_incomplete");
    const processed = await request(base, "/v1/operations/jobs/run-next", { method: "POST", headers, body: JSON.stringify({ workerId: "e2e-worker" }) });
    assert.equal(processed.response.status, 200);
    assert.equal(processed.body.result.job.state, "completed");
    assert.equal(processed.body.result.asset.status, "ready");
    const hold = await request(base, "/v1/operations/holds", { method: "POST", headers, body: JSON.stringify({ subjectType: "work", subjectId: work.body.work.id, reason: "manual_review" }) });
    assert.equal(hold.response.status, 201);
    const secondHold = await request(base, "/v1/operations/holds", { method: "POST", headers, body: JSON.stringify({ subjectType: "creator", subjectId: creator.body.creator.id, reason: "pagination" }) }); assert.equal(secondHold.response.status, 201);
    const holdsPage = await request(base, "/v1/operations/holds?limit=1", { headers }); assert.equal(holdsPage.body.holds.length, 1); assert.ok(holdsPage.body.nextCursor); assert.equal(holdsPage.body.cell.cellId, "cell-a");
    const blocked = await request(base, `/v1/works/${work.body.work.id}/publications`, { method: "POST", headers, body: JSON.stringify({ destination: "local" }) });
    assert.equal(blocked.response.status, 409);
    assert.equal(blocked.body.error.code, "admission_blocked");
    assert.deepEqual(new Set(blocked.body.error.details.blockedSubjectIds), new Set([work.body.work.id, creator.body.creator.id]));
    const release = await request(base, `/v1/operations/holds/${hold.body.hold.id}/release`, { method: "POST", headers, body: "{}" });
    assert.equal(release.response.status, 200);
    await request(base, `/v1/operations/holds/${secondHold.body.hold.id}/release`, { method: "POST", headers, body: "{}" });
    const review = await request(base, "/v1/operations/review-cases", { method: "POST", headers, body: JSON.stringify({ subjectId: work.body.work.id }) }); const decided = await request(base, `/v1/operations/review-cases/${review.body.reviewCase.id}`, { method: "POST", headers, body: JSON.stringify({ state: "decided", assigneeId: "operator" }) }); assert.equal(decided.body.reviewCase.state, "decided");
    const publication = await request(base, `/v1/works/${work.body.work.id}/publications`, { method: "POST", headers: { ...headers, "idempotency-key": "publish-local-work" }, body: JSON.stringify({ destination: "local" }) });
    assert.equal(publication.response.status, 201);
    const publicWork = await request(base, `/v1/public/works/${work.body.work.id}`);
    assert.equal(publicWork.response.status, 200); assert.equal(publicWork.body.work.status, "published");
    assert.match(publicWork.body.assets[0].storage.key, /\/renditions\//);
    const delivery = await fetch(publicWork.body.assets[0].delivery.url.replace("http://127.0.0.1:0", base));
    assert.deepEqual(Buffer.from(await delivery.arrayBuffer()), bytes); assert.match(delivery.headers.get("cache-control"), /public/);
    const exported = await request(base, "/v1/exports/me", { headers });
    assert.equal(exported.response.status, 200); assert.equal(exported.body.schemaVersion, "2"); assert.equal(exported.body.secretsExcluded, true); assert.equal(exported.body.works.length, 1); assert.equal(exported.body.processing.length, 1); assert.equal(exported.body.objectInventory.length, 1);
    const importDirectory = mkdtempSync(join(tmpdir(), "ubeeq-reference-import-"));
    const importApi = createReferenceApi({ databasePath: join(importDirectory, "state.sqlite"), dataDirectory: importDirectory, publicBaseUrl: "http://127.0.0.1:0", cellId: "cell-a" });
    await new Promise((resolve) => importApi.server.listen(0, "127.0.0.1", resolve));
    const importBase = `http://127.0.0.1:${importApi.server.address().port}`;
    try {
      await request(importBase, "/v1/auth/sign-up", { method: "POST", body: JSON.stringify({ email: "importer@example.test", password: "another-safe-local-password" }) });
      const importSignIn = await request(importBase, "/v1/auth/sign-in", { method: "POST", body: JSON.stringify({ email: "importer@example.test", password: "another-safe-local-password" }) });
      const importHeaders = { authorization: `Bearer ${importSignIn.body.token}` };
      await request(importBase, "/v1/creators", { method: "POST", headers: importHeaders, body: JSON.stringify({ handle: "importer", displayName: "Importer" }) });
      const validation = await request(importBase, "/v1/imports/validate", { method: "POST", headers: importHeaders, body: JSON.stringify({ manifest: exported.body }) });
      assert.equal(validation.response.status, 200); assert.equal(validation.body.plan.valid, true);
      const imported = await request(importBase, "/v1/imports", { method: "POST", headers: importHeaders, body: JSON.stringify({ manifest: exported.body, dryRun: false, importId: "portable-round-trip" }) });
      assert.equal(imported.response.status, 201); assert.equal(imported.body.checkpoint.state, "completed"); assert.equal(imported.body.originalFilesTransferred, false);
      const repeatImport = await request(importBase, "/v1/imports", { method: "POST", headers: importHeaders, body: JSON.stringify({ manifest: exported.body, dryRun: false, importId: "portable-round-trip" }) });
      assert.equal(repeatImport.response.status, 200); assert.equal(repeatImport.body.idempotent, true);
      const importedExport = await request(importBase, "/v1/exports/me", { headers: importHeaders });
      assert.equal(importedExport.body.works.length, 1); assert.equal(importedExport.body.assets.length, 1);
    } finally { await importApi.close(); rmSync(importDirectory, { recursive: true, force: true }); }
    const jobs = await request(base, "/v1/operations/jobs", { headers });
    assert.equal(jobs.response.status, 200); assert.equal(jobs.body.jobs[0].state, "completed");
    assert.equal((await request(base, "/ready")).response.status, 200);
  } finally { await api.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("accepts policy-approved signed federation reference updates and withdrawals", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ubeeq-federation-e2e-"));
  const remoteDirectory = mkdtempSync(join(tmpdir(), "ubeeq-federation-remote-"));
  const remoteAdapters = createLocalAdapterSet({ databasePath: join(remoteDirectory, "state.sqlite"), dataDirectory: remoteDirectory, publicBaseUrl: "https://remote.example", cellId: "remote-cell" });
  const configuration = { databasePath: join(directory, "state.sqlite"), dataDirectory: directory, publicBaseUrl: "https://reference.example", cellId: "cell-a", credentialEncryptionKey: "federation-test-key", federationVerifier: remoteAdapters.federation, federationPolicy: { id: "allow-test", apiVersion: "1", evaluateRemote: async () => "allow" } };
  const api = createReferenceApi(configuration);
  await new Promise((resolve) => api.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${api.server.address().port}`;
  const event = async (type, canonicalUrl, id) => signFederationEnvelope({ id, issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), payload: { type, actor: { id: "https://remote.example/actors/creator", host: "remote.example", handle: "creator", profileUrl: "https://remote.example/creator", inboxUrl: "https://remote.example/inbox" }, publication: { id: "remote-work-1", actorId: "https://remote.example/actors/creator", canonicalUrl, publishedAt: "2026-01-01T00:00:00.000Z", visibility: "public" } } }, remoteAdapters.federation);
  try {
    const accepted = await request(base, "/v1/federation/inbox", { method: "POST", body: JSON.stringify({ envelope: await event("publication_reference", "https://remote.example/works/one", "ref") }) });
    assert.equal(accepted.response.status, 201); assert.equal(accepted.body.reference.state, "accepted");
    const updated = await request(base, "/v1/federation/inbox", { method: "POST", body: JSON.stringify({ envelope: await event("publication_updated", "https://remote.example/works/one-revised", "update") }) });
    assert.equal(updated.response.status, 200); assert.equal(updated.body.reference.publicationUri, "https://remote.example/works/one-revised");
    const withdrawn = await request(base, "/v1/federation/inbox", { method: "POST", body: JSON.stringify({ envelope: await event("publication_withdrawn", "https://remote.example/works/one-revised", "withdraw") }) });
    assert.equal(withdrawn.response.status, 200); assert.equal(withdrawn.body.reference.state, "withdrawn");
  } finally { await api.close(); rmSync(directory, { recursive: true, force: true }); rmSync(remoteDirectory, { recursive: true, force: true }); }
});

test("uses an explicit control plane for creator migration requests, operator cutover, and edge redirects", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ubeeq-regional-api-"));
  const adapters = createLocalAdapterSet({ databasePath: join(directory, "state.sqlite"), dataDirectory: directory, publicBaseUrl: "http://127.0.0.1:0", cellId: "cell-a" });
  const executor = { placeSourceHold: async () => {}, exportSource: async () => ({ manifestChecksum: "a".repeat(64), objectCount: 0 }), transferObjects: async () => {}, importDestination: async () => {}, verifyDestination: async () => ({ objectCount: 0, verifiedObjectCount: 0 }), enableDestination: async () => {}, rollbackDestination: async () => {}, retireSource: async () => {} };
  const orchestrator = new MigrationOrchestrator(adapters.routingDirectory, adapters.migrationCheckpoints, executor);
  const api = createReferenceApi({ publicBaseUrl: "http://127.0.0.1:0", cellId: "cell-a", adapters: { repositories: adapters.repositories, storage: adapters.storage, uploads: adapters.storage, delivery: adapters.storage, jobs: adapters.jobs, identity: adapters.identity, localIdentity: adapters.identity, federation: adapters.federation }, regionalControlPlane: { routingDirectory: adapters.routingDirectory, migrationCheckpoints: adapters.migrationCheckpoints, orchestrator }, operatorAuthorization: { anyRoles: ["creator"] } });
  await new Promise((resolve) => api.server.listen(0, "127.0.0.1", resolve)); const base = `http://127.0.0.1:${api.server.address().port}`;
  try {
    await request(base, "/v1/auth/sign-up", { method: "POST", body: JSON.stringify({ email: "regional@example.test", password: "a-safe-local-password" }) });
    const signIn = await request(base, "/v1/auth/sign-in", { method: "POST", body: JSON.stringify({ email: "regional@example.test", password: "a-safe-local-password" }) }); const headers = { authorization: `Bearer ${signIn.body.token}` };
    const created = await request(base, "/v1/creators", { method: "POST", headers, body: JSON.stringify({ handle: "regional", displayName: "Regional" }) });
    const creator = created.body.creator;
    const migrationHold = await adapters.repositories.moderationHolds.create({ id: "migration-source-hold", instanceId: "local-reference", homeCellId: "cell-a", dataHomeRegion: "local", dataHomeAssignedAt: creator.dataHomeAssignedAt, routingRevision: 1, subjectType: "creator", subjectId: creator.id, state: "active", reason: "migration:in-progress" });
    const blockedWrite = await request(base, "/v1/works", { method: "POST", headers, body: JSON.stringify({ title: "must not write" }) });
    assert.equal(blockedWrite.response.status, 409); assert.equal(blockedWrite.body.error.code, "migration_source_held");
    await adapters.repositories.moderationHolds.update(migrationHold.id, migrationHold.revision, { state: "released" });
    await adapters.routingDirectory.create({ creatorId: creator.id, homeCellId: "cell-a", homeRegion: "local", endpoint: "https://cell-a.example/", routingRevision: 1, state: "active", updatedAt: new Date().toISOString() });
    const requestMigration = await request(base, "/v1/migrations", { method: "POST", headers, body: JSON.stringify({ destinationCellId: "cell-b", destinationRegion: "other", destinationEndpoint: "https://cell-b.example/" }) });
    assert.equal(requestMigration.response.status, 202);
    const pending = await request(base, "/v1/migrations/me", { headers }); assert.equal(pending.body.migrations.length, 1);
    const resumed = await request(base, `/v1/operations/regional/migrations/${requestMigration.body.migration.id}/resume`, { method: "POST", headers, body: "{}" }); assert.equal(resumed.response.status, 200); assert.equal(resumed.body.migration.state, "cutover");
    const route = await request(base, `/v1/routing/creators/${creator.id}`); assert.equal(route.body.route.homeCellId, "cell-b");
    const redirect = await fetch(`${base}/v1/routing/creators/${creator.id}?path=/v1/works`, { redirect: "manual" }); assert.equal(redirect.status, 307); assert.equal(redirect.headers.get("location"), "https://cell-b.example/v1/works");
  } finally { await api.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("moves original objects only through an explicit migration executor, never on the normal cell path", async () => {
  const sourceDirectory = mkdtempSync(join(tmpdir(), "ubeeq-cell-source-")); const destinationDirectory = mkdtempSync(join(tmpdir(), "ubeeq-cell-destination-"));
  const source = createLocalAdapterSet({ databasePath: join(sourceDirectory, "state.sqlite"), dataDirectory: sourceDirectory, publicBaseUrl: "https://cell-a.example", cellId: "cell-a" });
  const destination = createLocalAdapterSet({ databasePath: join(destinationDirectory, "state.sqlite"), dataDirectory: destinationDirectory, publicBaseUrl: "https://cell-b.example", cellId: "cell-b" });
  const object = { bucket: "cell-a", key: "cells/cell-a/creators/creator-1/originals/source", versionId: "v1", contentType: "image/png", byteLength: 4, checksum: createHash("sha256").update("data").digest("hex"), scope: "private" };
  try {
    await source.storage.put({ object, body: Buffer.from("data") });
    await assert.rejects(() => destination.storage.get({ bucket: "cell-b", key: "cells/cell-b/creators/creator-1/originals/source" }));
    const route = { creatorId: "creator-1", homeCellId: "cell-a", homeRegion: "region-a", endpoint: "https://cell-a.example/", routingRevision: 1, state: "active", updatedAt: new Date().toISOString() };
    await source.routingDirectory.create(route);
    const executor = { placeSourceHold: async () => {}, exportSource: async () => ({ manifestChecksum: object.checksum, objectCount: 1 }), transferObjects: async () => { const copied = await source.storage.get(object); await destination.storage.put({ object: { ...object, bucket: "cell-b", key: "cells/cell-b/creators/creator-1/originals/source" }, body: copied.body }); }, importDestination: async () => {}, verifyDestination: async () => ({ objectCount: 1, verifiedObjectCount: 1 }), enableDestination: async () => {}, rollbackDestination: async () => {}, retireSource: async () => {} };
    const migration = new MigrationOrchestrator(source.routingDirectory, source.migrationCheckpoints, executor);
    const checkpoint = await migration.request({ id: "move-object", creatorId: route.creatorId, destination: { cellId: "cell-b", region: "region-b", endpoint: "https://cell-b.example/" } }); await migration.resume(checkpoint.id);
    const transferred = await destination.storage.get({ bucket: "cell-b", key: "cells/cell-b/creators/creator-1/originals/source", versionId: "v1" }); assert.equal(Buffer.from(transferred.body).toString(), "data");
    assert.equal((await source.routingDirectory.get(route.creatorId))?.homeCellId, "cell-b");
  } finally { rmSync(sourceDirectory, { recursive: true, force: true }); rmSync(destinationDirectory, { recursive: true, force: true }); }
});

test("migrates a creator through real source and destination cell endpoints", async () => {
  const sourceDirectory = mkdtempSync(join(tmpdir(), "ubeeq-migration-source-"));
  const destinationDirectory = mkdtempSync(join(tmpdir(), "ubeeq-migration-destination-"));
  const source = createLocalAdapterSet({ databasePath: join(sourceDirectory, "state.sqlite"), dataDirectory: sourceDirectory, publicBaseUrl: "https://cell-a.example", cellId: "cell-a" });
  const destination = createLocalAdapterSet({ databasePath: join(destinationDirectory, "state.sqlite"), dataDirectory: destinationDirectory, publicBaseUrl: "https://cell-b.example", cellId: "cell-b" });
  const assignedAt = "2026-08-28T00:00:00.000Z";
  const dataHome = { homeCellId: "cell-a", dataHomeRegion: "region-a", dataHomeAssignedAt: assignedAt, routingRevision: 1 };
  const bytes = Buffer.from("creator-original");
  const checksum = createHash("sha256").update(bytes).digest("hex");
  const original = { bucket: "cell-a", key: "cells/cell-a/creators/creator-1/originals/asset-1", versionId: "source-version", contentType: "image/png", byteLength: bytes.length, checksum, scope: "private" };
  let clock = Date.parse(assignedAt);
  try {
    await source.repositories.creators.create({ id: "creator-1", instanceId: "source", ...dataHome, handle: "migrating", displayName: "Migrating creator", subjectId: "subject-1" });
    await source.repositories.works.create({ id: "work-1", instanceId: "source", ...dataHome, creatorId: "creator-1", title: "Migrating work", status: "ready" });
    await source.storage.put({ object: original, body: bytes });
    await source.repositories.assets.create({ id: "asset-1", instanceId: "source", ...dataHome, creatorId: "creator-1", workId: "work-1", mimeType: "image/png", checksum, objectVersion: original.versionId, status: "ready", storage: original });
    await source.repositories.integrationAccounts.create({ id: "integration-1", instanceId: "source", ...dataHome, creatorId: "creator-1", connectorId: "reference", health: "healthy", credentialReference: "must-not-migrate" });
    await source.routingDirectory.create({ creatorId: "creator-1", homeCellId: "cell-a", homeRegion: "region-a", endpoint: "https://cell-a.example/", routingRevision: 1, state: "active", updatedAt: assignedAt });
    const sourceEndpoint = createMigrationCellEndpoint({ cellId: "cell-a", region: "region-a", instanceId: "source", repositories: source.repositories, storage: source.storage });
    const destinationEndpoint = createMigrationCellEndpoint({ cellId: "cell-b", region: "region-b", instanceId: "destination", repositories: destination.repositories, storage: destination.storage });
    const transfer = {
      transfer: async (_checkpoint, inventory) => {
        for (const entry of inventory) {
          const stored = await source.storage.get(entry.source);
          await destination.storage.put({ object: { ...stored.object, bucket: entry.destination.bucket, key: entry.destination.key, versionId: undefined }, body: stored.body });
        }
      },
      verify: async (_checkpoint, inventory) => {
        for (const entry of inventory) {
          const stored = await destination.storage.get(entry.destination);
          assert.equal(createHash("sha256").update(stored.body).digest("hex"), entry.checksum);
          assert.equal(stored.body.byteLength, entry.byteLength);
        }
        return { objectCount: inventory.length, verifiedObjectCount: inventory.length };
      }
    };
    const executor = new RemoteMigrationExecutor(sourceEndpoint, destinationEndpoint, transfer, "cell-b");
    const migration = new MigrationOrchestrator(source.routingDirectory, source.migrationCheckpoints, executor, () => new Date(clock).toISOString());
    const requested = await migration.request({ id: "migration-1", creatorId: "creator-1", destination: { cellId: "cell-b", region: "region-b", endpoint: "https://cell-b.example/" } });
    const cutOver = await migration.resume(requested.id, 60);
    assert.equal(cutOver.state, "cutover");
    assert.equal((await source.routingDirectory.get("creator-1"))?.homeCellId, "cell-b");
    assert.equal((await source.repositories.moderationHolds.list({ limit: 10 })).items.some((hold) => hold.reason === "migration:migration-1" && hold.state === "active"), true);
    const importedCreator = await destination.repositories.creators.get("creator-1");
    const importedAsset = await destination.repositories.assets.get("asset-1");
    const importedIntegration = await destination.repositories.integrationAccounts.get("integration-1");
    assert.equal(importedCreator?.homeCellId, "cell-b"); assert.equal(importedCreator?.routingRevision, 2);
    assert.equal(importedAsset?.homeCellId, "cell-b"); assert.equal(importedAsset?.storage.key, "cells/cell-b/creators/creator-1/originals/asset-1");
    assert.equal(importedIntegration?.health, "blocked"); assert.equal(importedIntegration?.credentialReference, undefined);
    assert.deepEqual(Buffer.from((await destination.storage.get({ bucket: "cell-b", key: "cells/cell-b/creators/creator-1/originals/asset-1" })).body), bytes);
    const rolledBack = await migration.rollback(requested.id);
    assert.equal(rolledBack.state, "rolled_back"); assert.equal((await source.routingDirectory.get("creator-1"))?.homeCellId, "cell-a");
    const second = await migration.request({ id: "migration-2", creatorId: "creator-1", destination: { cellId: "cell-b", region: "region-b", endpoint: "https://cell-b.example/" } });
    await migration.resume(second.id, 1);
    clock += 120_000;
    const retired = await migration.retire(second.id);
    assert.equal(retired.state, "retired");
    assert.equal(await source.repositories.creators.get("creator-1"), undefined);
    assert.equal(await source.repositories.assets.get("asset-1"), undefined);
    await assert.rejects(() => source.storage.get(original));
    assert.equal((await source.repositories.auditEvents.get("regional_migration.source_retired:migration-2"))?.action, "regional_migration.source_retired");
  } finally { rmSync(sourceDirectory, { recursive: true, force: true }); rmSync(destinationDirectory, { recursive: true, force: true }); }
});
