import test from 'node:test';
import assert from 'node:assert/strict';
import { CreatorSourceFileService } from '../dist/index.js';
const file = { fileId: 'file', creatorId: 'creator', sourceKind: 'document', mimeType: 'application/pdf', storageKey: 'private/key', createdAt: 'now', updatedAt: 'now', sizeBytes: 1, custom: { value: 'retained' } };
test('source catalogue filters by creator authority and isolates returned records', async () => {
  const records = [file, { ...file, fileId: 'two' }, { ...file, creatorId: 'foreign' }], calls = [];
  const service = new CreatorSourceFileService({ listAllSourceFiles: async () => records }, async (id, op) => { calls.push([id, op]); return id === 'creator'; });
  const result = await service.list(); assert.equal(result.length, 2);
  assert.deepEqual(calls, [['creator', 'read'], ['foreign', 'read']]);
  result[0].custom.value = 'changed'; assert.equal(file.custom.value, 'retained');
});
test('creation snapshots admitted metadata and preserves product fields without exposing store mutations', async () => {
  const input = structuredClone(file); let saved;
  const service = new CreatorSourceFileService({ createSourceFile: async value => { saved = structuredClone(value); value.custom.value = 'adapter change'; } },
    async () => { input.creatorId = 'foreign'; input.custom.value = 'late change'; return true; });
  const created = await service.create('creator', input);
  assert.deepEqual(created, file); assert.deepEqual(saved, file);
});
test('denied, foreign and malformed creates never write; store errors propagate', async () => {
  let writes = 0, allowed = false;
  const store = { createSourceFile: async () => { writes++; } };
  const service = new CreatorSourceFileService(store, async () => allowed);
  await assert.rejects(service.create('creator', file), { code: 'access_denied' }); allowed = true;
  for (const change of [{ creatorId: 'foreign' }, { fileId: '' }, { storageKey: ' ' }, { sizeBytes: -1 }, { sizeBytes: NaN }])
    await assert.rejects(service.create('creator', { ...file, ...change }), { code: 'invalid_file' });
  assert.equal(writes, 0);
  const failure = new Error('duplicate'); store.createSourceFile = async () => { throw failure; };
  await assert.rejects(service.create('creator', file), error => error === failure);
});
