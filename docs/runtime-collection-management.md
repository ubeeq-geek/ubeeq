# Runtime collection management

The reference runtime binds `CreatorCollectionService` to the existing revisioned
repositories through `RepositoryCreatorCollectionStore`. It does not replace
product collection publication, destination metadata, relationship policies,
approval, announcements, rendition, or release workflows. Those integrations and
an explicit legacy-library migration remain prerequisites for product cutover.

## HTTP contract

Authenticated requests select a Creator using `x-creator-id` or `creatorId`.
Every operation checks the current Creator and cell; editing requires an owner,
admin, or editor role and transaction-bound authority.

| Method | Path | Input |
| --- | --- | --- |
| GET | `/v1/collections` | Selected Creator |
| POST | `/v1/collections` | `title`; optional `description`, `slug`, `type`, `visibility`, `coverAssetId`, `idempotencyKey` |
| GET | `/v1/collections/:id` | Selected Creator must own the collection |
| PATCH | `/v1/collections/:id` | Current `revision` and documented metadata fields or lifecycle `status` |
| DELETE | `/v1/collections/:id` | Current `revision` |
| PUT | `/v1/collections/:id/works` | Current `revision`, `workIds`, and `expectedWorkIds` |

Writes reject unknown fields, ownership changes, forged publication history, and
client-supplied directory or membership metadata. Responses include `workIds`,
the saved revision, lifecycle history, and `managementReady`. Metadata and ordering
conflicts return 409. Invalid inputs and foreign Works/covers return 400; missing
access returns 403. Oversized aggregates return 413 before a DynamoDB write.

New collections start as drafts. Publishing requires the separate publication
workflow. A collection with recorded Work publication history must be archived
instead of deleted. Archiving without that history is rejected. Archived
collections may return to draft; deleted collections cannot be restored. These
rules retain positive collection history; publishing a Work elsewhere is not
evidence that it was published to this collection.

An optional Create request key is scoped to instance, Creator, and authenticated
actor. Collection creation and its original-intent receipt commit together.
Retries recover the current record, including subsequent edits, and recheck
current authority. Reusing the key for different details returns 409.

## Persistence and authorization

A trusted new-Creator transaction initializes a revisioned collection directory.
It supplies a complete ID inventory for strong point reads and an atomic
per-Creator fence for current and historical slug reservations. The runtime does
not infer an empty library from an eventually consistent index. List operations
also discover unmanaged legacy records, so they are not hidden by the directory.

Ordered membership lives in the collection's revisioned aggregate. Reordering
checks both the previous order and the current collection revision. The adapter
rechecks each Work's owner and active state, reads at most eight Works at once,
and preserves original membership dates. The directory fence allows more than
100 members without requiring a DynamoDB condition per Work. The actual 120-Work
acceptance case uses four transaction items, including authority guards.

**Every Work deletion or ownership migration writer must join
`withCollectionWorkLifecycleFence`.** The runtime Work DELETE route does so.
Future migration writers must participate before they are enabled. The fence is
separate from the Creator revision so library edits do not change billing
authority. Covers require a ready image, a private original in the same
Creator/cell object namespace, and a commit-time asset revision guard. Original
custody remains valid when a separate processed rendition has public delivery.

The default host permits mutations only by the current Creator owner and guards
that Creator revision at commit. A SaaS host supplies
`collectionAuthorization.authorizeMutation`. The callback receives the verified
actor and the active repository transaction; it must check durable current
membership with commit-time revision guards. An earlier role preflight or
request-supplied role cannot authorize the commit. Nested commercial-store
transactions must share the same underlying repository transaction.

## Existing libraries and imports

Existing libraries without a trusted directory remain readable with
`managementReady: false`; advanced writes return `collection_migration_required`.
The runtime does not silently adopt, normalize, or discard their opaque data.
Their complete inventory, aliases, membership order, publication history, and
advanced configuration must be reconciled under a writer fence before adoption.
No operator migration command is provided in this tranche.

Imports preserve opaque collection data and atomically mark the directory as
requiring migration. Known imported IDs are retained in that directory immediately
so index lag cannot hide them. Imported `collectionManagement` values cannot
grant authority or enable writes. Replaying an existing Creator creation request
does not initialize a missing legacy directory.

A valid saved aggregate remains readable in its original order while migration
is pending, including collections already present before an import. Untrusted
imported membership references are point-read and filtered to this Creator's
actual Works. This read-only projection neither adopts the imported aggregate
nor enables mutations.

## Verification

Build the repository before running its Node tests. The runtime SQLite and HTTP
suites cover persisted edits, retry recovery, ownership, revision/order conflicts,
cover custody, lifecycle, and import compatibility.

`npm run test:managed-creator-collections` requires an explicit loopback
`TEST_DYNAMODB_ENDPOINT`. It uses real DynamoDB Local tables and independent
repository/transaction coordinators to test concurrent slug reservations, Work
deletion during a membership save, permission revocation after authorization,
asset changes after cover validation, 120-Work ordering, lost commit replies, and
import fencing. Test tables are removed on completion. CI runs this suite against
the pinned DynamoDB Local service; it is not a deployed-cloud acceptance claim.
