# Optional Flickr client

`FlickrClient` provides OAuth 1.0a request/access-token exchange and authenticated
photo inventory, album enumeration, and album photo IDs. Applications supply
their API key/secret, user token/secret, callback/verifier, fetch implementation,
and optional minimum request interval. No application registration or product
policy is bundled. This is a server-side client; returned tokens must remain in
the application's credential vault and must not be sent to a browser.

The extracted runtime preserves its existing constructor and return shapes,
metadata extras, provider-order pagination, and three-attempt handling of HTTP
429/5xx read responses. Token exchanges and thrown transport failures are not
automatically retried. Applications retain ownership checks, OAuth state/replay
protection, storage, consent, source migration, and public response projection.

Requests reject redirects and have a 30-second abort signal and a 4 MiB streamed
response limit by default. The optional fifth constructor argument accepts
`timeoutMs` (1–300000) and `maxResponseBytes` (1–16777216). Limits are validated and
copied at construction. Fetch implementations must honor the signal during both
request and body consumption. Error bodies are bounded too; their HTTP status
still controls the existing retry policy. Successful oversized responses and
transport failures are not automatically retried.

This extraction is not production qualification: per-attempt timeouts are not a
total operation deadline, including pacing/retries; album enumeration
materializes all pages; provider payload validation is permissive;
retry pacing is process-local rather than a durable/global quota. Those gaps need
operation budgets and resumable jobs before hosted readiness. The injected fetch
supports offline conformance tests without contacting a provider.
