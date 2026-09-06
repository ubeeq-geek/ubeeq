import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleCreatorContentExport } from '../dist/index.js';

test('content export retains product records, filters omitted memberships and sanitizes accounts', () => {
  const input = { generatedAt: 'now', source: { product: 'private product', tenantId: 'tenant' },
    creator: { creatorId: 'creator', custom: { preserved: true } },
    works: [{ work: { workId: 'allowed', body: [{ id: 'section', data: { nested: [1] } }] }, assets: [], publications: [{ id: 'publication' }], discovery: { custom: true } }],
    collections: [{ collection: { collectionId: 'collection' }, works: [{ workId: 'omitted', position: 0 }, { workId: 'allowed', position: 1 }] }],
    integrationAccounts: [{ id: 'account', token: 'secret', custom: { value: 1 } }],
    sanitizeIntegrationAccount: account => { account.custom.value = 2; return { id: account.id }; }
  };
  const exported = assembleCreatorContentExport(input);
  assert.equal(exported.schemaVersion, 1);
  assert.deepEqual(exported.works, input.works);
  assert.deepEqual(exported.collections[0].works, [{ workId: 'allowed', position: 1 }]);
  assert.deepEqual(exported.integrationAccounts, [{ id: 'account' }]);
  assert.equal(JSON.stringify(exported).includes('secret'), false);
  assert.equal(input.integrationAccounts[0].custom.value, 1);
  exported.works[0].work.body[0].data.nested.push(2);
  assert.deepEqual(input.works[0].work.body[0].data.nested, [1]);
  assert.throws(() => assembleCreatorContentExport({ ...input, works: [input.works[0], input.works[0]] }), /unique/);
});
