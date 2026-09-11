export type WorkDiscoveryState = 'none' | 'eligible' | 'opted_in' | 'removed';
export interface WorkDiscoveryParticipation {
  tenantId: string; creatorId: string; workId: string; state: WorkDiscoveryState;
  optedInAt?: string; withdrawnAt?: string; removedAt?: string; removalReason?: string; updatedAt: string;
}

/** Construct participation metadata after caller authorization/admission.
 * Does not publish, rank, persist, or establish eligibility for a Work.
 */
export function createWorkDiscoveryParticipation(input: {
  tenantId: string; creatorId: string; workId: string; state: WorkDiscoveryState; now: string; removalReason?: string;
}): WorkDiscoveryParticipation {
  if (![input.tenantId, input.creatorId, input.workId].every(value => typeof value === 'string' && Boolean(value.trim()))
    || !['none', 'eligible', 'opted_in', 'removed'].includes(input.state)
    || typeof input.now !== 'string' || !Number.isFinite(Date.parse(input.now))) throw new Error('Invalid discovery participation input.');
  return { tenantId: input.tenantId, creatorId: input.creatorId, workId: input.workId, state: input.state,
    optedInAt: input.state === 'opted_in' ? input.now : undefined,
    withdrawnAt: input.state === 'none' ? input.now : undefined,
    removedAt: input.state === 'removed' ? input.now : undefined,
    removalReason: input.state === 'removed' ? input.removalReason : undefined, updatedAt: input.now };
}
