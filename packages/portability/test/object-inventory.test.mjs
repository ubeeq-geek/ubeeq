import test from 'node:test';
import assert from 'node:assert/strict';
import { createCreatorExport, validateCreatorExport, exportChecksum } from '../dist/index.js';

const home = { homeCellId: 'cell', dataHomeRegion: 'region', dataHomeAssignedAt: '2026-01-01T00:00:00Z', routingRevision: 1 };
const creator = { ...home, id: 'creator', instanceId: 'instance', revision: 1 };
const asset = id => ({ ...home, id, instanceId: 'instance', creatorId: 'creator', checksum: 'a'.repeat(64), objectVersion: 'version',
  storage: { key: `cells/cell/creators/creator/${id}`, versionId: 'storage-version', byteLength: 12 } });
const make = () => {
  const assets = [asset('one'), asset('two')];
  return createCreatorExport({ exportedAt: '2026-01-01T00:00:00Z', creator, assets, works: [], collections: [], publications: [],
    publicationIntents: [], processing: [], moderationEvidence: [], moderationHolds: [], reviewCases: [], auditEvents: [], usageEvents: [],
    integrationAccounts: [], exportCheckpoints: [], importCheckpoints: [], objectInventory: assets.map(value => ({ assetId: value.id,
      key: value.storage.key, versionId: value.storage.versionId, checksum: value.checksum, byteLength: 12, transferState: 'manifest_only' })) });
};
const resign = manifest => { const { checksum, ...unsigned } = manifest; return { ...unsigned, checksum: exportChecksum(unsigned) }; };
test('inventory binds the active object checksum independently of the original asset checksum', () => {
  const manifest = make();
  manifest.assets[0].storage.checksum = 'b'.repeat(64);
  assert.throws(() => validateCreatorExport(resign(manifest)), /object inventory/);
  manifest.objectInventory[0].checksum = 'B'.repeat(64);
  assert.ok(validateCreatorExport(resign(manifest)));
  assert.equal(manifest.assets[0].checksum, 'a'.repeat(64));
  manifest.assets[0].storage.checksum = 123;
  assert.throws(() => validateCreatorExport(resign(manifest)), /object inventory/);
});
test('export inventory covers each asset exactly once and binds retained source metadata', () => {
  const manifest = make(); assert.equal(validateCreatorExport(manifest).checksum, manifest.checksum);
  for (const patch of [{ assetId: 'one' }, { assetId: 'missing' }, { versionId: 'other-version' }, { checksum: 'b'.repeat(64) },
    { byteLength: 13 }, { byteLength: undefined }, { key: 'cells/cell/creators/creator/another' }, { key: undefined },
    { transferState: 'transferred' }, { key: 123 }]) {
    const changed = structuredClone(manifest); Object.assign(changed.objectInventory[1], patch);
    assert.throws(() => validateCreatorExport(resign(changed)), /object inventory/);
  }
  const changed = structuredClone(manifest); changed.objectInventory[0] = null;
  assert.throws(() => validateCreatorExport(resign(changed)), /object inventory/);
});
test('legacy asset version fallback and optional object size remain supported', () => {
  const manifest = make();
  for (const value of manifest.assets) delete value.storage;
  for (const object of manifest.objectInventory) { object.versionId = 'version'; delete object.byteLength; delete object.key; }
  assert.ok(validateCreatorExport(resign(manifest)));
  manifest.objectInventory[0].versionId = 'storage-version';
  assert.throws(() => validateCreatorExport(resign(manifest)), /object inventory/);
});
