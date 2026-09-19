import test from 'node:test';
import assert from 'node:assert/strict';
import { CreatorMemberService, prepareCreatorInvitationAcceptance, validateCreatorMemberMutation } from '../dist/index.js';

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

test('atomic member changes require authorized, checked and unique scope', async () => {
  const member = { creatorId: 'creator', userId: 'user', role: 'product-role', createdAt: 'now' };
  const committed = [];
  const service = new CreatorMemberService({ mutateCreatorMembers: async input => committed.push(input) }, async () => true);
  const mutation = { creatorId: 'creator', checks: [{ userId: 'user', expected: null }], changes: [{ userId: 'user', member }] };
  await service.mutate(mutation);
  member.role = 'mutated';
  assert.equal(committed[0].changes[0].member.role, 'product-role');
  await assert.rejects(service.mutate({ ...mutation, checks: [] }), { code: 'invalid_member' });
  await assert.rejects(service.mutate({ ...mutation, changes: [mutation.changes[0], mutation.changes[0]] }), { code: 'invalid_member' });
  await assert.rejects(service.mutate({ ...mutation, creatorId: 'foreign' }), { code: 'invalid_member' });
  await assert.rejects(new CreatorMemberService({}, async () => false).mutate(mutation), { code: 'access_denied' });
  await assert.rejects(new CreatorMemberService({}, async () => true).mutate(mutation), { code: 'atomic_membership_unavailable' });
  assert.equal(committed.length, 1);
});

const invitation = { creatorId: 'creator', invitationId: 'invite', email: 'recipient@example.test', role: 'custom-role',
  issuedByUserId: 'issuer', sponsorUserId: 'sponsor', tokenHash: 'hashed-token', createdAt: '2026-09-19T00:00:00Z',
  expiresAt: '2026-09-26T00:00:00Z', status: 'pending' };
const proof = { userId: 'recipient', email: ' Recipient@Example.test ', emailVerified: true, tokenHash: 'hashed-token' };
const now = Date.parse('2026-09-20T00:00:00Z');
const createMember = role => ({ creatorId: 'creator', userId: 'recipient', role, createdAt: new Date(now).toISOString() });
test('invitation acceptance prepares a detached conditional mutation and preserves an existing role', () => {
  const result = prepareCreatorInvitationAcceptance(invitation, proof, null, createMember, now);
  assert.deepEqual(result.checks, [{ userId: 'recipient', expected: null }]);
  assert.equal(result.changes[0].member.role, 'custom-role');
  assert.equal(result.invitation.next.acceptedByUserId, 'recipient');
  assert.equal(result.invitation.next.status, 'accepted');
  result.invitation.expected.email = 'changed';
  assert.equal(invitation.email, 'recipient@example.test');
  const existing = createMember('lower-product-role');
  const retained = prepareCreatorInvitationAcceptance(invitation, proof, existing, () => { throw new Error('Must preserve existing membership'); }, now);
  assert.equal(retained.changes[0].member.role, existing.role);
  retained.changes[0].member.role = 'changed';
  assert.equal(existing.role, 'lower-product-role');
});
test('invitation acceptance rejects invalid recipient proof, expiry, replay and foreign membership', () => {
  for (const change of [{ emailVerified: false }, { email: 'other@example.test' }, { tokenHash: 'wrong' }, { userId: '' }]) {
    assert.throws(() => prepareCreatorInvitationAcceptance(invitation, { ...proof, ...change }, null, createMember, now), { code: 'access_denied' });
  }
  for (const change of [{ status: 'accepted' }, { status: 'revoked' }, { expiresAt: new Date(now).toISOString() }, { expiresAt: 'invalid' }]) {
    assert.throws(() => prepareCreatorInvitationAcceptance({ ...invitation, ...change }, proof, null, createMember, now), { code: 'access_denied' });
  }
  assert.throws(() => prepareCreatorInvitationAcceptance(invitation, proof, null, createMember, NaN), { code: 'access_denied' });
  for (const change of [{ creatorId: 'foreign' }, { userId: 'foreign' }, { role: 'elevated' }]) {
    assert.throws(() => prepareCreatorInvitationAcceptance(invitation, proof, null, role => ({ ...createMember(role), ...change }), now), { code: 'invalid_member' });
  }
});
test('invitation transitions retain immutable fields and require acceptance attribution', () => {
  const mutation = prepareCreatorInvitationAcceptance(invitation, proof, null, createMember, now);
  for (const change of [{ email: 'other' }, { role: 'other' }, { createdAt: 'changed' }, { tokenHash: 'changed' }, { sponsorUserId: 'other' }, { acceptedByUserId: '' }, { acceptedAt: 'invalid' }, { status: 'pending' }]) {
    assert.throws(() => validateCreatorMemberMutation({ ...mutation, invitation: { ...mutation.invitation, next: { ...mutation.invitation.next, ...change } } }), { code: 'invalid_member' });
  }
});
