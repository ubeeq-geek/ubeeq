import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReferenceApi } from "../dist/server.js";
import { createLocalAdapterSet } from "@ubeeq/adapters-local";
import { signFederationEnvelope } from "@ubeeq/federation";

const request = async (base, path, options = {}) => {
  const response = await fetch(`${base}${path}`, { ...options, headers: { "content-type": "application/json", ...(options.headers || {}) } });
  const body = response.status === 204 ? undefined : await response.json();
  return { response, body };
};

test("runs the portable signed-in upload, publish, delivery, and export workflow", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ubeeq-reference-e2e-"));
  const api = createReferenceApi({ databasePath: join(directory, "state.sqlite"), dataDirectory: directory, publicBaseUrl: "http://127.0.0.1:0" });
  await new Promise((resolve) => api.server.listen(0, "127.0.0.1", resolve));
  const address = api.server.address(); const base = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await request(base, "/health")).response.status, 200);
    const discovery = await request(base, "/.well-known/ubeeq");
    assert.equal(discovery.response.status, 200); assert.equal(discovery.body.protocolVersion, "1"); assert.equal(discovery.body.federationEnabled, false);
    assert.equal((await request(base, "/v1/auth/sign-up", { method: "POST", body: JSON.stringify({ email: "creator@example.test", password: "a-safe-local-password" }) })).response.status, 201);
    const signIn = await request(base, "/v1/auth/sign-in", { method: "POST", body: JSON.stringify({ email: "creator@example.test", password: "a-safe-local-password" }) });
    const headers = { authorization: `Bearer ${signIn.body.token}` };
    const creator = await request(base, "/v1/creators", { method: "POST", headers, body: JSON.stringify({ handle: "creator", displayName: "Creator" }) });
    assert.equal(creator.response.status, 201);
    const collection = await request(base, "/v1/collections", { method: "POST", headers, body: JSON.stringify({ title: "A local collection", visibility: "public" }) });
    assert.equal(collection.response.status, 201);
    const work = await request(base, "/v1/works", { method: "POST", headers, body: JSON.stringify({ title: "A local work" }) });
    const bytes = Buffer.from("portable image bytes"); const checksum = createHash("sha256").update(bytes).digest("hex");
    const upload = await request(base, "/v1/uploads", { method: "POST", headers, body: JSON.stringify({ workId: work.body.work.id, mimeType: "image/png", byteLength: bytes.length }) });
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
    const blocked = await request(base, `/v1/works/${work.body.work.id}/publications`, { method: "POST", headers, body: JSON.stringify({ destination: "local" }) });
    assert.equal(blocked.response.status, 409);
    assert.equal(blocked.body.error.code, "admission_blocked");
    assert.deepEqual(blocked.body.error.details.blockedSubjectIds, [work.body.work.id]);
    const release = await request(base, `/v1/operations/holds/${hold.body.hold.id}/release`, { method: "POST", headers, body: "{}" });
    assert.equal(release.response.status, 200);
    const publication = await request(base, `/v1/works/${work.body.work.id}/publications`, { method: "POST", headers: { ...headers, "idempotency-key": "publish-local-work" }, body: JSON.stringify({ destination: "local" }) });
    assert.equal(publication.response.status, 201);
    const publicWork = await request(base, `/v1/public/works/${work.body.work.id}`);
    assert.equal(publicWork.response.status, 200); assert.equal(publicWork.body.work.status, "published");
    const delivery = await fetch(publicWork.body.assets[0].delivery.url.replace("http://127.0.0.1:0", base));
    assert.deepEqual(Buffer.from(await delivery.arrayBuffer()), bytes);
    const exported = await request(base, "/v1/exports/me", { headers });
    assert.equal(exported.response.status, 200); assert.equal(exported.body.schemaVersion, "1"); assert.equal(exported.body.secretsExcluded, true); assert.equal(exported.body.works.length, 1);
    const importDirectory = mkdtempSync(join(tmpdir(), "ubeeq-reference-import-"));
    const importApi = createReferenceApi({ databasePath: join(importDirectory, "state.sqlite"), dataDirectory: importDirectory, publicBaseUrl: "http://127.0.0.1:0" });
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
  const configuration = { databasePath: join(directory, "state.sqlite"), dataDirectory: directory, publicBaseUrl: "https://reference.example", credentialEncryptionKey: "federation-test-key", federationPolicy: { id: "allow-test", apiVersion: "1", evaluateRemote: async () => "allow" } };
  const api = createReferenceApi(configuration);
  await new Promise((resolve) => api.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${api.server.address().port}`;
  const adapters = createLocalAdapterSet(configuration);
  const event = async (type, canonicalUrl, id) => signFederationEnvelope({ id, issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), payload: { type, actor: { id: "https://remote.example/actors/creator", host: "remote.example", handle: "creator", profileUrl: "https://remote.example/creator", inboxUrl: "https://remote.example/inbox" }, publication: { id: "remote-work-1", actorId: "https://remote.example/actors/creator", canonicalUrl, publishedAt: "2026-01-01T00:00:00.000Z", visibility: "public" } } }, adapters.federation);
  try {
    const accepted = await request(base, "/v1/federation/inbox", { method: "POST", body: JSON.stringify({ envelope: await event("publication_reference", "https://remote.example/works/one", "ref") }) });
    assert.equal(accepted.response.status, 201); assert.equal(accepted.body.reference.state, "accepted");
    const updated = await request(base, "/v1/federation/inbox", { method: "POST", body: JSON.stringify({ envelope: await event("publication_updated", "https://remote.example/works/one-revised", "update") }) });
    assert.equal(updated.response.status, 200); assert.equal(updated.body.reference.publicationUri, "https://remote.example/works/one-revised");
    const withdrawn = await request(base, "/v1/federation/inbox", { method: "POST", body: JSON.stringify({ envelope: await event("publication_withdrawn", "https://remote.example/works/one-revised", "withdraw") }) });
    assert.equal(withdrawn.response.status, 200); assert.equal(withdrawn.body.reference.state, "withdrawn");
  } finally { await api.close(); rmSync(directory, { recursive: true, force: true }); }
});
