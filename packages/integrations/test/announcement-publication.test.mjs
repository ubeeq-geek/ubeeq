import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createAnnouncementPublication as create, assertAnnouncementPublicationImmutable as immutable } from "../dist/index.js";

const input = () => ({ provider: "custom-provider", connectionId: "connection", targetId: "target",
  workId: "work", idempotencyKey: "release", content: { version: 1, title: "Work", metadata: { labels: ["original"] } } });

test("publication IDs preserve legacy tuple hashing and isolate destinations", () => {
  const value = input(), tuple = [value.provider, value.connectionId, value.targetId, value.idempotencyKey];
  const legacy = createHash("sha256").update(JSON.stringify(tuple, Object.keys(tuple).sort())).digest("hex");
  assert.equal(create(value).announcementPublicationId, legacy);
  assert.equal(create(value).status, "queued");
  for (const key of ["provider", "connectionId", "targetId", "idempotencyKey"]) {
    assert.notEqual(create({ ...value, [key]: "different" }).announcementPublicationId, legacy);
  }
  assert.throws(() => create({ ...value, idempotencyKey: " " }), /idempotency key/);
});

test("queued snapshots are detached from caller-owned nested objects", () => {
  const value = input(), publication = create(value);
  value.content.metadata.labels.push("caller edit");
  assert.deepEqual(publication.content.metadata.labels, ["original"]);
  publication.content.metadata.labels.push("publication edit");
  assert.deepEqual(value.content.metadata.labels, ["original", "caller edit"]);
});

test("content, identity and routing cannot change under an existing publication ID", () => {
  const publication = create(input());
  for (const key of ["announcementPublicationId", "idempotencyKey", "provider", "connectionId", "targetId", "workId"]) {
    assert.throws(() => immutable(publication, { ...publication, [key]: "different" }), /immutable/);
  }
  assert.throws(() => immutable(publication, { ...publication, workId: undefined }), /immutable/);
  assert.throws(() => immutable(publication, { ...publication, content: { ...publication.content, title: "Changed" } }), /immutable/);
});

test("delivery state and remote references remain updateable without changing the snapshot", () => {
  const publication = create(input());
  for (const status of ["sending", "sent", "retry_scheduled", "failed", "cancelled"]) {
    assert.doesNotThrow(() => immutable(publication, { ...publication, content: structuredClone(publication.content),
      status, remoteId: "remote", remoteUri: "https://example.test/result" }));
  }
});
