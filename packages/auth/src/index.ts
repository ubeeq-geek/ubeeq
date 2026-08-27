/** An authenticated principal expressed without identity-provider assumptions. */
export interface AuthorizationSubject {
  id: string;
  roles: readonly string[];
  scopes?: readonly string[];
}

export interface IdentityAccount {
  id: string;
  subjectId: string;
  status: "active" | "pending_verification" | "suspended" | "closed";
  createdAt: string;
  updatedAt: string;
}

export interface AuthenticatedSession {
  id: string;
  subject: AuthorizationSubject;
  issuedAt: string;
  expiresAt: string;
  authenticationMethod: "password" | "passwordless" | "oidc" | "service" | "other";
}

export interface CreatorDelegation {
  id: string;
  creatorId: string;
  subjectId: string;
  roles: readonly string[];
  scopes: readonly string[];
  expiresAt?: string;
}

/** Provider-neutral boundary for local, OIDC, and future cloud identity adapters. */
export interface IdentityAdapter {
  verifySession(input: { credential: string; audience?: string }): Promise<AuthenticatedSession | undefined>;
  getAccount(subjectId: string): Promise<IdentityAccount | undefined>;
  listDelegations(input: { creatorId: string; subjectId: string; at: string }): Promise<readonly CreatorDelegation[]>;
  beginVerification?(input: { accountId: string; channel: string }): Promise<void>;
  completeVerification?(input: { accountId: string; proof: string }): Promise<void>;
  beginRecovery?(input: { accountId: string; channel: string }): Promise<void>;
  completeRecovery?(input: { accountId: string; proof: string; replacementSecret?: string }): Promise<void>;
  revokeSession(input: { sessionId: string; reason?: string }): Promise<void>;
}

export const effectiveAuthorizationSubject = (
  session: AuthenticatedSession,
  delegations: readonly CreatorDelegation[],
  creatorId: string,
  at: string
): AuthorizationSubject => {
  const active = delegations.filter((delegation) => delegation.creatorId === creatorId
    && delegation.subjectId === session.subject.id
    && (!delegation.expiresAt || delegation.expiresAt > at));
  return {
    id: session.subject.id,
    roles: [...new Set([...session.subject.roles, ...active.flatMap(({ roles }) => roles)])],
    scopes: [...new Set([...(session.subject.scopes ?? []), ...active.flatMap(({ scopes }) => scopes)])]
  };
};

/** A product-defined requirement evaluated by the neutral authorization helpers. */
export interface AuthorizationRequirement {
  allRoles?: readonly string[];
  anyRoles?: readonly string[];
  allScopes?: readonly string[];
  anyScopes?: readonly string[];
}

export class AuthorizationDeniedError extends Error {
  readonly requirement: AuthorizationRequirement;

  constructor(requirement: AuthorizationRequirement) {
    super("The authenticated subject does not satisfy the authorization requirement.");
    this.name = "AuthorizationDeniedError";
    this.requirement = requirement;
  }
}

const hasAll = (granted: readonly string[], required: readonly string[] | undefined): boolean =>
  !required?.length || required.every((value) => granted.includes(value));

const hasAny = (granted: readonly string[], required: readonly string[] | undefined): boolean =>
  !required?.length || required.some((value) => granted.includes(value));

/** Evaluates product-supplied role and scope requirements without defining a role hierarchy. */
export const isAuthorized = (
  subject: AuthorizationSubject,
  requirement: AuthorizationRequirement
): boolean =>
  hasAll(subject.roles, requirement.allRoles)
  && hasAny(subject.roles, requirement.anyRoles)
  && hasAll(subject.scopes ?? [], requirement.allScopes)
  && hasAny(subject.scopes ?? [], requirement.anyScopes);

/** Throws a typed error so transport adapters can map denial to their own response model. */
export const requireAuthorization = (
  subject: AuthorizationSubject,
  requirement: AuthorizationRequirement
): void => {
  if (!isAuthorized(subject, requirement)) throw new AuthorizationDeniedError(requirement);
};
