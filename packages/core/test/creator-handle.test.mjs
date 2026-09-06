import test from 'node:test';
import assert from 'node:assert/strict';
import { CreatorHandleService, CreatorProfileError, normalizeContentSlug } from '../dist/index.js';

test('handle service authorizes scoped revisioned edits and delegates atomic reservation', async () => {
  const stored = { id: 'creator', instanceId: 'tenant', revision: 3, handle: 'original', subjectId: 'owner' };
  const calls = [];
  let allowed = true;
  const service = new CreatorHandleService({ get: async () => stored, commitHandle: async (...args) => { calls.push(args); return { ...stored, handle: args[2], revision: 4 }; } },
    async value => { value.subjectId = 'changed-in-policy'; return allowed; }, input => normalizeContentSlug(input, { fallback: 'untitled' }));
  const result = await service.rename('tenant', 'creator', 3, ' New / Name ');
  assert.deepEqual(calls, [['creator', 3, 'new-name']]);
  assert.equal(result.subjectId, 'owner');
  assert.equal(stored.handle, 'original');
  for (const input of ['', ' ', null, 42, 'a'.repeat(301)]) await assert.rejects(service.rename('tenant', 'creator', 3, input), CreatorProfileError);
  await assert.rejects(service.rename('other', 'creator', 3, 'name'), error => error.code === 'not_found');
  await assert.rejects(service.rename('tenant', 'wrong-id', 3, 'name'), error => error.code === 'not_found');
  await assert.rejects(service.rename('tenant', 'creator', 2, 'name'), error => error.code === 'revision_conflict');
  allowed = false;
  await assert.rejects(service.rename('tenant', 'creator', 3, 'name'), error => error.code === 'access_denied');
  assert.equal(calls.length, 1);
});
