import assert from "node:assert/strict";
import test from "node:test";
import { contentAvailabilityFor, isCollectionVisible, isPublicationActive } from "../dist/index.js";

const imported = { origin: { type: "import", remoteId: "remote-1" } };
const local = { origin: { type: "local" } };
const attachment = { workId: "work", assetId: "asset", role: "content", position: 0 };
const asset = (storage, status = "ready", metadata) => ({
  id: "asset", instanceId: "instance", creatorId: "creator", kind: "image", status,
  mimeType: "image/jpeg", storage, metadata, createdAt: "now", updatedAt: "now", attachment
});

test("derives neutral collection visibility and publication activity", () => {
  assert.equal(isCollectionVisible({ status: "published", visibility: "public" }), true);
  assert.equal(isCollectionVisible({ status: "published", visibility: "private" }), false);
  assert.equal(isCollectionVisible({ status: "draft", visibility: "unlisted" }), false);
  assert.equal(isPublicationActive({ status: "live" }), true);
  assert.equal(isPublicationActive({ status: "updating" }), true);
  assert.equal(isPublicationActive({ status: "queued" }), false);
});

test("derives neutral content availability from assets and origin", () => {
  assert.equal(contentAvailabilityFor(imported, []), "external_reference");
  assert.equal(contentAvailabilityFor(local, []), "metadata_only");
  assert.equal(contentAvailabilityFor(local, [asset({ mode: "hosted", objectKey: "original" })]), "original_hosted");
  assert.equal(contentAvailabilityFor(local, [asset({ mode: "hosted", objectKey: "copy" }, "ready", { sourceCopyQuality: "display_copy" })]), "display_copy");
  assert.equal(contentAvailabilityFor(local, [asset({ mode: "external", externalUrl: "https://example.test/work" })]), "external_reference");
});
