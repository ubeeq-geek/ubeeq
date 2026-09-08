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
methods is not proof those credentials permit uploads. Account metadata fallback,
permissive provider parsing, unbounded buffered responses/downloads, missing
request deadlines/redirect rejection, and provider-URL admission remain known
qualification gaps. Do not treat a cursor, source URL or gallery URI as an access
grant. Callers must not expose tokens or source capabilities in browser responses.

Tests use injected provider fixtures. This extraction does not publish media,
contact providers, deploy infrastructure or claim hosted readiness.
