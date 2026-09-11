# Authoritative Cognito account lookup

`CognitoIdentity.getAccount(subjectId)` now calls `AdminGetUser` for the configured
user pool. It no longer fabricates an active account for an arbitrary ID. The
canonical subject remains Cognito `Username`, matching the existing session
adapter; this is not an identifier migration to `sub` or email aliases. A response
for a different username, missing state metadata or invalid SDK dates rejects.

Enabled CONFIRMED/EXTERNAL_PROVIDER accounts map to `active`; enabled UNCONFIRMED
accounts map to `pending_verification`. Disabled accounts and all other statuses
map conservatively to `suspended`, including password-reset/change requirements
and unknown future states. This is an application-admission mapping, not a claim
that Cognito deleted those users. Only UserNotFoundException returns no account;
throttling, permission, missing-pool and service errors propagate unchanged.

Each lookup is fresh. No enabled-state cache, private attributes, MFA details or
credentials are stored in the returned account. Provider creation/modification
dates are returned as ISO timestamps. This does not atomically bind admission to
a later application write or change verifySession's error/expiry behavior.

## AWS composition requirement

The consuming runtime needs `cognito-idp:AdminGetUser` scoped to its user-pool ARN.
Do not grant it to unrelated health-only functions. This change does not alter
IAM, deploy resources, call a live pool, or change any accounts. AWS notes that
AdminGetUser contributes to MAU accounting; see the authoritative
[API contract](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_AdminGetUser.html).
Runtime IAM, throttling/cost behavior and live account-state acceptance must be
qualified when wiring the hosted application.

Mocked adapter tests cover exact pool/subject commands, repeated disable/enable
checks, conservative status mapping, identity/date validation and error handling.
They do not prove deployed Cognito or full AWS adapter readiness. Queue discovery,
external-effect coordination and other migration blockers remain separate work.
