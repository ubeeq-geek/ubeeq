import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCreatorContentExport, planCreatorContentImport } from '../dist/index.js';
const file = { fileId: 'source', creatorId: 'creator', sourceKind: 'document', mimeType: 'application/pdf', storageKey: 'private/key', createdAt: 'now', updatedAt: 'now' };
const manifest = { schema: 'https://ubeeq.site/schemas/creator-export/v1', schemaVersion: 1, generatedAt: '2026-09-09T00:00:00Z',
  source: { product: 'reference', tenantId: 'tenant' }, creator: { id: 'creator' }, works: [], collections: [], integrationAccounts: [], sourceFiles: [file] };
const inventory = { targetTenantId: 'target', targetCreatorId: 'target', existingWorkIds: [], existingAssetIds: [], existingCollectionIds: [] };
test('source-file exports validate identities and require explicit collision inventory', () => {
  const json = JSON.stringify(manifest);
  assert.equal(parseCreatorContentExport(json).counts.sourceFiles, 1);
  assert.throws(() => planCreatorContentImport(json, inventory), /Source-file collision inventory/);
  const plan = planCreatorContentImport(json, { ...inventory, existingSourceFileIds: ['source'] });
  assert.equal(plan.executionAuthorized, false);
  assert.deepEqual(plan.conflicts, [{ resource: 'sourceFile', id: 'source', reason: 'id_exists' }]);
  for (const sourceFiles of [[file, file], [{ ...file, creatorId: 'foreign' }], [{ ...file, tenantId: 'foreign' }], [{ ...file, storageKey: '' }]])
    assert.throws(() => parseCreatorContentExport(JSON.stringify({ ...manifest, sourceFiles })));
  const { sourceFiles: omitted, ...legacy } = manifest;
  assert.equal(planCreatorContentImport(JSON.stringify(legacy), inventory).executionAuthorized, false);
});
