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
The fixture was removed completely after the check. That experiment establishes
provider behavior, not a production closure/deletion protocol. A durable closure
journal, ownership-verified fence retention, exact version inventory, physical
removal receipts and quota settlement remain required before releasing reserved
storage for unfinished uploads. Existing retained objects still consume storage.
