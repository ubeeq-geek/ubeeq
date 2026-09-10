import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleCreatorContentExport, planCreatorContentImport } from '../dist/index.js';

const source = () => {
  const scope = { creatorId: 'source-creator', tenantId: 'source-tenant' };
  return JSON.stringify({ ...assembleCreatorContentExport({ generatedAt: '2026-01-01T00:00:00Z', source: { tenantId: scope.tenantId, product: 'source' },
    creator: { id: scope.creatorId }, works: Array.from({ length: 102 }, (_, index) => ({ work: { ...scope, workId: `work-${index}`, title: 'Keep identity' },
      assets: [{ ...scope, assetId: 'shared-asset', storage: { externalUrl: 'https://untrusted.invalid/private' } }] })),
    collections: [{ collection: { ...scope, collectionId: 'collection' }, works: [{ workId: 'work-101', position: 0 }] }],
    integrationAccounts: [], sanitizeIntegrationAccount: value => value }), retainedAssets: [{ ...scope, assetId: 'detached', storage: { key: 'untrusted' } }] });
};
test('preflight finds later IDs, includes detached assets and never authorizes execution', () => {
  const json = source();
  const inventory = { targetTenantId: 'target', targetCreatorId: 'target-creator', existingWorkIds: ['unrelated', 'work-101'],
    existingAssetIds: ['detached'], existingCollectionIds: ['collection'] };
  const before = structuredClone(inventory);
  const plan = planCreatorContentImport(json, inventory);
  assert.deepEqual(plan.counts, { works: 102, assets: 2, retainedAssets: 1, collections: 1 });
  assert.deepEqual(plan.conflicts, [{ resource: 'work', id: 'work-101', reason: 'id_exists' },
    { resource: 'asset', id: 'detached', reason: 'id_exists' }, { resource: 'collection', id: 'collection', reason: 'id_exists' }]);
  assert.deepEqual(plan.assetsRequiringVerification, ['shared-asset', 'detached']);
  assert.equal(plan.executionAuthorized, false);
  assert.deepEqual(inventory, before);
  assert.equal(json, source());
  const emptyTarget = planCreatorContentImport(json, { ...inventory, existingWorkIds: [], existingAssetIds: [], existingCollectionIds: [] });
  assert.deepEqual(emptyTarget.conflicts, []);
  assert.equal(emptyTarget.executionAuthorized, false);
  assert.ok(emptyTarget.remainingChecks.includes('target_authorization'));
  assert.equal(JSON.stringify(emptyTarget).includes('https://untrusted'), false);
});
test('invalid target inventories and malformed source graphs cannot become plans', () => {
  const inventory = { targetTenantId: 'target', targetCreatorId: 'creator', existingWorkIds: [], existingAssetIds: [], existingCollectionIds: [] };
  for (const change of [{ targetCreatorId: '' }, { existingAssetIds: null }, { existingWorkIds: [12] }, { existingWorkIds: Array(100_001).fill('id') }]) {
    assert.throws(() => planCreatorContentImport(source(), { ...inventory, ...change }), /inventory/);
  }
  assert.throws(() => planCreatorContentImport('{}', inventory), /schema/);
});

test('related IDs require explicit inventory and report collisions without returning target data', () => {
  const manifest = JSON.parse(source());
  manifest.works[0].publications = [{ publicationId: 'receipt', workId: 'work-0' }];
  manifest.works[0].publicationIntents = [{ id: 'intent', workId: 'work-0' }];
  manifest.integrationAccounts = [{ externalAccountId: 'account', creatorId: 'source-creator' }];
  const json = JSON.stringify(manifest);
  const inventory = { targetTenantId: 'target', targetCreatorId: 'creator', existingWorkIds: [], existingAssetIds: [], existingCollectionIds: [],
    existingPublicationIds: ['receipt'], existingPublicationIntentIds: ['intent'], existingIntegrationAccountIds: ['account'] };
  for (const key of ['existingPublicationIds', 'existingPublicationIntentIds', 'existingIntegrationAccountIds']) {
    const incomplete = { ...inventory }; delete incomplete[key];
    assert.throws(() => planCreatorContentImport(json, incomplete), /collision inventory/);
  }
  const plan = planCreatorContentImport(json, inventory);
  assert.deepEqual(plan.conflicts, [{ resource: 'publication', id: 'receipt', reason: 'id_exists' },
    { resource: 'publicationIntent', id: 'intent', reason: 'id_exists' }, { resource: 'integrationAccount', id: 'account', reason: 'id_exists' }]);
  assert.equal(plan.executionAuthorized, false);
  assert.equal(JSON.stringify(plan).includes('https://untrusted'), false);
});
