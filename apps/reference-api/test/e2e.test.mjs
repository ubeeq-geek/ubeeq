import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReferenceApi } from "../dist/server.js";

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
    const jobs = await request(base, "/v1/operations/jobs", { headers });
    assert.equal(jobs.response.status, 200); assert.equal(jobs.body.jobs[0].state, "completed");
    assert.equal((await request(base, "/ready")).response.status, 200);
  } finally { await api.close(); rmSync(directory, { recursive: true, force: true }); }
});
