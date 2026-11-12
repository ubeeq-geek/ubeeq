# Cognito account status in managed hosts

The AWS identity adapter resolves account status through `AdminGetUser` against
the configured pool and exact existing username. It does not synthesize active
accounts or cache an earlier active result. Username-based identity keys remain
unchanged; changing pools or converting identities to `sub` requires a separate
migration.

Confirmed or external-provider users must be enabled to resolve as active.
Unconfirmed, password-reset and forced-password-change accounts remain pending;
disabled/compromised accounts are suspended, and archived accounts are closed.
Missing users return no account. Unknown, malformed or unavailable provider
evidence fails closed. Provider timestamps are preserved when present.

The API and durable-worker roles need `cognito-idp:AdminGetUser` on their
configured user-pool ARN. The single-cell deployment grants this read only to
those two roles; the synthesized-policy test verifies both the action and ARN
scope. Hosts with separately managed IAM must supply the equivalent scoped
permission before adopting the adapter. No broader user-administration grant is
required by account lookup.

Session verification still validates JWT signature, issuer, client, token use
and expiry before its live `GetUser` request. A valid old reservation or a
previously active account record is not current worker authorization. Hosted
registration, MFA/recovery challenges and privileged-group management remain
separate integration concerns.

The adapter suite tests current disablement, missing accounts, status mapping,
unknown evidence and provider denials. An isolated live-provider rehearsal also
observed temporary-password, confirmed, disabled and deleted states through the
same adapter, with messages suppressed and its newly created fixtures removed.
This does not certify a complete managed browser/registration journey.

See the official [AdminGetUser API](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_AdminGetUser.html)
for provider status fields and IAM requirements.
