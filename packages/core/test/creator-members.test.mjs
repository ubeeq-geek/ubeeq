import test from 'node:test';
import assert from 'node:assert/strict';
import { CreatorMemberService } from '../dist/index.js';

test('member service authorizes every operation and preserves product roles', async () => {
  const member = { creatorId: 'creator', userId: 'user', role: 'custom-role', createdAt: 'now' };
  const rows = [member, { ...member, creatorId: 'foreign' }];
  const calls = [];
  let allowed = false;
  const store = { listCreatorMembers: async () => rows, addCreatorMember: async value => rows.push(value),
    removeCreatorMember: async (...args) => calls.push(args) };
  const service = new CreatorMemberService(store, async (creatorId, operation) => { calls.push([creatorId, operation]); return allowed; });
  await assert.rejects(service.list('creator'), { code: 'access_denied' });
  await assert.rejects(service.add('creator', member), { code: 'access_denied' });
  await assert.rejects(service.remove('creator', 'user'), { code: 'access_denied' });
  assert.equal(rows.length, 2);
  allowed = true;
  const listed = await service.list('creator');
  assert.equal(listed.length, 1); listed[0].role = 'changed';
  assert.equal(member.role, 'custom-role');
  await assert.rejects(service.add('creator', { ...member, creatorId: 'foreign' }), { code: 'invalid_member' });
  assert.equal((await service.add('creator', member)).role, 'custom-role');
  await service.remove('creator', 'user');
  assert.deepEqual(calls.at(-1), ['creator', 'user']);
});
