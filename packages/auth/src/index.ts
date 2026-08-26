/** An authenticated principal expressed without identity-provider assumptions. */
export interface AuthorizationSubject {
  id: string;
  roles: readonly string[];
  scopes?: readonly string[];
}

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
