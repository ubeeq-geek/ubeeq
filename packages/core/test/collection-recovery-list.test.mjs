import test from 'node:test';
import assert from 'node:assert/strict';
import { CreatorCollectionService } from '../dist/index.js';

test('collection recovery listings are explicit and scoped before membership reads', async () => {
  const scope = { tenantId: 'tenant', creatorId: 'creator' };
  const rows = [
    { ...scope, collectionId: 'removed', status: 'deleted' },
    { ...scope, collectionId: 'active', status: 'draft' },
    { ...scope, creatorId: 'other', collectionId: 'foreign', status: 'deleted' },
    { ...scope, tenantId: 'other', collectionId: 'other-tenant', status: 'deleted' }
  ];
  const membershipReads = []; let lists = 0;
  const store = { listCreatorCollections: async () => { lists++; return rows; },
    listCollectionWorks: async (_tenant, id) => { membershipReads.push(id); return [{ workId: 'retained' }]; } };
  const service = new CreatorCollectionService(store, async () => true);
  assert.deepEqual((await service.list(scope)).map(c => c.collectionId), ['active']);
  membershipReads.length = 0;
  const recovered = await service.list(scope, { includeDeleted: true });
  assert.deepEqual(recovered.map(c => c.collectionId), ['removed', 'active']);
  assert.deepEqual(recovered[0].workIds, ['retained']);
  assert.deepEqual(membershipReads, ['removed', 'active']);
  const before = lists;
  await assert.rejects(new CreatorCollectionService(store, async () => false).list(scope, { includeDeleted: true }), { code: 'access_denied' });
  assert.equal(lists, before);
});
