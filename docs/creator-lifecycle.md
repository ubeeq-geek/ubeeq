# Creator intake and host lifecycle

The shared runtime accepts an optional trusted `creatorLifecycle` configuration.
It allows a host to distinguish a newly created Creator from an existing profile
which needs an explicit import or migration.

`prepare` receives a frozen Creator snapshot, authenticated actor ID, the actual
configured repositories and the active persistence transaction. Save the host's
initial receipt/outbox in that transaction. The Creator, request receipt, host
preparation and any first-operator claim either all commit or all roll back.
Preparation must use database operations only: transaction retries can repeat an
uncommitted attempt. Do not send messages, call external providers or grant an
effect outside the transaction from this callback.

`activate` runs after commit with the frozen current Creator and actor ID. It must
be idempotent against the prepared host receipt and return `ready` or `pending`.
A missing callback, pending result or activation exception returns HTTP 202 with
the persisted Creator and `provisioning: { state: 'pending' }`. A ready result
returns HTTP 201. The host worker can recover pending preparation independently;
the response never claims readiness merely because the profile exists. The host
must recheck current ownership, account status and its applicable authority before
performing activation effects. The neutral runtime defines no plan or financial
policy.

Clients can supply an `idempotencyKey` of one to 128 ASCII letters, numbers,
underscores or hyphens when posting `/v1/creators`. Reuse that identity for an
unchanged request after network uncertainty. Its durable receipt is scoped to the
authenticated actor and instance. Concurrent requests or a lost commit reply
recover the original Creator; an already committed preparation is not repeated.
Post-commit activation may run again and must recover its existing outcome.
Reusing a key for different initial handle/display-name values returns 409.
Replaying an old request does not restore profile fields edited since creation.
Changed ownership, cell or missing Creator evidence requires reconciliation.

Existing hosts without lifecycle configuration retain their normal HTTP 201
creation behavior. Unkeyed calls retain intentional new profile creation; managed
clients should use stable keys for provisioning workflows. Customer principals
remain unable to create Creators, and the single-operator claim still prevents a
second operator while allowing multiple identities for the existing operator.

Verification includes real HTTP preparation rollback/pending/retry cases and
actual DynamoDB atomic Creator/host/request receipts, concurrent creation and
lost-response recovery. Run `npm run test:managed-creator-intake` with an explicit
loopback `TEST_DYNAMODB_ENDPOINT`; the test uses dummy credentials and deletes
only its uniquely named disposable tables.
