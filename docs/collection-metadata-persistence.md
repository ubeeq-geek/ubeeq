# Collection metadata persistence

`DynamoCollectionMetadataStore` in `@ubeeq/adapter-aws` implements the public
`collectionMetadata.CollectionMetadataStore` contract. It stores relationship
configuration, observations, proposals, provenance, audit events, executions,
command receipts and published projections. It does not change Works, membership,
ordering, publication access or the native catalogue on its own.

The adapter retains the established partitioned `PK`/`SK` layout:

| Record | Partition | Sort key |
| --- | --- | --- |
| Header and published projections | `TENANT#{tenant}#COLLECTION_METADATA#{collection}` | `STATE` |
| Group record | Same metadata partition | `{group}#{id}` |
| Installation route graph | `COLLECTION_METADATA_GRAPH#INSTALLATION` | `ROUTES` |

History remains separate records. Reads paginate the entire strongly consistent
partition; an eventual index or a single aggregate is not a history inventory.
Snapshot, provenance, audit, execution and command records cannot be removed or
changed. Canonically identical records are not rewritten. State and route graph
writes retain revision conditions. Existing per-record and graph storage budgets
and the 100-item transaction limit remain enforced.

## Host composition

Construction requires a trusted `boundaryItems(commit)` callback. For a normal
commit, the adapter combines its metadata and graph writes with those returned
items and submits one `TransactWriteCommand`. An empty boundary plan is rejected.
The final transaction budget includes every host item. Transaction cancellation
is reported as a stale revision so the host can retain the user's review and
require a fresh comparison.

The host must authorize the command before any external side effect and return
the **current transaction-bound guards** for its Creator, collection, organization,
every relevant actor and any execution lease. When native metadata changes, its
conditional collection write and any required slug-alias writes belong in this
same transaction. The adapter cannot infer these schemas or grant authority from
the commit's permission fields. Never expose this callback or accept transaction
items from an HTTP request.

`transactionItems(commit)` is a staging API for an existing host transaction,
such as a collection organization operation. It only prepares metadata and graph
writes: it does not send a transaction, invoke the host callback or authorize the
operation. The enclosing host transaction must retain all authorization and
ownership guards and check its final item budget. This avoids stripping guards
from a completed transaction to obtain a sidecar.

The configured table is one installation boundary, and all of its tenants share
the route graph. Separate installations require separate table ownership. This
layout is distinct from the generic repository's lower-case `pk`/`sk` schema;
selecting the adapter does not adopt or migrate an existing library. A host must
explicitly preserve its existing writer fences before enabling metadata commands.

## Verification

`node --test adapters/aws/test/collection-metadata-store.test.mjs` covers the
composition boundary, stable keys, pagination, immutable groups, staging,
transaction budgets and error mapping.

`npm run test:managed-collection-metadata` requires an explicit loopback
`TEST_DYNAMODB_ENDPOINT`. Its disposable actual DynamoDB table verifies history
larger than one megabyte, page completion, immutable observations, membership and
admin revocation, changed collection ownership, organization revision, Creator
deletion, competing commits, cross-tenant route ownership and an enclosing
conditional sidecar transaction. The table is deleted and its absence verified
in `finally`. CI runs this suite against the pinned DynamoDB Local service.
