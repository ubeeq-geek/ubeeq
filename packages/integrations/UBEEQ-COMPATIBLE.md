# Ubeeq-compatible connector contract

`@ubeeq/integrations` provides one protocol foundation for the generic
Ubeeq-compatible entry and product-owned service presets. A preset changes
catalog presentation and selects a verified official endpoint;
it does not bypass discovery, authorization, or account/space capability checks.

The initial contract includes discovery and major-version negotiation, safe
endpoint validation, target-scoped identity, capability intersection,
publication mappings, idempotent transfer recovery, normalized errors, and safe
publication activation. Credentials remain opaque vault references on the
connection record.

## Identity invariants

Remote identities are always scoped by instance, account, and space. Active
mapping uniqueness is based on local publication plus target, never canonical
work plus target. Consequently several independently managed publications of
one work may coexist in a destination account, while one remote publication
cannot accidentally belong to two active mappings.

## Host responsibilities

Hosts expose `/.well-known/ubeeq` and the account/space-specific capability check.
They implement paginated inventory, staged or draft publication writes,
conditional revision updates, and durable idempotency lookup only for the
capabilities they actually advertise. Authorization must be enforced again
for every operation. Products own endpoint DNS/redirect enforcement, vault
storage, policy and quota decisions, persistence, and user-facing conflict or
partial-result workflows.

Discovery metadata is untrusted. Managed deployments must perform DNS checks
for every connection and redirect, reject private and link-local addresses,
require HTTPS, and never forward a token to a changed origin or audience. The
library validation is a required common guard, not a replacement for the
product's redirect-safe HTTP transport.

Ongoing synchronization, commerce/entitlement transfer, and migration cutover
remain explicitly out of the initial contract. Copying a publication does not
copy purchases, subscriptions, comments, favorites, or account identity.

## Discovery trust and replay rules

Validation accepts unknown JSON and returns only validated fields and known
capabilities. The canonical origin must match the requested origin. API and
authorization endpoints on other origins require an independently supplied
`trustedEndpointOrigins` allowlist; metadata cannot approve itself. Production
requires HTTPS. Reject special-use literal IPs and every non-public resolved
address, including IPv4-mapped IPv6. The caller must resolve and pin the actual
connection addresses, repeat validation on redirects, and bound response bytes
before JSON parsing. Omitting `resolvedAddresses` performs metadata validation
only, not DNS validation. Non-HTTPS/private development connections require
explicit nonproduction policy.

Idempotency scope includes connection, direction, instance, account, space, and
operation. A remote draft/result ID is a checkpoint, not completion: only a
`completed` job returns an existing final result. Other states must resume or
reconcile under the product's durable worker policy, never blindly create again.

## Read-only host profile (v1)

Validation normalizes `apiBaseUrl` with a trailing slash and rejects queries.
Resolve the exported relative path constants with `new URL(path, apiBaseUrl)`;
this preserves deployment API path prefixes. The base is used for `GET /capabilities?remoteSpaceId=...` and
`GET /inventory?remoteSpaceId=...&limit=...&cursor=...`. The capability response
is `UbeeqTargetCapabilities`; inventory is `UbeeqInventoryPage`. IDs are opaque
and always accompanied by instance/account/space. The account is derived from
authentication, never a caller-selected impersonation parameter. Inventory
returns Work metadata only, with opaque string revisions and continuation
cursors. It conveys no download URL, original entitlement, remote publication
identity, or write authority. Empty pages may still have a continuation cursor.
Concurrent edits can move records between pages; this is a live inventory, not
an export snapshot or a deletion reconciliation signal.

`inventory.read` is advertised only when this profile is implemented. All
account/space authorization and policy checks run for every request, including
continuations. Authenticated responses must use `Cache-Control: no-store`.
An authorization endpoint alone does not imply dynamic client registration,
delegated OAuth grants, or token exchange: clients must support the host's
explicit authentication profile before requesting or sending credentials.
Staging, publication writes, original downloads, and job transport remain
separately negotiated future profiles; their types and guards do not advertise
an implemented endpoint.
