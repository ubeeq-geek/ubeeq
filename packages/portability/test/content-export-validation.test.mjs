import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleCreatorContentExport, parseCreatorContentExport } from '../dist/index.js';

const fixture = identityField => {
  const scope = { creatorId: 'creator', tenantId: 'tenant' };
  const asset = { ...scope, assetId: 'asset', storage: { externalUrl: 'https://untrusted.invalid/original' } };
  return { ...assembleCreatorContentExport({ generatedAt: '2026-01-01T00:00:00Z', source: { product: 'product', tenantId: 'tenant' },
    creator: { [identityField]: 'creator' }, works: [{ work: { ...scope, workId: 'work', primaryAssetId: 'asset', custom: { preserved: true } },
      assets: [{ ...asset, attachment: { assetId: 'asset', workId: 'work', position: 0 } }], publications: [{ id: 'publication', workId: 'work' }] }],
    collections: [{ collection: { ...scope, collectionId: 'collection', coverAssetId: 'detached' }, works: [{ collectionId: 'collection', workId: 'work', position: 2 }] }],
    integrationAccounts: [{ id: 'account', creatorId: 'creator', hasAccessToken: false }], sanitizeIntegrationAccount: value => value }),
    retainedAssets: [{ ...asset, assetId: 'detached' }] };
};
test('both creator identity shapes preserve product fields, sparse ordering and retained references', () => {
  for (const field of ['id', 'creatorId']) {
    const input = fixture(field), original = JSON.stringify(input);
    const parsed = parseCreatorContentExport(original);
    assert.deepEqual(parsed.manifest, input);
    assert.deepEqual(parsed.counts, { works: 1, assets: 2, retainedAssets: 1, collections: 1 });
    parsed.manifest.works[0].work.custom.preserved = false;
    assert.equal(JSON.stringify(input), original);
  }
});
test('foreign identities, duplicate records, broken references and integration secrets reject', () => {
  for (const mutate of [
    x => { x.creator.creatorId = 'foreign'; },
    x => { x.works[0].work.tenantId = 'foreign'; },
    x => { x.works[0].assets[0].creatorId = 'foreign'; },
    x => x.works.push(structuredClone(x.works[0])),
    x => { x.works[0].assets[0].attachment.workId = 'foreign'; },
    x => { x.works[0].work.primaryAssetId = 'missing'; },
    x => { x.works[0].publications[0].workId = 'foreign'; },
    x => { x.collections[0].works[0].workId = 'missing'; },
    x => { x.collections[0].collection.coverAssetId = 'missing'; },
    x => x.retainedAssets.push(structuredClone(x.retainedAssets[0])),
    x => { x.retainedAssets[0].assetId = 'asset'; },
    x => { x.integrationAccounts[0].creatorId = 'foreign'; },
    x => { x.integrationAccounts[0].nested = { refreshToken: 'secret' }; },
    x => { const second = structuredClone(x.works[0]); second.work.workId = 'other'; second.assets[0].attachment.workId = 'other'; second.assets[0].storage.externalUrl = 'different'; x.works.push(second); }
  ]) {
    const value = fixture('id'); mutate(value);
    assert.throws(() => parseCreatorContentExport(JSON.stringify(value)));
  }
});
test('byte, node and depth budgets reject before a restore plan can be trusted', () => {
  const json = JSON.stringify(fixture('id'));
  assert.throws(() => parseCreatorContentExport(json, { maxBytes: 10 }), /byte budget/);
  assert.throws(() => parseCreatorContentExport(json, { maxNodes: 10 }), /structure budget/);
  assert.throws(() => parseCreatorContentExport(json, { maxDepth: 2 }), /structure budget/);
  assert.throws(() => parseCreatorContentExport(json, { maxDepth: 0 }), /parsing budget/);
  assert.throws(() => parseCreatorContentExport('{"__proto__":{"polluted":true}}'), /Unsafe/);
  assert.equal({}.polluted, undefined);
  assert.throws(() => parseCreatorContentExport('{"number":1e400}'), /Non-finite/);
  assert.throws(() => parseCreatorContentExport('{broken'));
});
