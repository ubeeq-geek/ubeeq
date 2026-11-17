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

## Optional password sign-in

A host can configure `ReferenceAdapterSet.passwordAuthentication` independently
from `localIdentity`. Password sign-in does not imply local registration. The AWS
composition exposes this port only when `passwordAuthenticationEnabled` is true;
the reference Lambda reads `UBEEQ_PASSWORD_AUTH_ENABLED`. The generated single-cell
stack enables it with its public app client and `USER_PASSWORD_AUTH` flow, while
provider self-registration remains disabled. Existing external/OIDC compositions
retain their defaults.

`CognitoIdentity.authenticateSession` completes password authentication, verifies
the access JWT and live user, then requires a current active account. It returns
no token for incomplete challenges, unknown provider results or inactive accounts.
Credential failures return HTTP 401, a required confirmation/reset/challenge
returns 409, and unavailable provider evidence returns 503. Replies use no-store
and safe error text; provider diagnostics and opaque challenge sessions are not
serialized. Local password registration remains available only when its existing
adapter is configured.

This optional bridge supports a complete one-step password sign-in with a public
app client. Clients with secrets and full federated/MFA/recovery/registration
journeys must use their configured identity flow or a suitable host implementation;
the bridge does not manufacture completion of a challenge. See the official
[InitiateAuth API](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_InitiateAuth.html).

A real-provider HTTP rehearsal used this bridge with the commercial API: sign-in,
organization and creator setup, a queued job fenced after actual user disablement,
no reserved or consumed credits, preserved original input, reauthentication and provider
sign-out revocation. Its core/quota data used disposable local SQLite; it does not
certify deployed managed persistence or paid credit delivery.
