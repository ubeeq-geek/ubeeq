import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryCreatorContentStore, CreatorContentListBudgetError } from '../dist/index.js';
for (const [field, method] of [['works', 'listWorksByCreator'], ['creatorCollections', 'listCreatorCollections']]) {
  test(`${method} rejects oversized inventories without truncating or mutating them`, async () => {
    const store = new MemoryCreatorContentStore();
    store[field] = Array.from({ length: 3 }, (_, index) => ({ tenantId: 'tenant', creatorId: 'creator', status: index === 2 ? 'deleted' : 'draft', updatedAt: `${index}`, title: `${index}` }));
    const before = structuredClone(store[field]);
    await assert.rejects(store[method]('tenant', 'creator', { maxRecords: 2 }), CreatorContentListBudgetError);
    assert.equal((await store[method]('tenant', 'creator', { maxRecords: 3 })).length, 2);
    assert.equal((await store[method]('tenant', 'creator', { maxRecords: 3, includeDeleted: true })).length, 3);
    assert.deepEqual(await store[method]('tenant', 'other', { maxRecords: 1 }), []);
    await assert.rejects(store[method]('tenant', 'creator', { maxRecords: 0 }), /Invalid/);
    assert.deepEqual(store[field], before);
  });
}
