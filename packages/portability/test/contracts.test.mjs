import assert from "node:assert/strict";
import test from "node:test";
import { createCreatorExport, planCreatorImport, validateCreatorExport } from "../dist/index.js";

const creator = { id: "creator-1", instanceId: "source", handle: "source", displayName: "Source", revision: 1, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
test("validates portable exports and reports deterministic import conflicts", () => {
  const manifest = createCreatorExport({ exportedAt: "2026-01-01T00:00:00.000Z", creator, works: [{ id: "work-1", instanceId: "source", creatorId: creator.id, title: "Work", status: "draft", revision: 1, createdAt: creator.createdAt, updatedAt: creator.updatedAt }], assets: [], collections: [], publications: [] });
  assert.equal(validateCreatorExport(manifest).checksum, manifest.checksum);
  assert.deepEqual(planCreatorImport(manifest, { targetCreatorId: "target", existingWorkIds: ["work-1"], existingAssetIds: [], existingCollectionIds: [] }).conflicts, [{ resource: "work", id: "work-1", reason: "id_exists" }]);
  assert.throws(() => validateCreatorExport({ ...manifest, checksum: "invalid" }), /checksum/);
});
