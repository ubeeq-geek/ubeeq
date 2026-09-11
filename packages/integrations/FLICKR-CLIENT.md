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

This extraction is not production qualification: default fetch has no deadline
or response-byte limit here; redirects are not explicitly rejected; album
enumeration materializes all pages; provider payload validation is permissive;
retry pacing is process-local rather than a durable/global quota. Those gaps need
bounded transport and resumable jobs before hosted readiness. The injected fetch
supports offline conformance tests without contacting a provider.
