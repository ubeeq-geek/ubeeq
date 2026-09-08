# Optional SmugMug HTTP gateway

The shared OAuth 1.0a/API v2 gateway owns provider request signing, token exchanges,
catalogue traversal cursors, collection/image metadata mapping, original download,
explicit gallery upload and metadata update. Applications provide registration
details, callback URL, fetch and a credential-vault port. Vault storage/encryption,
ownership, consent, migration persistence, content admission and publication
policy remain application responsibilities. No concrete credential store or
product registration is bundled.

The extracted behavior retains existing constructor/method contracts and cursor
encoding. Authorization currently requests Read permission; presence of write
methods is not proof those credentials permit uploads.
Permissive provider parsing and original-source URL admission remain known
qualification gaps. Do not treat a cursor, source URL or gallery URI as an access
grant. Callers must not expose tokens or source capabilities in browser responses.

API catalogue/update destinations must remain on the configured API origin under
`/api/v2`, without URL credentials or fragments. Same-origin absolute continuation
URLs normalize to relative cursor entries; foreign provider links reject the page
before a cursor is returned. All signed and OAuth requests reject redirects.
These host/path checks are not per-account authorization, DNS admission or a
source-download host allowlist. Custom API/OAuth origins remain trusted operator
configuration.

Authorization requires a nonblank provider UserID or URI; missing identity rejects
instead of inventing a random account. Display-name fallback is retained. The
exchanged credential is still saved before reading account metadata, so a failed
identity read leaves it in the caller-owned vault for recovery. This does not make
OAuth exchanges retryable or provide that recovery workflow automatically.

All requests receive a 30-second abort signal. OAuth/API/upload metadata is read
through the bounded text reader with a default 4 MiB limit. `requestTimeoutMs`
(1–300000) and `maxMetadataBytes` (1–16777216) may be supplied in options and are
validated/copied at construction. Error bodies and unused update bodies are
cancelled. Injected fetch must honor abort during request and body consumption.
No automatic retries are added, especially after uncertain writes. These are
per-request bounds, not whole-job deadlines.

Original downloads use the shared storage byte collector with a default 50 MiB
limit. `maxDownloadBytes` must be a positive safe integer and is copied at
construction; callers should choose a budget appropriate to their memory and
concurrency. Missing size metadata is allowed, but supplied catalogue sizes must
be positive safe integers. Both advertised and actual bytes are checked against
the budget, and actual length must match any supplied catalogue/header length.
Empty originals reject. The reader is cancelled and unlocked on exit. This still
buffers the original in memory (including collector growth/final-copy overhead);
it is not streaming to storage, checksum verification, image validation or source
host admission. Injected fetch must honor the request abort while streaming.

Tests use injected provider fixtures. This extraction does not publish media,
contact providers, deploy infrastructure or claim hosted readiness.
