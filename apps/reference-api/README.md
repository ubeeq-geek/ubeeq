# Ubeeq reference API

The reference API is a neutral, local-first implementation of the creator profile, Work, Asset, Collection, upload, publication, delivery, and export flow.

`PublicationService` in `@ubeeq/api` owns the canonical publication mechanism.
Consumers supply an authenticated Work-authorization callback and an explicit
publication-admission callback; there is no default allow policy. The reference
route composes those callbacks with its ownership and moderation checks. The
service requires canonical repository ports and does not dispatch to providers.

Existing SQLite compatibility-library consumers can supply those ports using the
[request-scoped library publication view](../../adapters/local/LIBRARY_PUBLICATION.md).
This preserves their stored identities without copying Work and asset records;
it does not automatically connect the reference public routes to that library.

`PublicationWithdrawalService` provides an explicitly authorized/admitted local
receipt withdrawal. It atomically changes one live publication to `removed` and
writes its audit event, using the expected publication revision. Repeated removal
is idempotent but still requires authorization and withdrawal admission. It leaves
the Work, files and other destinations unchanged. Consumers must supply a separate
withdrawal policy and transport; publication eligibility is not implicitly reused.
This service does not dispatch external provider removal or cancel queued jobs.

Publication writes the intent, live publication, Work revision and audit record in
one repository transaction. Local failure-injection tests verify rollback at each
later write boundary. Publication requests with a non-empty `Idempotency-Key` of
at most 200 characters use stable intent/publication IDs scoped to the instance,
Creator and Work (not its routing cell). Retries return HTTP 200 with
`idempotent: true` and the current stored records; they do not increment the Work
revision, add an audit event, or republish a removed record. Reusing the key with
a different destination returns 409. Missing keys identify independent requests.
This is not byte-for-byte historical response replay, and does not retrofit
deduplication onto older randomly identified publication intents. Receipts must
be retained and moved with publication records during migration.

This is not full publication qualification: indexed asset/admission queries, concurrent policy changes,
and external-provider/CDN withdrawal and revocation still need work. The destination
field is metadata here, not confirmation of delivery to an external provider.

Publication admission walks every asset and moderation-hold page; a failed or
repeating cursor aborts the request. Only matching records are retained, but the
scan still grows with cell data and is not a transactionally consistent snapshot.
Public viewing also walks all asset/publication/hold pages and requires a live
publication. The local delivery gateway rechecks current Work publication, ready
asset membership, exact stored object version and holds before reading bytes.
Both responses use `private, no-store`. Tests revoke already-issued local URLs via
work/creator/asset holds, withdrawal, version replacement and readiness changes.
This cannot revoke previously downloaded bytes or pre-existing cache entries, and
external delivery providers do not automatically inherit the local gateway check.
Exports and other list paths still need a separate pagination audit; an indexed,
consistent admission design is required before production-scale qualification.

These routes use the canonical `repositories.works/assets/publications` records.
They do not automatically consume `LocalCreatorLibraryStore` compatibility records.
A consumer using that library needs an explicit, identity-preserving publication
integration; mounting this route alone does not publish its library Works.

Upload completion creates a durable `asset.process` job instead of making an asset immediately publishable. The entire `/v1/operations` namespace, including queued-job execution/recovery/cancellation, moderation holds, review cases, audit and usage reads, requires explicit `operatorAuthorization` in the API composition. Missing or empty requirements disable these routes with `404 operations_unavailable`; an ordinary signed-in session is not operator authority. Configure a non-empty role/scope requirement and have the identity adapter issue those claims only to authorized operators. Product-specific review policy remains a separate requirement. Trusted in-process worker execution does not use this HTTP boundary.

`GET /v1/exports/me` produces the versioned, checksummed creator manifest defined by `@ubeeq/portability`. `POST /v1/imports/validate` performs a no-write validation/conflict check; `POST /v1/imports` defaults to dry-run and imports only when sent with `dryRun: false`. Manifest import deliberately excludes credentials and original files. Imported assets remain pending until a separately authorized object-transfer and processing step supplies their source files.

Run it from the repository root:

```sh
npm run dev:reference-api
```

It listens on `http://127.0.0.1:4100` by default and stores SQLite state plus filesystem objects under `./var/reference`. No cloud credentials or network service are required.

`node:sqlite` is currently experimental in Node 22; use Node 22.5 or newer for
this reference implementation. With nvm, run `nvm install 22 && nvm use 22`.

## Creator payments

The optional commerce runtime serves PayPal setup, immutable offers, customer
checkout/purchases, secure claims, private galleries/downloads and Discord roles.
It is disabled by default. See
[creator payments configuration and acceptance](../../packages/integrations/PAYPAL-CREATOR-PAYMENTS.md)
for required keys, mail relay, callback, storage, worker and provider eligibility
configuration. `/commerce/creator` manages setup; `/commerce/purchases` is the
customer access/recovery page. Managed hosts must inject durable commerce/vault
adapters instead of relying on ephemeral local storage.

### Durable upload completion

`POST /v1/uploads` accepts an optional `idempotencyKey` (1–128 letters, digits,
underscores or hyphens). Reuse it for the same initiating actor, Creator, Work,
type, size and checksum when an initiation response is lost. The returned
`uploadId` is an opaque application session; clients must not derive it from a
provider object or substitute a provider upload identifier. A replay whose asset is already committed returns
`upload.completed: true`; clients can skip retransmitting its bytes and replay
completion to recover the existing result.

The upload journal binds content and completion to the original Work and
Creator. Completion retries return the same asset and processing job. The asset,
moderation evidence, audit entry and pending processing intent commit together;
queue dispatch happens afterward. If the queue is unavailable, completion still
returns HTTP 202 with the committed asset, `job: null` and `queuePending: true`.
The worker repairs that pending intent before leasing processing jobs. A queued
acknowledgement and a completed media operation remain distinct states.

Upload providers can implement `recoverCompletion` to recover the exact physical
object after a lost completion response without writing another version. The
local adapter persists a prepared/completed receipt and uses exclusive writes to
a stable provider-owned version. It verifies the stored body and metadata before
recovering; changed facts or missing/corrupt bytes require reconciliation. Its
ordinary `complete` method remains one-use. The separate recovery operation
returns the existing accounting fact.

This journal does not itself certify complete physical-byte quota accounting.
Bounded immutable direct writes, retained-version reconciliation, physical
removal proofs and actual served-byte ingestion must be integrated with the host
quota port before claiming complete managed storage/delivery accounting.

The additional AWS transaction-engine check requires a separately started local
DynamoDB engine and refuses non-loopback endpoints. It uses dummy credentials,
creates a uniquely named table and deletes that table in `finally`:

```sh
npm run build
TEST_DYNAMODB_ENDPOINT=http://127.0.0.1:8239 node --test adapters/aws/test/upload-lifecycle.dynamodb.mjs
```
