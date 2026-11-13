# Retry-safe direct uploads

The Work API accepts an optional `idempotencyKey` in the creation body. Keep that
key and the original title for retries. The draft and its owned request receipt
commit in one repository transaction. A repeated request returns the saved Work;
a changed title with the same key conflicts. Replays never resurrect deleted
Works. Requests without a key continue to create a new draft each time.

For each file, initiate one logical upload with a separate stable request key.
Send exactly the headers returned in `upload.parts[0].headers` with the direct
PUT. Providers omit browser-controlled headers: the browser derives Content-Length
from the Blob body. A completed initiation response allows clients to skip PUT
and request the owned completion result again.

The AWS adapter signs the exact Content-Length, Content-Type, SHA-256, access
metadata and `If-None-Match: *`. Completion enables the provider checksum read and
verifies every issued fact plus the immutable version. Missing and mismatching
objects cannot become assets. A failed or lost PUT reply may be recovered only
through successful authenticated completion, including after a 412 response.

Configure the source bucket's CORS policy for the actual web application's origin,
PUT, and the returned headers. The web application's Content Security Policy must
also allow connections to its configured direct-upload endpoint. API tests and
server-side S3 acceptance do not certify those browser deployment settings.

## Storage accounting and closure requirements

[AWS's conditional-write contract](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html)
checks the current object version. A delete marker permits another conditional
write. Retain the accepted current object while an issued capability can write;
do not treat URL expiry or a missing HEAD response as proof of physical closure.

A disposable AWS experiment verified that a zero-byte conditional fence at an
unused key rejected both an earlier unfinished conditional PUT and a later replay.
The implemented S3 `seal` method retains such a fence, verifies its current version,
actual empty-body checksum and provider write time, and returns a stable closure
proof. If the original won the race, sealing returns those accepted bytes instead.
The local provider atomically seals an unused session or recovers its accepted
original. Never garbage-collect a current fence while an old write can complete.

## Original storage reservations

The runtime reserves original bytes before issuing the provider session. Completion
commits the physical write time and a storage settlement intent with the asset.
Settlement delivery is independently replayable after a lost reply or restart.
Expired sessions enter `closing` before provider sealing. Accepted originals are
recovered into the Work, or retained for reconciliation if the Work was deleted or
its completion facts conflict. Retained originals still consume storage.

An empty closure commits its proof and an outbox intent before releasing capacity.
`UsageQuotaPort.closeStorageReservation` must permanently fence the same request
key even if its first reserve is still in flight. Commercial adapters close that
key atomically with releasing any matching storage hold. This does not refund
processing credits, delivery, or consumed storage. A never-issued provider
capability can close only after the journal prevents its late publication.

Commercial composition requires `requireUploadAccounting: true` and fails startup
without physical sealing, recoverable completion receipts and terminal storage reservations. Unmetered open-core
hosts retain their existing optional adapter support. Earlier unfinished sessions
without accounting evidence must drain through the previous writer; existing
completed assets require their authoritative inventory baseline at cutover.

The shared client replaces a request key only after the owned API confirms that
the prior upload was empty and sealed. Unknown outcomes and retained originals
keep their request identity. Replacement keys also survive retries in that intake.

## Owned processing outputs

The core `asset.process` path reserves additional storage for its public rendition.
It uses the bounded upload protocol instead of an unconditional object-store PUT.
The source remains immutable. Exact output bytes, source-processing evidence and a
unique per-generation key are journaled before the physical write. Its accepted
version, actual write time and storage-settlement intent commit together before
the asset references that output. A failed asset transaction does not erase the
physical receipt or refund retained bytes. Retried jobs reuse the saved rendition
and processing evidence, avoiding another transform or storage version. Transient
processor byte buffers are excluded from persisted processing metadata.

`@ubeeq/runtime/owned-object-writes` exports this mechanism for other internal
outputs. Construct it with one repository transaction coordinator, an upload
provider with completion recovery and sealing, and a quota port with terminal
storage closure. Keep the logical output identity stable across attempts. Call
`recover` before regenerating an interrupted output; an accepted version returns
its saved metadata. An empty interrupted generation is sealed before a replacement
key can be used. Changed bytes or metadata with the same logical identity conflict.
`repair` closes expired generations and retries durable accounting intents. Run
repair regularly even when there are no processing jobs. Internal provider URLs
are never returned by this mechanism.

The internal writer uses the local provider's authenticated content operation or
one HTTPS PUT with all returned headers; redirects and unsupported multipart
shapes are rejected. A lost provider response is resolved through the owned
receipt, never by assuming that the write failed. A never-issued generation can
close only after its journal fences late capability publication and its quota key
permanently fences late reservations.

Existing ready assets and old unjournaled renditions still require an authoritative
physical inventory baseline. This does not convert creator-tool artifacts or
website caches to owned writes. Full accounting also requires those outputs,
retained-version inventory, physical removal receipts, retention/restore behavior,
and actual delivered-byte ingestion. Removing an owned payload through the plain
storage API is not an accounting release and can reopen a conditional key; use a
future verified physical-removal protocol that preserves the required write fence.

## Website image caches

Website image prewarming and cold-cache resolution use the approved public
rendition's immutable reference and checksum. They preserve its crop and visible
watermark while stripping embedded metadata. They never substitute private
original pixels to resolve a public-rendition checksum mismatch.

New accounted cache objects use owned writes with the `website.rendition`
operation, a recipe pinned to the public version/checksum, and a private scope.
Their actual byte length and provider write time settle independently of the
website build. No second SQLite BLOB copy is created. Cache reads verify the
saved physical version, metadata and body checksum; corruption requires recovery
rather than silently replacing a charged version. Quota or settlement outages
retain the normal owned-write journal and outbox recovery behavior.

Retained SQLite caches require the cutover inventory baseline. A legacy cache
based on original bytes is reusable only when those bytes are also the current
approved public input. Otherwise it stays retained for reconciliation and a new
cache is generated from the approved variant. Unmetered installations without
owned-write capabilities retain the version-pinned SQLite cache path.

This covers clean image caches in the local reference composition, including a
commercial host using that composition. Website images, snapshots, build files,
ZIP archives and managed website persistence still require their own integration
and accounting before the full website release gate can pass.

## Website files and frozen sources

The default local website composition can now use a `WebsiteBlobStore` backed by
`OwnedWebsiteBlobs`. Uploaded website images, immutable build files, frozen
publish-source bytes and ZIP archives use private owned objects, with no second
SQL BLOB copy. File and archive copies are distinct physical bytes and each is
counted; matching content reused by files, images and frozen sources shares its
existing owned blob within the same Creator workspace.

Each blob is divided into at most 2 MiB chunks. Its constant-size manifest stores
the total checksum, length and chunk count; immutable per-chunk receipts remain
in the owned-write journal. Preview ranges recover and verify only intersecting
chunks. This keeps the existing 256 MiB website file budget and large-site
capacity without embedding the archive or a growing object list in one database
record. Full reads also verify the aggregate checksum.

Physical writes and settlements precede the logical metadata transaction. Failed
manifest or website transactions leave charged bytes recoverable under the same
identity; retry does not write another version. A quota denial midway through a
blob retains already accepted chunks, closes the unused generation and leaves no
partial readable manifest. Snapshot and file references become visible only
after their complete bytes are available.

Logical artifact/plan cleanup removes references, not provider payloads or their
charges. A future verified reclamation protocol must retain capability fences,
reconcile all references and prove physical version removal before releasing
quota. Legacy SQL bytes stay readable and require their cutover baseline; they
are not copied or charged again solely because the owned backend is enabled.
Unmetered installations can keep the SQL backend by omitting the blob port.

The local composition uses SQL metadata and hosting state. Hosts may inject the
[DynamoDB website implementation](managed-websites.md) for managed adapters.
Live provider composition, deployed serving-copy accounting, retention/restore
and full migration/browser acceptance remain release gates. The owned blob port
alone does not make website APIs available without a configured metadata store.

Once external references have been committed, opening that SQL database without
its configured blob backend fails closed. Cutover and rollback must restore a
compatible metadata/byte-store pair; the earlier SQL-only binary is not a reader
for newly owned references. Legacy inline ZIP projections may still migrate to
the old indexed SQL representation under their baseline, without minting a new
owned storage charge. A retention race that removes reused legacy bytes during
staging aborts the metadata transaction with a revision conflict and can be retried.
