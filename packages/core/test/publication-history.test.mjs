import assert from "node:assert/strict";
import test from "node:test";
import { appendPublicationDisclosureSnapshot, assertPublicationDisclosureHistoryImmutable, activePublicationDisclosureSnapshot } from "../dist/index.js";

test("publication attempts append once and cannot change their original disclosure", () => {
  const first = { attemptKey: "attempt", snapshotId: "first", fingerprintSha256: "fingerprint", customDisclosure: { labels: ["a", "b"] } };
  const publication = appendPublicationDisclosureSnapshot({ publicationId: "publication" }, first);
  const retry = appendPublicationDisclosureSnapshot(publication, { ...first, snapshotId: "retry" });
  assert.equal(retry.disclosureSnapshots.length, 1);
  assert.equal(activePublicationDisclosureSnapshot(retry), first);
  assert.throws(() => appendPublicationDisclosureSnapshot(publication, { ...first, fingerprintSha256: "changed" }), /immutable for this attempt/);
  assert.throws(() => appendPublicationDisclosureSnapshot(publication, { ...first, attemptKey: "second" }), /identifier is already in use/);
});

test("history permits only appends, regardless of object key order", () => {
  const first = { attemptKey: "attempt", snapshotId: "first", fingerprintSha256: "fingerprint", fields: { a: 1, b: [1, 2] } };
  const previous = { disclosureSnapshots: [first] };
  assert.doesNotThrow(() => assertPublicationDisclosureHistoryImmutable(previous, { disclosureSnapshots: [{ ...first, fields: { b: [1, 2], a: 1 } }, { ...first, attemptKey: "next", snapshotId: "second" }] }));
  assert.throws(() => assertPublicationDisclosureHistoryImmutable(previous, {}), /cannot be removed/);
  assert.throws(() => assertPublicationDisclosureHistoryImmutable(previous, { disclosureSnapshots: [{ ...first, fields: { a: 1, b: [2, 1] } }] }), /immutable/);
});
