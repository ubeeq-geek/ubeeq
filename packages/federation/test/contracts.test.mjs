import assert from "node:assert/strict";
import test from "node:test";
import { normalizeFederationHost, validateRemoteActor, validateRemotePublication } from "../dist/index.js";

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
