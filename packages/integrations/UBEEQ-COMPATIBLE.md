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

Hosts expose `/.well-known/ubeeq`, the account/space-specific capability check,
paginated inventory, staged or draft publication writes, conditional revision
updates, and durable idempotency lookup. Authorization must be enforced again
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
