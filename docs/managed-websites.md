# Managed website persistence

`DynamoWebsiteHostingStore` implements both website and hosting persistence. A
host can inject it into the shared API without selecting the local SQLite
composition. The host supplies its DynamoDB document client, a `pk`/`sk` table,
the exact instance/cell identifiers, and the runtime's owned file blob port:

```ts
websitePersistence: ({ blobs }) => {
  if (!blobs) throw new Error('Owned website file storage is required.');
  return new DynamoWebsiteHostingStore({
    client: documentClient,
    tableName: websiteTableName,
    instanceId,
    cellId,
    blobs,
  });
},
websiteHostingAdapters: configuredHostingAdapters,
```

The injected core adapters can provide `credentials: encryptedCredentialVault`
for external hosting connections. External hosting also requires an explicit
outbound policy and durable OAuth state. Injected stores and workload clients
remain owned by the host; closing the API closes only its internally created
local store. Managed adapters without configured website persistence do not
silently create a local website database.

## Metadata and file storage

Website documents, page lists, review metadata, attempts and serving state are
platform database metadata. Their immutable JSON encodings use 128 KiB DynamoDB
chunks and small manifests, independently of customer file capacity. Large
shared fields such as dependency lists share a content-addressed encoding.
Record pointers remain small even when a website or frozen projection exceeds
one DynamoDB item's limit. Payload staging uses the base client before the
pointer transaction, so a large projection does not consume its transaction's
item budget. Checksums and scope facts are verified on reads.

Customer file quota measures owned images, frozen binary media, build files and
ZIP copies. Metadata changes, worker checkpoints and unpublishing do not need a
new customer file reservation. A host refusal of new file writes leaves accepted
versions and charges intact while control state can still record a withdrawal.
This preserves the local SQL composition's distinction between application
records and retained file bytes.

Record partitions bind the instance, cell, workspace and record kind; listing
uses scoped queries. Updates use internal pointer revisions in addition to the
public configuration revision. Deletion retains a pointer tombstone so reusing
an ID cannot revive an old revision guard. Physical metadata and file reclamation
remain separate from logical deletion.

## Hosting state

Publication acceptance atomically creates the intent, desired target generations,
attempts and recoverable outbox entries. Twenty targets with twenty distinct
connection guards and a binding use 84 transaction items. Large dependencies are
outside those items. Configuration saves preserve concurrent deployment locks,
serving state and generations through pointer CAS. A stale worker cannot update
an attempt, and uncertain activation retains its writer lock.

Remote roots have installation-scoped ownership claims. OAuth state is consumed
once, retaining its nonce afterward. Expired-review cleanup queries an expiry
index and races safely with acceptance; accepted snapshots remain pinned.

Persistence accepts calls from trusted application code. The runtime still
performs creator and publication authorization. A commercial deployment must
compose its authoritative identity, tenancy, policy, quota and workload clients;
the persistence adapter itself does not grant application permissions.

## Verification and release boundary

Run `TEST_DYNAMODB_ENDPOINT=http://127.0.0.1:8000 npm run test:managed-websites`
after building. The test command requires a loopback endpoint and uses dummy
credentials. Tests create unique tables and delete them in `finally` blocks.
CI runs the official DynamoDB Local 3.3.2 image pinned to the multi-platform
manifest `sha256:6ada631ec7aa5fc83446855eb17233e3dad184fec47477e8140c6c569cfe0c86`.
The version is documented by [AWS](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/DynamoDBLocalHistory.html);
the digest was verified against the [official image metadata](https://hub.docker.com/v2/repositories/amazon/dynamodb-local/tags/3.3.2).

The public suite exercises real DynamoDB metadata/hosting transactions with a
synthetic customer blob port. The commercial composed acceptance additionally
uses the actual owned filesystem writer, DynamoDB core repositories and queue,
managed DynamoDB quota/credit receipts, and HTTP build/publish/restart flows.
Its authentication and publication provider are explicitly synthetic.

These checks do not certify live Cognito, S3 or CloudFront composition, complete
product/browser parity, purchased-credit fulfillment, metadata/file reclamation,
backup/restore or legacy migration. Cutover must inventory record pointers,
control indexes, metadata chunks, owned file journals and provider versions
together. Rollback requires compatible API/storage formats. No production
feature flag is enabled by adding these adapters.
