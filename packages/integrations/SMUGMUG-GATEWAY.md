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
Permissive provider parsing, unbounded buffered responses/downloads, missing
request deadlines, and original-source URL admission remain known
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

Tests use injected provider fixtures. This extraction does not publish media,
contact providers, deploy infrastructure or claim hosted readiness.
