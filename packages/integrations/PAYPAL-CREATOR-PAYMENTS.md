# Creator payments and protected access

Implements the version 1 creator-payments specification as a product-neutral
commerce domain, provider clients, a durable local adapter, and an optional
reference API/UI runtime. Platform usage/credit billing remains separate.

## Components

| Component | Responsibility |
| --- | --- |
| `packages/commerce` | Immutable offer snapshots, exact money, customer identities, orders, payments/refunds, purchases, entitlements, claims, access authorization, delivery/reconciliation jobs |
| `packages/integrations/src/paypal-*.ts` | OAuth client credentials, automatic webhook lifecycle, signature verification, Orders v2 checkout/capture, independent capture/order/refund/dispute retrieval |
| `packages/integrations/src/discord-commerce.ts` | Customer/creator OAuth, server management checks, existing-role discovery, bot permissions/hierarchy, membership and role operations |
| `adapters/local/src/commerce.ts` | SQLite transactions, database uniqueness, encrypted raw event payloads, durable inbox/outbox, lifecycle leases with fencing, revisioned connection records and audits |
| `apps/reference-api/src/commerce.ts` | Scoped routes, configured origins, body/rate limits, encrypted credential custody, private asset storage and package generation, worker composition |
| `apps/reference-api/src/commerce-page.ts` | Responsive creator setup, offer publication, customer sign-in/recovery, purchase status/history, downloads and Discord setup |

The reference API serves `/commerce`, `/commerce/creator`,
`/commerce/purchases`, `/commerce/checkout/{id}`, and
`/buy/{creator_id}/{offer_slug}`. The web reference forwards these routes and the
commerce API to its configured backend. Private galleries reuse the existing
website gallery renderer, responsive viewer, navigation, and viewer CSS.

## Connection and payment behavior

A deployment/creator/environment may have multiple named connections, with one
active binding per client app. Add uses `createNew`; updates, rename and disconnect
select an explicit connection ID. Offers bind that ID, and checkout never falls
back to another seller. Existing offers and purchases retain their original
connection. Legacy calls can omit a selector only while the choice is unambiguous.
Credentials go
only to an encrypted vault. Persisted opaque IDs select callbacks; they do not
authenticate notifications. Exact managed callback URLs are reused after retries
and unknown registration outcomes. Subscription repairs and disconnect affect
only those managed URLs. Configured means registration succeeded; Verified
requires a reconciled payment. Same-app rotation retains the callback.

Replacing a selected app requires an explicit `migrationUntil` deadline (up to 90 days).
The old connection, credentials and callback remain available for outstanding
orders and events; new offers use the new active connection. At the deadline,
cleanup waits if unconfirmed orders remain and records an actionable audit/state.
Normal disconnect also refuses unconfirmed orders. Cleanup failures retain
references and visible retry status. Worker ticks retry retired-secret cleanup
and sweep old unreferenced commerce vault entries without touching other
integrations.

An application order snapshots the customer, offer version, exact payable total
and local reference. The server creates the provider order with a stable request
ID, retrieves it, and pins its receiving merchant before exposing approval.
Capture requires an approved provider order. Retries first retrieve the order so
an already-completed capture is not repeated. An unknown create result outside
the conservative provider idempotency window enters review instead of creating
another approval session.

Verified events are durably committed with a processing job before 2xx. The
worker retrieves current provider resources and checks capture identity, payee,
order membership, reference, currency, amount and supported fixed-price shape.
Webhook-declared amounts and buyer text never establish access. Capture and
webhook paths converge on the same transaction that writes payment state,
purchase, source-specific entitlements, audit and outbox jobs.

Payment IDs include deployment, creator, merchant, environment and capture ID,
independent of connection rotation. Full refunds/reversals are terminal for the
source purchase. Delayed completion cannot restore its grants. Cumulative refund
IDs deduplicate; partial refunds retain access and carry an explicit review
reason. Independent purchases and manual grants survive. Approval, pending,
declined and dispute-opening states do not create grants.

External PayPal links remain manual until an actual verified notification and
independently retrieved transaction prove the merchant, buyer email and stable
single-item SKU mapping. Price alone never identifies an offer. Quantity changes,
adjustments, tax/shipping/discounts, split captures and uncorrelated formats are
rejected or held for review. Each actual link format still needs a real merchant
notification test before activation.

## Customers and private content

Customers are deployment scoped and carry no creator authority. Passwordless
email sign-in uses 15-minute single-use links and hashed expiring sessions.
Existing application sessions can verify a separate recovery email. Ambiguous
email recovery does not merge accounts. A customer magic-link session cannot
manage a creator even when it recovers the same subject's purchases.

External purchases start unclaimed. Claim links use only stored token hashes,
expire after 24 hours, require sign-in plus control of the independently verified
purchase email, and bind once. Signed-in customers can request recovery links
for purchases matching their verified emails; creators can resend with an audit.
Rate limits apply to sign-in, proof redemption, checkout, claims and retries.

Included file IDs and access periods are snapshotted on entitlements. Offers
are edited by publishing new versions; hiding an offer does not revoke purchased
access. Manual grants have their own source and reason. Erasing a customer profile
revokes access/sessions, removes unnecessary email/OAuth data and queues managed
role cleanup while preserving financial records under the configured policy.

Commerce uploads bypass the general public-publication pipeline. Originals and
paid preview assets stay private. Public previews require explicit approval,
a separate derivative with a different checksum, and a supported image type.
The reference upload form is bounded at 5 MiB per file; larger uploads need the
host's direct-upload composition. Storage limits include immutable archives and
use a shared creator lock across uploads/package writes.

Authorized file URLs expire after five minutes. The backend verifies their
signature, deployment and customer entitlement on every retrieval, including
revocations after issuance. All protected responses use `private, no-store`.
Unavailable/deleted/policy-held content fails closed. ZIP packages are built once
per immutable offer version by the worker; cached archives cannot bypass source
policy removal or deleted originals. A preparing package is visible before its
bytes are ready.

## Discord and operations

Creators install a bot requesting Manage Roles (not Administrator), authorize
server discovery, select a server they manage and choose existing assignable
roles. Setup tokens remain in the vault for a short, expiring setup session.
The invite must resolve to the configured server. Customers authorize `identify`
only; automatic server joining is not requested.

Delivery uses stable OAuth user IDs. Missing membership shows an invite and a
retryable pending state. Permissions, hierarchy and rate-limit errors are visible
and retried independently of gallery access. Persisted management intent supports
recovery after an unknown role-add outcome. Reconciliation unions active payment
and manual grants, preserves roles predating management, handles reconnects and
expiry, and removes only unsupported managed roles. Conflicts are audited and
queue creator notices.

Worker ticks persist unfinished work, lease jobs, fence stale completion writes,
and use bounded exponential backoff plus provider cooldowns. Pending orders are
reconciled in 15-minute windows; recent completed payments are checked in daily
windows. Older transactions remain available for targeted rechecks and verified
events. Creator history exposes layers, failures, migration audits and audited
Recheck payment, Retry Discord and Resend claim actions. HTTP errors carry
correlation IDs and sanitized codes. Operational failures produce scoped audit
alerts and deduplicated creator notices.

Raw verified webhook payloads are encrypted in the local database and expire
after 30 days. Event ID tombstones remain to prevent replay. Operational audits
expire after 365 days. Financial records are never silently deleted by a worker;
a jurisdiction-specific retention policy is required before enabling the runtime.

## Enable the local/reference runtime

Payments are disabled unless explicitly configured. Use a public HTTPS backend
and separate sandbox/live applications. Set:

| Variable | Purpose |
| --- | --- |
| `UBEEQ_COMMERCE_ENABLED=1` | Explicit runtime activation |
| `UBEEQ_CREDENTIAL_ENCRYPTION_KEY` | At least 32 characters, persistent encrypted vault key |
| `UBEEQ_COMMERCE_TOKEN_KEY` | At least 32 characters, persistent signing/token key |
| `UBEEQ_PAYPAL_ENVIRONMENTS` | Comma-separated eligible environments; defaults to sandbox |
| `UBEEQ_COMMERCE_PUBLIC_BASE_URL` | Public HTTPS backend base; defaults to the configured API public URL |
| `UBEEQ_COMMERCE_ELIGIBLE_CREATORS` | Optional explicit creator allowlist |
| `UBEEQ_COMMERCE_ALLOWED_ORIGINS` | Optional explicit frontend origins |
| `UBEEQ_COMMERCE_STORAGE_LIMIT_BYTES` | Creator storage ceiling; defaults to 100 MiB |
| `UBEEQ_COMMERCE_RECONCILIATION_BATCH` | Maximum new scheduled checks per worker tick; defaults to 100 |
| `UBEEQ_COMMERCE_RECENT_PAYMENT_DAYS` | Recent-payment daily reconciliation window; defaults to 30 days |
| `UBEEQ_COMMERCE_FINANCIAL_RETENTION_DAYS` | Required jurisdiction-specific retention policy |
| `UBEEQ_COMMERCE_MAIL_ENDPOINT` | Configured HTTPS mail relay |
| `UBEEQ_COMMERCE_MAIL_TOKEN` | Server-only relay authorization |

The mail relay receives JSON `{to, subject, text, idempotencyKey}` via POST with
Bearer authorization and an `idempotency-key` header. It must durably accept and
deduplicate a message before returning success. Delivery retries never log email
contents or tokens. Keep signing/encryption keys stable across API/worker
restarts and coordinate their backup/rotation with stored references.

Optional Discord configuration uses `UBEEQ_DISCORD_CLIENT_ID`,
`UBEEQ_DISCORD_CLIENT_SECRET`, `UBEEQ_DISCORD_BOT_TOKEN`,
`UBEEQ_DISCORD_BOT_USER_ID`, and `UBEEQ_DISCORD_REDIRECT_URI`. Register the exact
HTTPS `/commerce/discord-callback` URI. Run the existing reference worker using
the same configuration, persistent databases, storage and keys as the API.

Managed hosts can compose `ReferenceApiConfiguration.commerce` with their own
`CommerceRuntimeStore` and encrypted `CredentialVault`. Creator/organization administrators can manage an explicitly selected `?owner=` through an active `commerce.manage` identity delegation; customer magic-link sessions carry no such authority.

Such adapters must supply
cross-process lifecycle locks, fencing, revision compare-and-swap, atomic record
updates plus audits, atomic event/job insertion, database uniqueness, and protected
payload retention. The default SQLite runtime is for persistent local/machine
storage, not ephemeral serverless filesystems. No shared managed callback or
private product policy is an implicit dependency of public core.

## Acceptance verification

Tests exercise the following using mocked PayPal/Discord APIs and real SQLite
transactions and private filesystem storage:

| Criteria | Automated coverage |
| --- | --- |
| AC01–AC03 | Automatic registration/reuse, permissions/allocation errors, rotation, authorization and environment/deployment isolation |
| AC04–AC06 | Exact order snapshots, approval/pending rejection, forged events, payee/amount/currency/reference checks, concurrent/repeated reconciliation and restart recovery |
| AC07–AC08 | Refund before delayed completion, cumulative partial/full refunds, reversal, independent purchase and manual-grant survival |
| AC09–AC10 | Email ownership, single-use/expired/guessed claims, account recovery, private visitors, expiring URLs, post-issuance revocation, package/source availability |
| AC11–AC12 | Bound OAuth IDs, membership retry, bot/server permission and hierarchy checks, rate limits, managed-role provenance and multiple-grant reconciliation |
| AC13–AC14 | Explicit app migration, retained old callbacks, cleanup failures, demonstrated notification plus stable external mapping |
| AC15 | API flows plus real Chromium desktop/mobile smoke for the storefront, shared viewer, purchases, credential submission/clearing and browser-storage isolation |

Run `npm run build`, `npm test`, and the optional `npm run test:commerce-browser` (requires Chromium and a loopback listener). The browser smoke uses a fictitious local API fixture and writes screenshots under `/tmp/ubeeq-commerce-browser`.

These tests do not replace acceptance with real provider services. The environment
has no merchant credentials, registered public callback, Discord bot credentials
or configured mail relay. Before release, run real sandbox transactions and
actual link-notification tests; exercise creator/customer pages on mobile and
desktop with those services; confirm operating/content eligibility, jurisdiction
and customer-data handling; then conduct the specified eligible live pilot.
No real payment, provider registration or deployment is performed by the tests.

## Hosted composition and reconciliation updates

`@ubeeq/commerce-runtime` exports the reusable runtime previously embedded in the
reference API. Product hosts supply their authentication, content eligibility,
private storage, vault and mail adapters. Unknown API routes are left to the host.

`@ubeeq/adapter-aws` exports `DynamoCommerceStore`. It uses encrypted, chunked
snapshots and an atomic revision pointer, so a checkout/payment/grant/outbox
transaction is visible wholly or not at all, including transactions larger than
DynamoDB's per-item or transaction-item-count limits. Reads use strong consistency;
concurrent writers retry optimistic conflicts; lifecycle leases fence stale writes.
Old snapshots are collected after commit, including logically removed raw payloads.
The v1 adapter loads one deployment snapshot per transaction and serializes its
commits. This prioritizes correctness for an initial hosted cohort; larger hosts
can inject an indexed adapter without changing the domain contracts. Recovery and
access require the same persistent encryption key after restarts.

Discord updates are serialized by server/user/role across customers and creators,
then rechecked after remote writes. Scheduled reconciliation repairs interrupted
updates while retaining preexisting independent roles. External notifications must
resolve one immutable, validated provider identifier mapping. New offer versions
require distinct provider identifiers once a mapping has been activated, so delayed
payments cannot be assigned to newer content. Existing payments retain their
original offer version; reused ambiguous mappings fail closed. Offer publication
supports a reviewed request ID, with exact-value idempotency conflict detection.

## Recurring collection access and gifts

Creator commerce offers may use monthly or yearly PayPal subscriptions in addition to one-time purchases. The provider pins connection, custom reference, plan, exact currency/amount and calendar period. It accepts only independently retrieved completed transactions; approval alone grants no access. Existing seller identity is reused; a new seller is identified through a never-captured verification order. Product, plan, subscription and verification-order writes use separate stable request IDs. Subscriptions with per-subscriber overrides, extra cycles, nonzero taxes/setup fees or incomplete transaction history fail closed.

Subscription events and sale completed/refunded/reversed events are registered with the same signature-verified receiver. Periodic reconciliation covers delayed notifications. Cancellation stops future billing and retains paid access. Active agreements keep the connection’s credentials from being disconnected. Each reviewed offer version can update the content of active paid/gifted subscriptions in that plan family while preserving the billing offer and price. Original payment records remain immutable. Native collection one-time access follows the latest saved eligible contents when the customer returns, without another financial offer publication; purchased price, terms, and download/ZIP rights stay pinned.

Creator gifts use scoped, idempotent invitation records and verified recipient emails, with no provider payment or subscription. One-time gifts have ongoing access until revoked. Subscription gifts have a creator-selected fixed calendar duration beginning on claim, receive reviewed content updates while active, and never renew. Revocation preserves separate entitlements. Provider sandbox subscription/renewal/cancellation/refund acceptance remains required before live rollout.
