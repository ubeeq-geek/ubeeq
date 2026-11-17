import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReferenceApi } from "../dist/server.js";

const request = async (base, path, options = {}) => {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) }
  });
  const body = response.status === 204 ? undefined : await response.json();
  return { response, body };
};

test("Single Operator Tenancy & Creator Identity switching in reference API", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ubeeq-single-op-"));
  const api = createReferenceApi({
    databasePath: join(directory, "state.sqlite"),
    dataDirectory: directory,
    publicBaseUrl: "http://127.0.0.1:0",
    cellId: "cell-test"
  });

  await new Promise((resolve) => api.server.listen(0, "127.0.0.1", resolve));
  const address = api.server.address();
  const base = `http://127.0.0.1:${address.port}`;

  try {
    // 1. Sign up operator user 1
    const signUp1 = await request(base, "/v1/auth/sign-up", {
      method: "POST",
      body: JSON.stringify({ email: "operator@example.test", password: "operator-safe-password" })
    });
    assert.equal(signUp1.response.status, 201);

    const signIn1 = await request(base, "/v1/auth/sign-in", {
      method: "POST",
      body: JSON.stringify({ email: "operator@example.test", password: "operator-safe-password" })
    });
    assert.equal(signIn1.response.status, 200);
    const opHeaders = { authorization: `Bearer ${signIn1.body.token}` };

    // 2. Initial Creator Identity registration succeeds
    const creator1 = await request(base, "/v1/creators", {
      method: "POST",
      headers: opHeaders,
      body: JSON.stringify({ handle: "persona-one", displayName: "Persona One" })
    });
    assert.equal(creator1.response.status, 201);
    assert.equal(creator1.body.creator.handle, "persona-one");
    const creator1Id = creator1.body.creator.id;

    // 3. Same operator can create a secondary Creator Identity (persona)
    const creator2 = await request(base, "/v1/creators", {
      method: "POST",
      headers: opHeaders,
      body: JSON.stringify({ handle: "persona-two", displayName: "Persona Two" })
    });
    assert.equal(creator2.response.status, 201);
    assert.equal(creator2.body.creator.handle, "persona-two");
    const creator2Id = creator2.body.creator.id;
    assert.notEqual(creator1Id, creator2Id);

    // 4. GET /v1/creators lists all identities belonging to this operator
    const listCreators = await request(base, "/v1/creators", { headers: opHeaders });
    assert.equal(listCreators.response.status, 200);
    assert.equal(listCreators.body.creators.length, 2);
    const handles = listCreators.body.creators.map((c) => c.handle);
    assert(handles.includes("persona-one"));
    assert(handles.includes("persona-two"));

    // 5. GET /v1/creators/me defaults to first accessible identity, or switches with x-creator-id
    const defaultMe = await request(base, "/v1/creators/me", { headers: opHeaders });
    assert.equal(defaultMe.response.status, 200);
    assert.equal(defaultMe.body.creator.id, creator1Id);

    const switchedMe = await request(base, "/v1/creators/me", {
      headers: { ...opHeaders, "x-creator-id": creator2Id }
    });
    assert.equal(switchedMe.response.status, 200);
    assert.equal(switchedMe.body.creator.id, creator2Id);

    // 6. Creating work bound to specific persona via x-creator-id
    const work1 = await request(base, "/v1/works", {
      method: "POST",
      headers: { ...opHeaders, "x-creator-id": creator2Id },
      body: JSON.stringify({ title: "Persona Two Work" })
    });
    assert.equal(work1.response.status, 201);
    assert.equal(work1.body.work.creatorId, creator2Id);

    // 7. Secondary user sign up and attempt to register a new creator profile is REJECTED (403)
    const signUp2 = await request(base, "/v1/auth/sign-up", {
      method: "POST",
      body: JSON.stringify({ email: "second-user@example.test", password: "user-safe-password" })
    });
    assert.equal(signUp2.response.status, 201);

    const signIn2 = await request(base, "/v1/auth/sign-in", {
      method: "POST",
      body: JSON.stringify({ email: "second-user@example.test", password: "user-safe-password" })
    });
    assert.equal(signIn2.response.status, 200);
    const user2Headers = { authorization: `Bearer ${signIn2.body.token}` };

    const secondOpAttempt = await request(base, "/v1/creators", {
      method: "POST",
      headers: user2Headers,
      body: JSON.stringify({ handle: "rogue-operator", displayName: "Rogue Operator" })
    });
    assert.equal(secondOpAttempt.response.status, 403);
    assert.equal(secondOpAttempt.body.error.code, "SINGLE_OPERATOR_INSTANCE_LIMIT");

    // 8. Secondary user (without creator role) has zero creator access -> 403 creator_access_denied
    const rogueWorkAttempt = await request(base, "/v1/works", {
      method: "POST",
      headers: user2Headers,
      body: JSON.stringify({ title: "Unauthorized Work" })
    });
    assert.equal(rogueWorkAttempt.response.status, 403);
    assert.equal(rogueWorkAttempt.body.error.code, "creator_access_denied");

    // 9. Contributor mutation endpoints return 403 FEATURE_DISABLED_IN_SINGLE_OPERATOR_MODE
    const contributorAddAttempt = await request(base, `/v1/creators/${creator1Id}/members`, {
      method: "POST",
      headers: opHeaders,
      body: JSON.stringify({ userId: "some-user" })
    });
    assert.equal(contributorAddAttempt.response.status, 403);
    assert.equal(contributorAddAttempt.body.error.code, "FEATURE_DISABLED_IN_SINGLE_OPERATOR_MODE");

    const invitationDeleteAttempt = await request(base, `/v1/creators/${creator1Id}/invitations/inv-1`, {
      method: "DELETE",
      headers: opHeaders
    });
    assert.equal(invitationDeleteAttempt.response.status, 403);
    assert.equal(invitationDeleteAttempt.body.error.code, "FEATURE_DISABLED_IN_SINGLE_OPERATOR_MODE");

    // 10. Organization mutation endpoints return 403 FEATURE_DISABLED_IN_SINGLE_OPERATOR_MODE
    const orgCreateAttempt = await request(base, "/v1/organizations", {
      method: "POST",
      headers: opHeaders,
      body: JSON.stringify({ name: "Rogue Org" })
    });
    assert.equal(orgCreateAttempt.response.status, 403);
    assert.equal(orgCreateAttempt.body.error.code, "FEATURE_DISABLED_IN_SINGLE_OPERATOR_MODE");

    // 11. Canonical native publishing route PUT /studio/works/:workId/publications/native
    // First, create work with an asset so it can be published
    const workToPublish = await request(base, "/v1/works", {
      method: "POST",
      headers: opHeaders,
      body: JSON.stringify({ title: "Work To Publish" })
    });
    assert.equal(workToPublish.response.status, 201);
    const pubWorkId = workToPublish.body.work.id;

    const bytes = Buffer.from("test image data");
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const upload = await request(base, "/v1/uploads", {
      method: "POST",
      headers: opHeaders,
      body: JSON.stringify({ workId: pubWorkId, mimeType: "image/png", byteLength: bytes.length, checksum })
    });
    await request(base, `/v1/uploads/${upload.body.upload.uploadId}/content`, {
      method: "PUT",
      headers: opHeaders,
      body: JSON.stringify({ base64: bytes.toString("base64") })
    });
    const complete = await request(base, `/v1/uploads/${upload.body.upload.uploadId}/complete`, {
      method: "POST",
      headers: opHeaders,
      body: JSON.stringify({ workId: pubWorkId, checksum, byteLength: bytes.length })
    });
    assert.equal(complete.response.status, 202);
    // Process asset job
    const jobResult = await api.runNextJob("test-worker");
    assert.ok(jobResult);

    // Call PUT /studio/works/:workId/publications/native
    const nativePub = await request(base, `/studio/works/${pubWorkId}/publications/native`, {
      method: "PUT",
      headers: opHeaders,
      body: JSON.stringify({ published: true })
    });
    assert.equal(nativePub.response.status, 201);
    assert.equal(nativePub.body.publication.destination, "native");
    assert.equal(nativePub.body.publication.status, "live");

    // Withdraw / unpublish via PUT /studio/works/:workId/publications/native with published: false
    const nativeUnpub = await request(base, `/studio/works/${pubWorkId}/publications/native`, {
      method: "PUT",
      headers: opHeaders,
      body: JSON.stringify({ published: false })
    });
    assert.equal(nativeUnpub.response.status, 200);
    assert.equal(nativeUnpub.body.status, "withdrawn");
  } finally {
    await api.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
