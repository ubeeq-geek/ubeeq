import assert from "node:assert/strict";
import test from "node:test";
import { createCreatorExport, exportChecksum, planCreatorImport, validateCreatorExport } from "../dist/index.js";

const creator = { id: "creator-1", instanceId: "source", homeCellId: "cell-a", dataHomeRegion: "eu-west", dataHomeAssignedAt: "2026-01-01T00:00:00.000Z", routingRevision: 1, handle: "source", displayName: "Source", revision: 1, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
test("validates portable exports and reports deterministic import conflicts", () => {
  const manifest = createCreatorExport({ exportedAt: "2026-01-01T00:00:00.000Z", creator, works: [{ id: "work-1", instanceId: "source", homeCellId: "cell-a", dataHomeRegion: "eu-west", dataHomeAssignedAt: creator.dataHomeAssignedAt, routingRevision: 1, creatorId: creator.id, title: "Work", status: "draft", revision: 1, createdAt: creator.createdAt, updatedAt: creator.updatedAt }], assets: [], collections: [], publications: [], publicationIntents: [], processing: [], moderationEvidence: [], moderationHolds: [], reviewCases: [], auditEvents: [], usageEvents: [], integrationAccounts: [], exportCheckpoints: [], importCheckpoints: [], objectInventory: [] });
  assert.equal(validateCreatorExport(manifest).checksum, manifest.checksum);
  assert.deepEqual(planCreatorImport(manifest, { targetCreatorId: "target", existingWorkIds: ["work-1"], existingAssetIds: [], existingCollectionIds: [] }).conflicts, [{ resource: "work", id: "work-1", reason: "id_exists" }]);
  assert.throws(() => validateCreatorExport({ ...manifest, checksum: "invalid" }), /checksum/);
  const resign = (value) => { const { checksum: _checksum, ...unsigned } = value; return { ...unsigned, checksum: exportChecksum(unsigned) }; };
  assert.throws(() => validateCreatorExport(resign({ ...manifest, publications: [{ id: "publication-1", instanceId: "source", homeCellId: "cell-a", dataHomeRegion: "eu-west", dataHomeAssignedAt: creator.dataHomeAssignedAt, routingRevision: 1, workId: "missing", destination: "local", status: "live", revision: 1, createdAt: creator.createdAt, updatedAt: creator.updatedAt }] })), /dangling/);
  assert.throws(() => validateCreatorExport(resign({ ...manifest, exclusions: ["credentials"] })), /exclusions/);
  assert.throws(() => validateCreatorExport(resign({ ...manifest, works: [...manifest.works, manifest.works[0]] })), /duplicate/);
});
