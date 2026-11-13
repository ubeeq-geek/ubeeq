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
