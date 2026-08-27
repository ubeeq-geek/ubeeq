import assert from "node:assert/strict";
import test from "node:test";
import { createFederationInstanceDocument, federationSigningInput, normalizeFederationHost, validateRemoteActor, validateRemotePublication, verifyFederationEnvelope } from "../dist/index.js";

test("validates neutral remote actor references without a trust decision", () => {
  assert.deepEqual(validateRemoteActor({
    id: "https://remote.example/actors/a",
    host: "REMOTE.example",
    handle: "a@remote.example",
    profileUrl: "https://remote.example/profiles/a",
    inboxUrl: "https://remote.example/inbox/a"
  }), {
    id: "https://remote.example/actors/a",
    host: "remote.example",
    handle: "a@remote.example",
    profileUrl: "https://remote.example/profiles/a",
    inboxUrl: "https://remote.example/inbox/a"
  });
  assert.equal(normalizeFederationHost("remote.example:443"), "remote.example");
});

test("validates instance discovery and verifies signature before consuming a replay key", async () => {
  const document = createFederationInstanceDocument({ protocolVersion: "1", instanceId: "instance", instanceUrl: "https://local.example", actorDocumentUrl: "https://local.example/actors", publicationInboxUrl: "https://local.example/inbox", signingKeyId: "key-1", signingPublicKey: "public-key", capabilities: ["withdrawal", "publication-reference", "withdrawal"] });
  assert.deepEqual(document.capabilities, ["publication-reference", "withdrawal"]);
  const envelope = { id: "delivery-1", issuedAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-01T01:00:00.000Z", keyId: "key-1", payload: { publication: "https://remote.example/p/1" }, signature: "valid" };
  const { signature: _signature, ...unsignedEnvelope } = envelope;
  const consumed = [];
  await verifyFederationEnvelope(envelope, { verify: async ({ message }) => message === federationSigningInput(unsignedEnvelope) }, { consume: async ({ envelopeId }) => { consumed.push(envelopeId); return true; } }, new Date("2026-01-01T00:30:00.000Z"));
  assert.deepEqual(consumed, ["delivery-1"]);
});

test("rejects malformed, cross-host, and non-HTTPS federation references", () => {
  assert.throws(() => normalizeFederationHost("remote.example/path"));
  assert.throws(() => validateRemoteActor({
    id: "actor",
    host: "remote.example",
    handle: "remote",
    profileUrl: "http://remote.example/profile",
    inboxUrl: "https://remote.example/inbox"
  }));
  assert.throws(() => validateRemotePublication({
    id: "publication",
    actorId: "actor",
    canonicalUrl: "https://remote.example/publications/1",
    publishedAt: "not-a-date",
    visibility: "public"
  }));
});
