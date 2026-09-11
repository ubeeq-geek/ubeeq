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
test('explicit ordering is unique within each parent while sparse positions remain intact', () => {
  const value = fixture('id');
  const asset = structuredClone(value.works[0].assets[0]);
  asset.assetId = 'second-asset'; asset.attachment.assetId = asset.assetId;
  value.works[0].assets.push(asset);
  assert.throws(() => parseCreatorContentExport(JSON.stringify(value)), /Duplicate asset attachment position/);
  asset.attachment.position = 7;
  const second = { work: { ...value.works[0].work, workId: 'second-work', primaryAssetId: undefined }, assets: [] };
  value.works.push(second);
  value.collections[0].works.push({ collectionId: 'collection', workId: 'second-work', position: 2 });
  assert.throws(() => parseCreatorContentExport(JSON.stringify(value)), /Duplicate collection membership position/);
  value.collections[0].works[1].position = 9;
  const parsed = parseCreatorContentExport(JSON.stringify(value));
  assert.deepEqual(parsed.manifest.works[0].assets.map(item => item.attachment.position), [0, 7]);
  assert.deepEqual(parsed.manifest.collections[0].works.map(item => item.position), [2, 9]);
  // Other parents may reuse positions; only sibling ordering must be unique.
  value.collections.push({ collection: { ...value.collections[0].collection, collectionId: 'other' },
    works: [{ collectionId: 'other', workId: 'second-work', position: 2 }] });
  assert.ok(parseCreatorContentExport(JSON.stringify(value)));
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

test('related identities preserve local and canonical shapes but reject duplicate or ambiguous restore targets', () => {
  for (const accountKey of ['id', 'integrationAccountId', 'externalAccountId']) {
    const value = fixture('id');
    value.integrationAccounts = [{ [accountKey]: 'account', creatorId: 'creator' }];
    value.works[0].publications = [{ publicationId: 'publication', workId: 'work' }];
    value.works[0].publicationIntents = [{ publicationIntentId: 'intent', workId: 'work' }];
    assert.deepEqual(parseCreatorContentExport(JSON.stringify(value)).manifest, value);
  }
  for (const change of [
    x => { x.works[0].publications[0].id = ''; },
    x => { delete x.works[0].publications[0].id; },
    x => { x.works[0].publications[0].publicationId = 'different'; },
    x => { x.works[0].publications.push({ ...x.works[0].publications[0] }); },
    x => { x.works[0].publicationIntents = [{ id: 'intent', workId: 'work' }, { publicationIntentId: 'intent', workId: 'work' }]; },
    x => { const second = structuredClone(x.works[0]); second.work.workId = 'other'; second.assets[0].attachment.workId = 'other'; second.publications[0].workId = 'other'; x.works.push(second); },
    x => { x.integrationAccounts.push({ externalAccountId: 'account', creatorId: 'creator' }); },
    x => { x.integrationAccounts[0].externalAccountId = 'different'; },
    x => { delete x.integrationAccounts[0].id; }
  ]) {
    const value = fixture('id'); change(value);
    assert.throws(() => parseCreatorContentExport(JSON.stringify(value)), /identity/);
  }
});
