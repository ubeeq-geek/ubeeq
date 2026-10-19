import test from "node:test";
import assert from "node:assert/strict";
import {
  INTEGRATION_IMPORT_LABELS,
  integrationImportReadiness,
  validateAnnouncementImportScope,
  requireAnnouncementImportPreview,
  supportsIntegrationOperation,
} from "../dist/index.js";
const capability = {
  action: "announcements",
  label: "Import Announcements",
  support: "implemented",
  connectionModes: ["bot"],
  requiredPermissions: ["history", "content"],
  sourceTypes: ["channel"],
  filters: {
    dates: true,
    authors: true,
    attachments: true,
    boundedPagination: true,
  },
};
const connection = {
  mode: "bot",
  authorized: true,
  permissions: ["history", "content"],
  sourceSelected: true,
  hostEnabled: true,
};
const scope = {
  from: "2026-07-15T00:00:00Z",
  to: "2026-10-15T00:00:00Z",
  sourceIds: ["channel"],
  authorIds: ["author"],
  includeAttachments: true,
  includeAttributedMaterial: false,
  includeMetadataOnly: false,
  limits: { pages: 10, candidates: 100, elapsedMilliseconds: 60000 },
};

test("semantic labels and new Announcement capability preserve old persisted import operations", () => {
  assert.equal(
    INTEGRATION_IMPORT_LABELS.published_works,
    "Import Published Works",
  );
  assert.equal(INTEGRATION_IMPORT_LABELS.announcements, "Import Announcements");
  assert.equal(INTEGRATION_IMPORT_LABELS.raw_files, "Import files");
  assert.equal(
    supportsIntegrationOperation(
      { capabilities: ["catalogue_import"] },
      "import",
    ),
    true,
  );
  assert.equal(
    supportsIntegrationOperation(
      { capabilities: ["catalogue_import"] },
      "import_announcements",
    ),
    false,
  );
  assert.equal(
    supportsIntegrationOperation(
      { capabilities: ["announcement_import"] },
      "import_announcements",
    ),
    true,
  );
  assert.equal(
    supportsIntegrationOperation(
      { capabilities: ["announcement_import"] },
      "import",
    ),
    false,
  );
});
test("readiness separates provider implementation, host policy, connection mode, permissions and source selection", () => {
  assert.equal(
    integrationImportReadiness(capability, connection).enabled,
    true,
  );
  assert.equal(
    integrationImportReadiness(capability, { ...connection, mode: "webhook" })
      .state,
    "authorization_required",
  );
  assert.match(
    integrationImportReadiness(capability, { ...connection, mode: "webhook" })
      .reason,
    /webhook/,
  );
  assert.equal(
    integrationImportReadiness(capability, {
      ...connection,
      permissions: ["history"],
    }).state,
    "authorization_required",
  );
  assert.equal(
    integrationImportReadiness(capability, {
      ...connection,
      sourceSelected: false,
    }).state,
    "source_selection_required",
  );
  for (const support of ["unsupported", "not_implemented"])
    assert.equal(
      integrationImportReadiness({ ...capability, support }, connection)
        .enabled,
      false,
    );
  assert.equal(
    integrationImportReadiness(capability, {
      ...connection,
      hostEnabled: false,
    }).state,
    "temporarily_unavailable",
  );
});
test("scope rejects unbounded crawls, missing authors, duplicate sources and excessive pages or elapsed time", () => {
  validateAnnouncementImportScope(scope);
  for (const change of [
    { from: "" },
    { to: scope.from },
    { to: "2030-01-01" },
    { authorIds: [] },
    { sourceIds: ["channel", "channel"] },
    { limits: { ...scope.limits, pages: 0 } },
    { limits: { ...scope.limits, elapsedMilliseconds: 999999 } },
  ])
    assert.throws(() =>
      validateAnnouncementImportScope({ ...scope, ...change }),
    );
});
test("preview bindings prevent owner/actor/connection/revision substitution, selection expansion, expiry and replay after authorization changes", () => {
  const binding = {
    id: "opaque-server-record",
    tenantId: "tenant",
    ownerId: "creator",
    requestedByUserId: "user",
    connectionId: "connection",
    authorizationRevision: "revision",
    scope,
    candidateSourceKeys: ["one", "two"],
    expiresAt: "2026-10-16T00:00:00Z",
  };
  const expected = {
    tenantId: "tenant",
    ownerId: "creator",
    requestedByUserId: "user",
    connectionId: "connection",
    authorizationRevision: "revision",
    selectedSourceKeys: ["one"],
    now: new Date("2026-10-15T00:00:00Z"),
  };
  requireAnnouncementImportPreview(binding, expected);
  for (const field of [
    "tenantId",
    "ownerId",
    "requestedByUserId",
    "connectionId",
    "authorizationRevision",
  ])
    assert.throws(() =>
      requireAnnouncementImportPreview(binding, {
        ...expected,
        [field]: "other",
      }),
    );
  for (const selectedSourceKeys of [[], ["one", "one"], ["three"]])
    assert.throws(() =>
      requireAnnouncementImportPreview(binding, {
        ...expected,
        selectedSourceKeys,
      }),
    );
  assert.throws(() =>
    requireAnnouncementImportPreview(binding, {
      ...expected,
      now: new Date(binding.expiresAt),
    }),
  );
});

test('newest-first providers can retain a bounded full-history cursor without repeated yearly scans',()=>{
 validateAnnouncementImportScope({...scope,from:'2000-01-01',paginationOrder:'newest_first'});
 assert.throws(()=>validateAnnouncementImportScope({...scope,from:'1800-01-01',paginationOrder:'newest_first'}));
});
