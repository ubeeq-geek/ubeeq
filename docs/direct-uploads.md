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
without physical sealing and terminal storage reservations. Unmetered open-core
hosts retain their existing optional adapter support. Earlier unfinished sessions
without accounting evidence must drain through the previous writer; existing
completed assets require their authoritative inventory baseline at cutover.

The shared client replaces a request key only after the owned API confirms that
the prior upload was empty and sealed. Unknown outcomes and retained originals
keep their request identity. Replacement keys also survive retries in that intake.

This covers original uploads. Full accounting still requires every derivative,
creator-tool and website output, exact retained-version inventory, physical removal
receipts, retention/restore behavior, and actual delivered-byte ingestion.
