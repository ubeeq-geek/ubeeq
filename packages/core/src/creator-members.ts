export interface CreatorMemberRecord { creatorId: string; userId: string; role: string; createdAt: string; invitedByUserId?: string }
export interface CreatorMemberPort<M extends CreatorMemberRecord> {
  mutateCreatorMembers?(mutation: CreatorMemberMutation<M>): Promise<void>;
  listCreatorMembers(creatorId: string): Promise<M[]>;
  addCreatorMember(member: M): Promise<void>;
  removeCreatorMember(creatorId: string, userId: string): Promise<void>;
}
export class CreatorMemberError extends Error {
  constructor(readonly code: 'access_denied' | 'invalid_member' | 'membership_conflict' | 'atomic_membership_unavailable', message: string) { super(message); this.name = 'CreatorMemberError'; }
}
/** Membership storage mechanisms; products retain role hierarchy and actor policy.
 * Bind the port to one tenant/instance. This compatibility port does not provide
 * invitations, atomic last-owner protection, or account existence checks.
 */
export class CreatorMemberService<M extends CreatorMemberRecord> {
  constructor(private readonly store: CreatorMemberPort<M>, private readonly authorize: (creatorId: string, operation: 'read' | 'write') => Promise<boolean>) {}
  private async access(creatorId: string, operation: 'read' | 'write') {
    if (!creatorId || !await this.authorize(creatorId, operation)) throw new CreatorMemberError('access_denied', 'Creator membership access denied.');
  }
  async list(creatorId: string): Promise<M[]> {
    await this.access(creatorId, 'read');
    return (await this.store.listCreatorMembers(creatorId)).filter(member => member.creatorId === creatorId).map(member => structuredClone(member));
  }
  async add(creatorId: string, member: M): Promise<M> {
    await this.access(creatorId, 'write');
    if (member.creatorId !== creatorId || !member.userId.trim() || !member.role || !member.createdAt) throw new CreatorMemberError('invalid_member', 'Invalid creator membership.');
    const copy = structuredClone(member);
    await this.store.addCreatorMember(copy);
    return structuredClone(copy);
  }
  async mutate(input: CreatorMemberMutation<M>): Promise<void> {
    await this.access(input.creatorId, 'write');
    validateCreatorMemberMutation(input);
    if (!this.store.mutateCreatorMembers) throw new CreatorMemberError('atomic_membership_unavailable', 'Atomic membership storage is unavailable.');
    await this.store.mutateCreatorMembers(structuredClone(input));
  }
  async remove(creatorId: string, userId: string): Promise<void> {
    await this.access(creatorId, 'write');
    if (!userId.trim()) throw new CreatorMemberError('invalid_member', 'Member user ID is required.');
    await this.store.removeCreatorMember(creatorId, userId);
  }
}

/** A transaction checks every observed record, including authorization guards,
 * before applying any change. Null means that a membership must not exist.
 * Implementations must fail with membership_conflict and make no writes when
 * any observation is stale. The port is scoped to one tenant/instance. */
export interface CreatorMemberMutation<M extends CreatorMemberRecord> {
  creatorId: string;
  checks: Array<{ userId: string; expected: M | null }>;
  changes: Array<{ userId: string; member: M | null }>;
  invitation?: { expected: CreatorInvitation | null; next: CreatorInvitation };
}

export function validateCreatorMemberMutation<M extends CreatorMemberRecord>(input: CreatorMemberMutation<M>): void {
  const ids = new Set(input.checks.map(check => check.userId));
  if (!input.creatorId || (!input.changes.length && !input.invitation) || input.checks.length > 20
    || ids.size !== input.checks.length || new Set(input.changes.map(change => change.userId)).size !== input.changes.length) {
    throw new CreatorMemberError('invalid_member', 'Invalid membership transaction.');
  }
  if (input.invitation) {
    const { expected, next } = input.invitation;
    if (next.creatorId !== input.creatorId || !next.invitationId || !next.email || !next.tokenHash || !next.role
      || !next.issuedByUserId || !next.sponsorUserId || !Number.isFinite(Date.parse(next.expiresAt))
      || (!expected && next.status !== 'pending')
      || (expected && (expected.creatorId !== next.creatorId || expected.invitationId !== next.invitationId
        || expected.status !== 'pending' || !['accepted', 'revoked'].includes(next.status)
        || expected.email !== next.email || expected.role !== next.role || expected.tokenHash !== next.tokenHash
        || expected.sponsorUserId !== next.sponsorUserId || expected.issuedByUserId !== next.issuedByUserId
        || expected.expiresAt !== next.expiresAt || expected.createdAt !== next.createdAt))
      || (next.status === 'accepted' ? (!next.acceptedByUserId || !next.acceptedAt || !Number.isFinite(Date.parse(next.acceptedAt)))
        : (next.acceptedByUserId !== undefined || next.acceptedAt !== undefined))) {
      throw new CreatorMemberError('invalid_member', 'Invalid invitation transition.');
    }
  }
  for (const entry of [...input.checks.map(check => ({ userId: check.userId, member: check.expected })), ...input.changes]) {
    if (!entry.userId.trim() || !ids.has(entry.userId) || (entry.member &&
      (entry.member.creatorId !== input.creatorId || entry.member.userId !== entry.userId || !entry.member.role || !entry.member.createdAt))) {
      throw new CreatorMemberError('invalid_member', 'Membership transaction is outside its checked scope.');
    }
  }
}

export interface CreatorInvitation {
  creatorId: string;
  invitationId: string;
  email: string;
  role: string;
  issuedByUserId: string;
  sponsorUserId: string;
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
  status: 'pending' | 'accepted' | 'revoked';
  acceptedByUserId?: string;
  acceptedAt?: string;
}
export interface CreatorInvitationPort {
  getCreatorInvitation(creatorId: string, invitationId: string): Promise<CreatorInvitation | null>;
  listCreatorInvitations(creatorId: string): Promise<CreatorInvitation[]>;
}
/** Product policy admits the Creator and sponsor; storage atomically checks the
 * invitation and membership observations. Existing membership is never upgraded
 * by redeeming an old invitation. No token plaintext is persisted here. */
export function prepareCreatorInvitationAcceptance<M extends CreatorMemberRecord>(
  invitation: CreatorInvitation, proof: { userId: string; email: string; emailVerified: boolean; tokenHash: string },
  existing: M | null, createMember: (role: string) => M, now: number
): CreatorMemberMutation<M> {
  if (!Number.isFinite(now) || invitation.status !== 'pending' || !Number.isFinite(Date.parse(invitation.expiresAt))
    || Date.parse(invitation.expiresAt) <= now || !proof.userId || !proof.emailVerified
    || proof.email.trim().toLowerCase() !== invitation.email || proof.tokenHash !== invitation.tokenHash) {
    throw new CreatorMemberError('access_denied', 'Invitation cannot be accepted. Verify the recipient account, link and expiry.');
  }
  const member = existing || createMember(invitation.role);
  if (member.userId !== proof.userId || member.creatorId !== invitation.creatorId || (!existing && member.role !== invitation.role)) throw new CreatorMemberError('invalid_member', 'Invitation membership scope is invalid.');
  const result: CreatorMemberMutation<M> = { creatorId: invitation.creatorId,
    checks: [{ userId: proof.userId, expected: existing }], changes: [{ userId: proof.userId, member }],
    invitation: { expected: invitation, next: { ...invitation, status: 'accepted', acceptedByUserId: proof.userId, acceptedAt: new Date(now).toISOString() } } };
  validateCreatorMemberMutation(result);
  return structuredClone(result);
}
