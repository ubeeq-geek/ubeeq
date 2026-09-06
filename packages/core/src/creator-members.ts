export interface CreatorMemberRecord { creatorId: string; userId: string; role: string; createdAt: string; invitedByUserId?: string }
export interface CreatorMemberPort<M extends CreatorMemberRecord> {
  listCreatorMembers(creatorId: string): Promise<M[]>;
  addCreatorMember(member: M): Promise<void>;
  removeCreatorMember(creatorId: string, userId: string): Promise<void>;
}
export class CreatorMemberError extends Error {
  constructor(readonly code: 'access_denied' | 'invalid_member', message: string) { super(message); this.name = 'CreatorMemberError'; }
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
  async remove(creatorId: string, userId: string): Promise<void> {
    await this.access(creatorId, 'write');
    if (!userId.trim()) throw new CreatorMemberError('invalid_member', 'Member user ID is required.');
    await this.store.removeCreatorMember(creatorId, userId);
  }
}
