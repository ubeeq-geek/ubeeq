import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hasWorkspaceCapability, prepareInvitationAcceptance, prepareOrganizationCreation, requireWorkspaceCapability,
  validateMembershipChange, validateOwnershipTransferCommit, validateWorkspaceGrant,
  validateWorkspaceOwnership
} from '../dist/index.js';

const personal = { workspaceId: 'personal-workspace', personalOwnerUserId: 'artist', revision: 1 };
const owned = { workspaceId: 'studio-workspace', ownerOrganizationId: 'studio', revision: 4 };
const member = { id: 'membership', organizationId: 'studio', userId: 'assistant', role: 'member', status: 'active', revision: 1, joinedAt: '2026-10-15T00:00:00Z' };
const grant = { id: 'grant', workspaceId: 'studio-workspace', membershipId: 'membership', role: 'editor', revision: 1 };

test('organization creation prepares an atomic active organization and first owner', () => {
  const created = prepareOrganizationCreation({ organizationId: 'studio', membershipId: 'owner-membership', creatorUserId: 'owner', displayName: ' Studio ', now: '2026-10-16T00:00:00Z' });
  assert.equal(created.organization.displayName, 'Studio');
  assert.equal(created.organization.state, 'active');
  assert.equal(created.ownerMembership.role, 'owner');
  assert.throws(() => prepareOrganizationCreation({ organizationId: 'studio', membershipId: 'owner-membership', creatorUserId: 'owner', displayName: ' ', now: '2026-10-16T00:00:00Z' }), { code: 'scope_mismatch' });
});

test('workspace ownership requires exactly one owner', () => {
  assert.equal(validateWorkspaceOwnership(personal), personal);
  assert.equal(validateWorkspaceOwnership(owned), owned);
  assert.throws(() => validateWorkspaceOwnership({ workspaceId: 'bad', revision: 1 }), { code: 'scope_mismatch' });
  assert.throws(() => validateWorkspaceOwnership({ ...personal, ownerOrganizationId: 'studio' }), { code: 'scope_mismatch' });
});

test('personal owners and organization administrators inherit manager authority', () => {
  assert.equal(hasWorkspaceCapability({ actorUserId: 'artist', ownership: personal, capability: 'export' }), true);
  const administrator = { ...member, role: 'administrator' };
  assert.equal(hasWorkspaceCapability({ actorUserId: 'assistant', ownership: owned, organization, membership: administrator, capability: 'manage_connections' }), true);
  assert.equal(hasWorkspaceCapability({ actorUserId: 'stranger', ownership: personal, capability: 'read' }), false);
});

test('ordinary grants enforce the workspace capability matrix without cross-scope access', () => {
  assert.equal(validateWorkspaceGrant(grant, owned, member), grant);
  assert.equal(hasWorkspaceCapability({ actorUserId: 'assistant', ownership: owned, organization, membership: member, grant, capability: 'edit' }), true);
  assert.equal(hasWorkspaceCapability({ actorUserId: 'assistant', ownership: owned, organization, membership: member, grant, capability: 'publish' }), false);
  assert.throws(() => requireWorkspaceCapability({ actorUserId: 'assistant', ownership: owned, organization, membership: member, grant, capability: 'export' }), { code: 'permission_denied' });
  assert.throws(() => validateWorkspaceGrant({ ...grant, workspaceId: 'other' }, owned, member), { code: 'scope_mismatch' });
  assert.throws(() => validateWorkspaceGrant(grant, owned, { ...member, organizationId: 'other' }), { code: 'scope_mismatch' });
  assert.equal(hasWorkspaceCapability({ actorUserId: 'assistant', ownership: owned, organization, membership: { ...member, role: 'billing_manager' }, grant, capability: 'read' }), false);
});

const organization = { id: 'studio', displayName: 'Studio', state: 'active', revision: 2, createdAt: '2026-10-15T00:00:00Z', updatedAt: '2026-10-15T00:00:00Z' };
const owner = { id: 'owner-membership', organizationId: 'studio', userId: 'owner', role: 'owner', status: 'active', revision: 1, joinedAt: '2026-10-15T00:00:00Z' };
const invitation = { id: 'invitation', organizationId: 'studio', normalizedRecipientAddress: 'assistant@example.test', proposedRole: 'member', proposedWorkspaceGrants: [{ workspaceId: 'studio-workspace', role: 'editor' }], inviterMembershipId: owner.id, tokenHash: 'hashed', expiresAt: '2026-10-20T00:00:00Z', state: 'pending', revision: 1 };
const acceptance = { invitation, organization, inviter: owner, recipient: { userId: 'assistant', normalizedVerifiedAddress: 'assistant@example.test', tokenHash: 'hashed' }, workspaceOwnership: [owned], now: '2026-10-16T00:00:00Z', newMembershipId: 'membership' };

test('invitation acceptance rechecks authority, verified recipient, expiry, and grant ownership', () => {
  const result = prepareInvitationAcceptance(acceptance);
  assert.equal(result.membership.role, 'member');
  assert.equal(result.grants[0].role, 'editor');
  assert.equal(result.invitation.state, 'accepted');
  assert.throws(() => prepareInvitationAcceptance({ ...acceptance, recipient: { ...acceptance.recipient, tokenHash: 'wrong' } }), { code: 'permission_denied' });
  assert.throws(() => prepareInvitationAcceptance({ ...acceptance, now: invitation.expiresAt }), { code: 'invitation_expired' });
  assert.throws(() => prepareInvitationAcceptance({ ...acceptance, inviter: { ...owner, status: 'ended' } }), { code: 'permission_denied' });
  assert.throws(() => prepareInvitationAcceptance({ ...acceptance, inviter: { ...owner, role: 'administrator' }, invitation: { ...invitation, proposedRole: 'administrator' } }), { code: 'permission_denied' });
  assert.throws(() => prepareInvitationAcceptance({ ...acceptance, workspaceOwnership: [{ ...owned, ownerOrganizationId: 'other' }] }), { code: 'scope_mismatch' });
  assert.throws(() => prepareInvitationAcceptance({ ...acceptance, invitation: { ...invitation, proposedWorkspaceGrants: [invitation.proposedWorkspaceGrants[0], invitation.proposedWorkspaceGrants[0]] } }), { code: 'scope_mismatch' });
});

test('membership changes enforce revisions, role ceilings, and last-owner continuity', () => {
  const nextOwner = { ...owner, role: 'member', revision: 2 };
  assert.throws(() => validateMembershipChange({ actor: owner, current: owner, next: nextOwner, activeOwnerCount: 1 }), { code: 'last_owner_required' });
  assert.doesNotThrow(() => validateMembershipChange({ actor: owner, current: owner, next: nextOwner, activeOwnerCount: 2 }));
  assert.throws(() => validateMembershipChange({ actor: { ...owner, role: 'administrator' }, current: member, next: { ...member, role: 'administrator', revision: 2 }, activeOwnerCount: 2 }), { code: 'permission_denied' });
  assert.throws(() => validateMembershipChange({ actor: owner, current: member, next: { ...member, revision: 1 }, activeOwnerCount: 2 }), { code: 'revision_conflict' });
});

test('ownership transfer commit requires accepted current authorities and dependency readiness', () => {
  const plan = { id: 'transfer', workspaceId: personal.workspaceId, workspaceRevision: 1, personalOwnerUserId: 'artist', receivingOrganizationId: 'studio', receivingOrganizationRevision: 2, initiatedByUserId: 'artist', acceptedByOwnerMembershipId: owner.id, postTransferRole: 'manager', state: 'accepted' };
  const input = { plan, ownership: personal, organization, acceptingMembership: owner, recentAuthentication: true, dependenciesReady: true };
  assert.doesNotThrow(() => validateOwnershipTransferCommit(input));
  assert.throws(() => validateOwnershipTransferCommit({ ...input, dependenciesReady: false }), { code: 'transfer_blocked' });
  assert.throws(() => validateOwnershipTransferCommit({ ...input, ownership: { ...personal, revision: 2 } }), { code: 'revision_conflict' });
  assert.throws(() => validateOwnershipTransferCommit({ ...input, acceptingMembership: { ...owner, role: 'administrator' } }), { code: 'revision_conflict' });
});

test('ordinary members and billing managers cannot mutate memberships', () => {
  for (const role of ['member', 'billing_manager']) {
    assert.throws(() => validateMembershipChange({ actor: { ...member, role }, current: member,
      next: { ...member, status: 'ended', revision: 2 }, activeOwnerCount: 1 }), { code: 'permission_denied' });
  }
});

test('workspace access requires active organization state and valid records', () => {
  const input = { actorUserId: member.userId, ownership: owned, organization, membership: member, grant, capability: 'read' };
  assert.equal(hasWorkspaceCapability({ ...input, organization: undefined }), false);
  assert.equal(hasWorkspaceCapability({ ...input, organization: { ...organization, state: 'suspended' } }), false);
  for (const role of ['constructor', '__proto__', 'owner']) {
    assert.equal(hasWorkspaceCapability({ ...input, grant: { ...grant, role } }), false);
    assert.throws(() => validateWorkspaceGrant({ ...grant, role }, owned, member), { code: 'scope_mismatch' });
  }
  assert.equal(hasWorkspaceCapability({ ...input, membership: { ...member, revision: 0 } }), false);
  assert.throws(() => validateWorkspaceOwnership({ workspaceId: ' ', personalOwnerUserId: 'artist', revision: 1 }), { code: 'scope_mismatch' });
});

test('invitations fail closed on corrupt expiry, owner elevation and suspended membership', () => {
  assert.throws(() => prepareInvitationAcceptance({ ...acceptance, invitation: { ...invitation, expiresAt: 'invalid' } }), { code: 'invitation_expired' });
  assert.throws(() => prepareInvitationAcceptance({ ...acceptance, invitation: { ...invitation, proposedRole: 'owner' } }), { code: 'permission_denied' });
  assert.throws(() => prepareInvitationAcceptance({ ...acceptance, existingMembership: { ...member, status: 'suspended' } }), { code: 'scope_mismatch' });
  assert.throws(() => prepareInvitationAcceptance({ ...acceptance, invitation: { ...invitation, proposedWorkspaceGrants: [{ workspaceId: owned.workspaceId, role: 'constructor' }] } }), { code: 'scope_mismatch' });
});

test('transfer cannot reinterpret existing organization ownership as personal ownership', () => {
  const plan = { id: 'transfer', workspaceId: owned.workspaceId, workspaceRevision: owned.revision,
    receivingOrganizationId: organization.id, receivingOrganizationRevision: organization.revision,
    initiatedByUserId: undefined, acceptedByOwnerMembershipId: owner.id, postTransferRole: 'manager', state: 'accepted' };
  assert.throws(() => validateOwnershipTransferCommit({ plan, ownership: owned, organization,
    acceptingMembership: owner, recentAuthentication: true, dependenciesReady: true }), { code: 'transfer_blocked' });
});
