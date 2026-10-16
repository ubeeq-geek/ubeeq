import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import {
  importedSourceKey,
  planHistoricalAnnouncementImport,
  validateImportedSourcePost,
  historicalSourceContentHash,
} from "../dist/index.js";
if (!globalThis.crypto) globalThis.crypto = webcrypto;
const now = "2026-10-16T00:00:00Z";
const identity = {
  tenantId: "tenant",
  ownerId: "creator",
  provider: "tumblr",
  providerOrigin: "https://api.tumblr.com",
  containers: [{ kind: "blog", id: "stable-blog-id" }],
  remoteId: "9999999999999999999",
};
const snapshot = {
  blocks: [{ kind: "text", text: "<script>plain text</script> @everyone" }],
  attachments: [],
  layout: [],
  links: [],
  tags: [],
};
const source = {
  identity,
  connectionId: "old-connection",
  attribution: { authorId: "author", displayName: "Author", kind: "original" },
  postedAt: null,
  remoteEditedAt: null,
  firstImportedAt: now,
  lastObservedAt: now,
  snapshot,
  contentHash: "hash-one",
  restrictions: {
    visibility: "unknown",
    scopeIds: [],
    reasons: ["visibility_unknown"],
  },
  completeness: "full",
  reasons: [],
  provenance: {
    jobId: "job",
    adapterVersion: "1",
    normalizerVersion: "1",
    mapping: "announcement_import",
  },
};
const input = {
  source,
  announcementId: "announcement",
  sourceAuthorized: true,
  authorAuthorized: true,
  restrictionsRepresentable: true,
};
const created = () => planHistoricalAnnouncementImport(input);

test("text-only historical import has no required Work and cannot become an outbound draft", () => {
  const result = created();
  assert.equal(result.kind, "create_announcement");
  assert.deepEqual(result.announcement.relationships, []);
  assert.equal(result.announcement.origin, "external_import");
  assert.equal(result.announcement.lifecycle, "historical");
  assert.equal(result.announcement.visibility, "private");
  assert.equal(result.announcement.status, undefined);
  assert.equal(result.announcement.createdAt, now);
  assert.equal(source.postedAt, null);
  assert.equal(
    result.announcement.content.blocks[0].text,
    snapshot.blocks[0].text,
  );
});
test("multiple images are ordered Announcement attachments, never inferred Works or a Collection", () => {
  const attachments = [0, 1, 2].map((position) => ({
    id: `image-${position}`,
    position,
    kind: "source_attachment",
    mediaType: "image",
    archive: "not_requested",
  }));
  const result = planHistoricalAnnouncementImport({
    ...input,
    source: { ...source, snapshot: { ...snapshot, attachments } },
  });
  assert.equal(result.kind, "create_announcement");
  assert.deepEqual(
    result.announcement.content.attachments.map((a) => a.id),
    ["image-0", "image-1", "image-2"],
  );
  assert.deepEqual(result.announcement.relationships, []);
});
test("source identity is stable across reconnects, property order and container ordering, but isolated by owner/provider", () => {
  const key = importedSourceKey(identity);
  assert.ok(key.includes(identity.remoteId));
  const otherConnection = { ...source, connectionId: "reconnected" };
  assert.equal(importedSourceKey(otherConnection.identity), key);
  for (const change of [
    { tenantId: "other" },
    { ownerId: "other" },
    { provider: "discord" },
    { providerOrigin: "https://other.example" },
    { remoteId: "other" },
  ])
    assert.notEqual(importedSourceKey({ ...identity, ...change }), key);
  const a = [
    { kind: "guild", id: "g" },
    { kind: "channel", id: "c" },
  ];
  assert.equal(
    importedSourceKey({ ...identity, containers: a }),
    importedSourceKey({ ...identity, containers: [...a].reverse() }),
  );
  assert.throws(() =>
    importedSourceKey({ ...identity, remoteId: 9999999999999999 }),
  );
});
test("known publication provenance wins and cannot be reclassified as an Announcement", () => {
  const association = {
    sourceKey: importedSourceKey(identity),
    tenantId: "tenant",
    ownerId: "creator",
    target: { type: "work_publication", id: "publication" },
  };
  const result = planHistoricalAnnouncementImport({
    ...input,
    existingPublication: association,
  });
  assert.equal(result.kind, "reconcile_publication");
  assert.equal(result.message, "Already tracked as a publication");
  assert.equal(result.announcement, undefined);
  assert.throws(() =>
    planHistoricalAnnouncementImport({
      ...input,
      existingPublication: { ...association, ownerId: "stranger" },
    }),
  );
});
test("reimport reconciles existing Announcements; unchanged content is a no-op", () => {
  const original = created(),
    result = planHistoricalAnnouncementImport({
      ...input,
      existingAnnouncement: {
        association: original.association,
        announcement: original.announcement,
        observedContentHash: source.contentHash,
      },
    });
  assert.equal(result.kind, "reconcile_announcement");
  assert.equal(result.update, "unchanged");
  assert.deepEqual(result.announcement, original.announcement);
});
test("source changes refresh untouched imports and preserve locally edited content for comparison", () => {
  const original = created(),
    changed = {
      ...source,
      contentHash: "new-hash",
      snapshot: {
        ...snapshot,
        blocks: [{ kind: "text", text: "Remote edit" }],
      },
    };
  const existing = {
    association: original.association,
    announcement: original.announcement,
    observedContentHash: source.contentHash,
  };
  const refreshed = planHistoricalAnnouncementImport({
    ...input,
    source: changed,
    existingAnnouncement: existing,
  });
  assert.equal(refreshed.update, "refresh_local");
  assert.equal(refreshed.announcement.content.blocks[0].text, "Remote edit");
  const local = {
    ...original.announcement,
    localEditedAt: now,
    content: { ...snapshot, blocks: [{ kind: "text", text: "Local edit" }] },
  };
  const preserved = planHistoricalAnnouncementImport({
    ...input,
    source: changed,
    existingAnnouncement: { ...existing, announcement: local },
  });
  assert.equal(preserved.update, "review_source_change");
  assert.deepEqual(preserved.announcement, local);
});
test("proven existing outbound Announcements reconcile without changing content or scheduling another delivery", () => {
  const original = created(),
    announcement = {
      id: "outbound",
      tenantId: "tenant",
      ownerId: "creator",
      origin: "local",
      lifecycle: "outbound",
      content: snapshot,
      localEditedAt: null,
    };
  const association = {
    ...original.association,
    target: { type: "announcement", id: "outbound" },
  };
  const result = planHistoricalAnnouncementImport({
    ...input,
    existingAnnouncement: {
      association,
      announcement,
      observedContentHash: "different",
    },
  });
  assert.equal(result.kind, "reconcile_announcement");
  assert.equal(result.update, "review_source_change");
  assert.deepEqual(result.announcement, announcement);
});
test("source scope, author authority, restrictions and exclusion markers fail closed before reconciliation", () => {
  for (const [field, reason] of [
    ["sourceAuthorized", "author_excluded"],
    ["authorAuthorized", "author_excluded"],
    ["restrictionsRepresentable", "source_restriction"],
  ]) {
    assert.deepEqual(
      planHistoricalAnnouncementImport({ ...input, [field]: false }),
      { kind: "skip", reason },
    );
  }
  assert.equal(
    planHistoricalAnnouncementImport({ ...input, excluded: true }).reason,
    "source_excluded",
  );
  assert.equal(
    planHistoricalAnnouncementImport({
      ...input,
      excluded: true,
      restoreExcluded: true,
    }).kind,
    "create_announcement",
  );
});
test("reblogs require explicit inclusion and preserve attribution; replies and system events remain excluded", () => {
  for (const kind of ["reblog", "forwarded", "reply", "system"]) {
    const candidate = {
      ...source,
      attribution: {
        ...source.attribution,
        kind,
        originalAuthorId: "original-author",
      },
    };
    assert.equal(
      planHistoricalAnnouncementImport({ ...input, source: candidate }).reason,
      "author_excluded",
    );
    if (["reblog", "forwarded"].includes(kind))
      assert.equal(
        planHistoricalAnnouncementImport({
          ...input,
          source: candidate,
          includeAttributedMaterial: true,
        }).kind,
        "create_announcement",
      );
    else
      assert.equal(
        planHistoricalAnnouncementImport({
          ...input,
          source: candidate,
          includeAttributedMaterial: true,
        }).reason,
        "author_excluded",
      );
    assert.equal(candidate.attribution.originalAuthorId, "original-author");
  }
});
test("metadata-only imports require explicit selection and unavailable content is skipped", () => {
  assert.equal(
    planHistoricalAnnouncementImport({
      ...input,
      source: { ...source, completeness: "metadata_only" },
    }).reason,
    "metadata_selection_required",
  );
  assert.equal(
    planHistoricalAnnouncementImport({
      ...input,
      source: { ...source, completeness: "metadata_only" },
      includeMetadataOnly: true,
    }).kind,
    "create_announcement",
  );
  assert.equal(
    planHistoricalAnnouncementImport({
      ...input,
      source: { ...source, completeness: "unavailable" },
      includeMetadataOnly: true,
    }).reason,
    "source_unavailable",
  );
});
test("only explicit mapping evidence links existing authorized Works and Collections", () => {
  const relationships = [
    { type: "work", id: "work", evidence: "canonical_url" },
    { type: "collection", id: "collection", evidence: "explicit_selection" },
  ];
  assert.deepEqual(
    planHistoricalAnnouncementImport({ ...input, relationships }).announcement
      .relationships,
    relationships,
  );
  assert.throws(() =>
    planHistoricalAnnouncementImport({
      ...input,
      relationships: [
        { type: "work", id: "work", evidence: "similar_caption" },
      ],
    }),
  );
});
test("snapshots reject signed references, fabricated archived assets, unsafe URLs and invalid dates", () => {
  assert.throws(() =>
    validateImportedSourcePost({ ...source, postedAt: "unknown" }),
  );
  for (const url of [
    "javascript:alert(1)",
    "https://user:secret@example.com/post",
    "https://cdn.example/media?signature=secret",
  ])
    assert.throws(() =>
      validateImportedSourcePost({ ...source, sourceUrl: url }),
    );
  assert.throws(() =>
    validateImportedSourcePost({
      ...source,
      snapshot: {
        ...snapshot,
        attachments: [
          {
            id: "one",
            position: 0,
            kind: "source_attachment",
            mediaType: "image",
            archive: "archived",
          },
        ],
      },
    }),
  );
});
test("observation hash ignores reconnection, job and local media outcomes while detecting remote content changes", async () => {
  const a = {
    id: "one",
    position: 0,
    kind: "source_attachment",
    mediaType: "image",
    archive: "pending",
  };
  const observed = { ...source, snapshot: { ...snapshot, attachments: [a] } };
  const hash = await historicalSourceContentHash(observed);
  assert.equal(
    hash,
    await historicalSourceContentHash({
      ...observed,
      connectionId: "new",
      lastObservedAt: "2027-01-01",
      provenance: { ...source.provenance, jobId: "next" },
      snapshot: {
        ...snapshot,
        attachments: [
          { ...a, archive: "archived", managedAssetId: "private-asset" },
        ],
      },
    }),
  );
  assert.notEqual(
    hash,
    await historicalSourceContentHash({ ...observed, postedAt: now }),
  );
});
