import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleCreatorContentExport, prepareCreatorContentRestore } from '../dist/index.js';
const manifest = () => assembleCreatorContentExport({ generatedAt: '2026-10-01T00:00:00Z', source: { product: 'Source', tenantId: 'source' },
  creator: { creatorId: 'creator' }, works: [], collections: [], integrationAccounts: [], sanitizeIntegrationAccount: value => value });
const target = { tenantId: 'target', creatorId: 'new-creator', restoreId: 'restore' };
test('restore fingerprints are deterministic and bind the manifest, target and original admission choices', () => {
  const input = manifest(), original = JSON.stringify(input), first = prepareCreatorContentRestore(original, target, { allowMissingOriginals: true });
  const reordered = Object.fromEntries(Object.entries(input).reverse());
  assert.equal(prepareCreatorContentRestore(JSON.stringify(reordered), target, { allowMissingOriginals: true }).fingerprint, first.fingerprint);
  assert.notEqual(prepareCreatorContentRestore(original, { ...target, creatorId: 'other' }, { allowMissingOriginals: true }).fingerprint, first.fingerprint);
  assert.notEqual(prepareCreatorContentRestore(original, target, { allowMissingOriginals: false }).fingerprint, first.fingerprint);
  assert.equal(JSON.stringify(input), original); assert.equal(first.parsed.manifest.integrationAccounts.length, 0);
});
test('malformed source graphs and unsafe target identities cannot become executable restore candidates', () => {
  assert.throws(() => prepareCreatorContentRestore('{}', target), /schema/);
  assert.throws(() => prepareCreatorContentRestore(JSON.stringify(manifest()), { ...target, restoreId: '../foreign' }), /target/);
  const input = manifest(); input.integrationAccounts.push({ id: 'account', accessToken: 'secret' });
  assert.throws(() => prepareCreatorContentRestore(JSON.stringify(input), target), /secret|credential/i);
});
