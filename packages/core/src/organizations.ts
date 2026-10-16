/** Product-neutral organization and workspace ownership contracts. */
export const ORGANIZATION_ROLES = ["owner", "administrator", "member", "billing_manager"] as const;
export type OrganizationRole = typeof ORGANIZATION_ROLES[number];
export const WORKSPACE_GRANT_ROLES = ["manager", "publisher", "editor", "viewer"] as const;
export type WorkspaceGrantRole = typeof WORKSPACE_GRANT_ROLES[number];
export type OrganizationState = "active" | "suspended" | "closing" | "closed";
export type MembershipStatus = "active" | "suspended" | "ended";

export interface Organization {
  id: string;
  displayName: string;
  slug?: string;
  state: OrganizationState;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface OrganizationMembership {
  id: string;
  organizationId: string;
  userId: string;
  role: OrganizationRole;
  status: MembershipStatus;
  revision: number;
  joinedAt: string;
  endedAt?: string;
}

/** Exactly one owner field must be populated. */
export interface WorkspaceOwnership {
  workspaceId: string;
  personalOwnerUserId?: string;
  ownerOrganizationId?: string;
  revision: number;
}

export interface WorkspaceGrant {
  id: string;
  workspaceId: string;
  membershipId: string;
  role: WorkspaceGrantRole;
  revision: number;
}

export interface OrganizationInvitation {
  id: string;
  organizationId: string;
  normalizedRecipientAddress: string;
  proposedRole: Exclude<OrganizationRole, "owner">;
  proposedWorkspaceGrants: readonly { workspaceId: string; role: WorkspaceGrantRole }[];
  inviterMembershipId: string;
  tokenHash: string;
  expiresAt: string;
  state: "pending" | "accepted" | "revoked" | "expired";
  revision: number;
}

export type WorkspaceCapability =
  | "read" | "edit" | "download_original" | "publish" | "manage_connections"
  | "manage_schedules" | "export" | "delete_content" | "assign_workspace_roles";

const WORKSPACE_CAPABILITIES: Readonly<Record<WorkspaceGrantRole, readonly WorkspaceCapability[]>> = {
  manager: ["read", "edit", "download_original", "publish", "manage_connections", "manage_schedules", "export", "delete_content", "assign_workspace_roles"],
  publisher: ["read", "edit", "download_original", "publish"],
  editor: ["read", "edit", "download_original"],
  viewer: ["read"]
};

export class OrganizationDomainError extends Error {
  constructor(readonly code: "permission_denied" | "scope_mismatch" | "invitation_expired" | "last_owner_required" | "revision_conflict" | "transfer_blocked", message: string) {
    super(message);
    this.name = "OrganizationDomainError";
  }
}

/** Creates the organization and first owner values for one adapter transaction. */
export const prepareOrganizationCreation = (input: {
  organizationId: string;
  membershipId: string;
  creatorUserId: string;
  displayName: string;
  slug?: string;
  now: string;
}): { organization: Organization; ownerMembership: OrganizationMembership } => {
  const displayName = input.displayName.trim();
  if (!input.organizationId || !input.membershipId || !input.creatorUserId || !displayName || !Number.isFinite(Date.parse(input.now))) {
    throw new OrganizationDomainError("scope_mismatch", "Organization creation requires stable identifiers, a display name and timestamp.");
  }
  return {
    organization: { id: input.organizationId, displayName, slug: input.slug, state: "active", revision: 1, createdAt: input.now, updatedAt: input.now },
    ownerMembership: { id: input.membershipId, organizationId: input.organizationId, userId: input.creatorUserId, role: "owner", status: "active", revision: 1, joinedAt: input.now }
  };
};

const identifier = (value: unknown): value is string => typeof value === "string" && Boolean(value.trim());
const revision = (value: number): boolean => Number.isSafeInteger(value) && value >= 1;
const validMembership = (m: OrganizationMembership): boolean =>
  [m.id, m.organizationId, m.userId].every(identifier) && revision(m.revision)
  && ORGANIZATION_ROLES.includes(m.role) && ["active", "suspended", "ended"].includes(m.status);
const active = (membership: OrganizationMembership | undefined): membership is OrganizationMembership =>
  Boolean(membership && validMembership(membership) && membership.status === "active");
const validGrant = (grant: WorkspaceGrant): boolean =>
  [grant.id, grant.workspaceId, grant.membershipId].every(identifier) && revision(grant.revision) && WORKSPACE_GRANT_ROLES.includes(grant.role);

export const validateWorkspaceOwnership = (ownership: WorkspaceOwnership): WorkspaceOwnership => {
  if (!identifier(ownership.workspaceId) || !revision(ownership.revision)
    || (ownership.personalOwnerUserId !== undefined && !identifier(ownership.personalOwnerUserId))
    || (ownership.ownerOrganizationId !== undefined && !identifier(ownership.ownerOrganizationId))
    || Boolean(ownership.personalOwnerUserId) === Boolean(ownership.ownerOrganizationId)) {
    throw new OrganizationDomainError("scope_mismatch", "A workspace must have exactly one valid administrative owner.");
  }
  return ownership;
};

/** Resolves authority from server-loaded ownership, membership and grants. */
export const hasWorkspaceCapability = (input: {
  actorUserId: string;
  ownership: WorkspaceOwnership;
  organization?: Organization;
  membership?: OrganizationMembership;
  grant?: WorkspaceGrant;
  capability: WorkspaceCapability;
}): boolean => {
  const { actorUserId, ownership, organization, membership, grant, capability } = input;
  validateWorkspaceOwnership(ownership);
  if (!identifier(actorUserId) || !WORKSPACE_CAPABILITIES.manager.includes(capability)) return false;
  if (ownership.personalOwnerUserId === actorUserId) return true;
  if (!ownership.ownerOrganizationId || organization?.id !== ownership.ownerOrganizationId || organization.state !== "active"
    || !active(membership) || membership.userId !== actorUserId
    || membership.organizationId !== ownership.ownerOrganizationId) return false;
  if (membership.role === "owner" || membership.role === "administrator") return true;
  if (membership.role !== "member" || !grant || !validGrant(grant) || grant.workspaceId !== ownership.workspaceId
    || grant.membershipId !== membership.id) return false;
  return WORKSPACE_CAPABILITIES[grant.role].includes(capability);
};

export const requireWorkspaceCapability = (input: Parameters<typeof hasWorkspaceCapability>[0]): void => {
  if (!hasWorkspaceCapability(input)) throw new OrganizationDomainError("permission_denied", `Workspace capability '${input.capability}' is required.`);
};

/** Validates references before a grant is persisted; callers must load these records authoritatively. */
export const validateWorkspaceGrant = (
  grant: WorkspaceGrant,
  ownership: WorkspaceOwnership,
  membership: OrganizationMembership
): WorkspaceGrant => {
  validateWorkspaceOwnership(ownership);
  if (!validGrant(grant) || !active(membership) || ownership.workspaceId !== grant.workspaceId || !ownership.ownerOrganizationId
    || membership.organizationId !== ownership.ownerOrganizationId || membership.id !== grant.membershipId
    || membership.role !== "member") {
    throw new OrganizationDomainError("scope_mismatch", "Workspace grants require an active ordinary membership in the owning organization.");
  }
  return grant;
};

/** Acceptance proposal for an adapter transaction/CAS; no plaintext token is retained. */
export const prepareInvitationAcceptance = (input: {
  invitation: OrganizationInvitation;
  organization: Organization;
  inviter: OrganizationMembership;
  recipient: { userId: string; normalizedVerifiedAddress: string; tokenHash: string };
  existingMembership?: OrganizationMembership;
  workspaceOwnership: readonly WorkspaceOwnership[];
  now: string;
  newMembershipId: string;
}): { membership: OrganizationMembership; grants: WorkspaceGrant[]; invitation: OrganizationInvitation } => {
  const { invitation, organization, inviter, recipient, existingMembership, workspaceOwnership } = input;
  const timestamp = Date.parse(input.now);
  if (!Number.isFinite(timestamp) || invitation.state !== "pending" || !Number.isFinite(Date.parse(invitation.expiresAt)) || Date.parse(invitation.expiresAt) <= timestamp) {
    throw new OrganizationDomainError("invitation_expired", "The invitation is expired or no longer pending.");
  }
  if (![invitation.id, invitation.organizationId, invitation.inviterMembershipId, invitation.tokenHash, invitation.normalizedRecipientAddress, recipient.userId, recipient.tokenHash, input.newMembershipId].every(identifier)
    || !revision(invitation.revision) || !revision(organization.revision)
    || !["administrator", "member", "billing_manager"].includes(invitation.proposedRole)
    || organization.state !== "active" || invitation.organizationId !== organization.id || !active(inviter)
    || inviter.id !== invitation.inviterMembershipId || inviter.organizationId !== organization.id
    || !["owner", "administrator"].includes(inviter.role) || recipient.normalizedVerifiedAddress !== invitation.normalizedRecipientAddress
    || recipient.tokenHash !== invitation.tokenHash
    || (inviter.role === "administrator" && !["member", "billing_manager"].includes(invitation.proposedRole))) {
    throw new OrganizationDomainError("permission_denied", "Invitation authority or recipient proof is no longer valid.");
  }
  if (existingMembership && (existingMembership.organizationId !== organization.id || existingMembership.userId !== recipient.userId
    || !validMembership(existingMembership) || existingMembership.status !== "ended")) {
    throw new OrganizationDomainError("scope_mismatch", "Invitation membership conflicts with current organization state.");
  }
  const membership: OrganizationMembership = {
    id: existingMembership?.id ?? input.newMembershipId, organizationId: organization.id, userId: recipient.userId,
    role: invitation.proposedRole, status: "active", revision: (existingMembership?.revision ?? 0) + 1,
    joinedAt: input.now
  };
  const owners = new Map(workspaceOwnership.map(owner => [owner.workspaceId, owner]));
  if (new Set(invitation.proposedWorkspaceGrants.map(({ workspaceId }) => workspaceId)).size !== invitation.proposedWorkspaceGrants.length) {
    throw new OrganizationDomainError("scope_mismatch", "An invitation cannot contain duplicate workspace grants.");
  }
  const grants = invitation.proposedWorkspaceGrants.map((proposed, index) => {
    const grant: WorkspaceGrant = { id: `${invitation.id}:${index}`, workspaceId: proposed.workspaceId, membershipId: membership.id, role: proposed.role, revision: 1 };
    return validateWorkspaceGrant(grant, owners.get(proposed.workspaceId) ?? { workspaceId: proposed.workspaceId, revision: 0 }, membership);
  });
  return { membership, grants, invitation: { ...invitation, state: "accepted", revision: invitation.revision + 1 } };
};

/** Must be applied with a transaction-level lock/CAS over every active owner membership. */
export const validateMembershipChange = (input: {
  actor: OrganizationMembership;
  current: OrganizationMembership;
  next: OrganizationMembership;
  activeOwnerCount: number;
}): void => {
  const { actor, current, next, activeOwnerCount } = input;
  if (!active(actor) || actor.organizationId !== current.organizationId || current.id !== next.id
    || current.organizationId !== next.organizationId || current.userId !== next.userId) throw new OrganizationDomainError("scope_mismatch", "Membership change is outside its organization scope.");
  if (!validMembership(current) || !validMembership(next) || !Number.isSafeInteger(activeOwnerCount) || activeOwnerCount < 1) throw new OrganizationDomainError("scope_mismatch", "Invalid membership or owner count.");
  if (!["owner", "administrator"].includes(actor.role)) throw new OrganizationDomainError("permission_denied", "Organization administration is required.");
  if (next.revision !== current.revision + 1) throw new OrganizationDomainError("revision_conflict", "Membership revision is stale.");
  const changesPrivilegedRole = current.role !== next.role && ([current.role, next.role].some(role => role === "owner" || role === "administrator"));
  if (actor.role !== "owner" && (changesPrivilegedRole || current.role !== "member" && current.role !== "billing_manager")) {
    throw new OrganizationDomainError("permission_denied", "Only owners may change owners or administrators.");
  }
  if (current.role === "owner" && current.status === "active" && (next.role !== "owner" || next.status !== "active") && activeOwnerCount <= 1) {
    throw new OrganizationDomainError("last_owner_required", "At least one active organization owner is required.");
  }
};

export interface OwnershipTransferPlan {
  id: string;
  workspaceId: string;
  workspaceRevision: number;
  personalOwnerUserId: string;
  receivingOrganizationId: string;
  receivingOrganizationRevision: number;
  initiatedByUserId: string;
  acceptedByOwnerMembershipId: string;
  postTransferRole: WorkspaceGrantRole;
  state: "planned" | "accepted" | "committed" | "blocked";
}

export const validateOwnershipTransferCommit = (input: {
  plan: OwnershipTransferPlan;
  ownership: WorkspaceOwnership;
  organization: Organization;
  acceptingMembership: OrganizationMembership;
  recentAuthentication: boolean;
  dependenciesReady: boolean;
}): void => {
  const { plan, ownership, organization, acceptingMembership } = input;
  validateWorkspaceOwnership(ownership);
  if (!identifier(plan.id) || !identifier(plan.personalOwnerUserId) || !WORKSPACE_GRANT_ROLES.includes(plan.postTransferRole) || plan.state !== "accepted" || !input.recentAuthentication || !input.dependenciesReady || organization.state !== "active") {
    throw new OrganizationDomainError("transfer_blocked", "Transfer is not accepted or its dependencies are not ready.");
  }
  if (ownership.workspaceId !== plan.workspaceId || ownership.revision !== plan.workspaceRevision
    || ownership.personalOwnerUserId !== plan.personalOwnerUserId || plan.initiatedByUserId !== plan.personalOwnerUserId
    || organization.id !== plan.receivingOrganizationId || organization.revision !== plan.receivingOrganizationRevision
    || !active(acceptingMembership) || acceptingMembership.id !== plan.acceptedByOwnerMembershipId
    || acceptingMembership.organizationId !== organization.id || acceptingMembership.role !== "owner") {
    throw new OrganizationDomainError("revision_conflict", "Transfer authorities or revisions no longer match the accepted plan.");
  }
};
