# Vimeo write client

The shared client sends video metadata/privacy updates, video deletion and token
revocation using bounded requests. Video operations admit only video resource
paths; token revocation uses its own fixed endpoint. Explicit empty metadata,
empty domain lists and false download flags are preserved. Privacy-only updates
do not submit title, description or source replacement fields.

The caller owns confirmation, allowed privacy/domain choices, credentials and
reconciliation. Errors including 404 propagate; the client never retries a write
or interprets a lost response as proof of failure. The API base is trusted
composition configuration. Uploads, OAuth exchange, and durable recovery are not
implemented by this client. Tests use synthetic responses, not live operations.
