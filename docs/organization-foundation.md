# Organization foundation

This document records the repository mapping for the first product-neutral
organization foundation. It deliberately defines core contracts rather than an
hosted-product-specific policy or user interface.

## Existing model mapping

| Specification concept | Repository mapping |
| --- | --- |
| User | The provider-neutral authenticated subject in `@ubeeq/auth`; identity adapters remain responsible for accounts and recent authentication. |
| Organization and membership | `Organization` and `OrganizationMembership` in `@ubeeq/core`. An organization is not an authentication principal. |
| Workspace | `WorkspaceOwnership` is the new administrative boundary. `instanceId` remains the host/deployment namespace and is not redefined as a workspace. |
| Creator identity | The existing `Creator` remains the public identity. Organization roles never derive from its name, slug, or presentation. |
| Existing creator collaborators | `CreatorMemberService` remains a compatibility contract. New team ownership must use organization membership plus workspace grants; creator credits and legacy collaborators must not be migrated into organization membership implicitly. |
| Space | No administrative `Space` aggregate exists in core, so no presentation destination is repurposed as a tenant. |

## Integrity and adapter requirements

The core module supplies validated values and authorization decisions, while a
durable adapter must enforce the following in its own transaction and schema:

1. A workspace has exactly one personal or organization owner. Use an exclusive
   database constraint rather than relying only on application validation.
2. Organization creation writes the organization and first active Owner
   membership atomically.
3. A current membership is unique by organization and user. Workspace grants (`WorkspaceGrantRole` / `WORKSPACE_GRANT_ROLES`, distinct from
   the professional-publishing compatibility `WorkspaceRole`)
   reference active ordinary memberships in the workspace's owning organization.
4. Invitation acceptance compares the invitation, inviter authority,
   organization state, finite expiry, recipient's verified normalized address, and every
   workspace owner before atomically writing the membership, grants, and consumed
   invitation revision. Store only a cryptographic token hash.
5. Membership changes use compare-and-swap revisions and lock the active owner
   set. `validateMembershipChange` is not, by itself, a concurrency lock.
6. All private resource lookup starts from a server-resolved workspace. Cache
   keys, search documents, object delivery, exports, jobs, and connections must
   carry that workspace; absent or ambiguous legacy ownership fails closed.
7. A worker re-resolves current ownership, active membership, grant revision, and
   required capability immediately before a mutation. Revocation is authoritative
   state, while events perform only cleanup and notification.

## Authorization decisions

Personal owners have full workspace authority. Active organization Owners and
Administrators inherit workspace-manager capabilities. Active ordinary Members
receive only their explicit `WorkspaceGrant`. Billing managers receive no content
capability. The exported `hasWorkspaceCapability` and
`requireWorkspaceCapability` functions implement this matrix from records loaded
by the server, including the current active Organization for organization-owned workspaces; client-provided organization or workspace identifiers are never
evidence of access.

Organization Administrators may manage ordinary Members and billing managers,
but only Owners may change Owner or Administrator roles. Owner promotion requires
a separate explicit acceptance flow at the application boundary. Adapters must
serialize owner removal/demotion so concurrent changes cannot remove the last
active Owner.

## Transfer boundary

`OwnershipTransferPlan` captures the personal workspace owner, receiving
organization, accepting Owner membership, workspace and organization revisions,
and selected post-transfer role. `validateOwnershipTransferCommit` checks the
accepted plan and current authorities. The eventual adapter transaction must
change the owner, create/activate the accepted membership and grant, bump
authorization revisions, write an outbox/audit event, and pause mutating jobs.
Connections and remote grants are not transferred by that database change.

Only personal-to-organization transfer on one host is represented. Other transfer
directions must return `feature_unavailable` at the API boundary.

## Rollout

This schema is additive. Existing personal creator behavior remains valid and no
organization is inferred from email domains, creator names, credits, or provider
administrators. Deployment feature flags may disable creation and transfer, but
must never bypass ownership authorization for existing records. Other downstream products must
leave organization activation disabled until its separate rollout is approved.

Before a persistence or API implementation enables onboarding, it must add and
exercise adapter-level isolation, invitation transaction, concurrent last-owner,
offboarding/handover, job-dispatch race, export/import, and resumable migration
tests. The pure core tests cover the shared role matrix, scope checks, revisions,
invitation proposal, and transfer preconditions; they do not replace those
integration tests.

Suspended memberships cannot be reactivated by accepting a fresh invitation.
Ordinary Members and billing managers cannot administer any membership, including
their own. Invitations cannot promote Owners; applications must implement the
separate explicit Owner acceptance flow before exposing that operation.
