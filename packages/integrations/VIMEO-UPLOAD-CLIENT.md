# Vimeo upload protocol

The shared upload client creates a tus ticket, reads the provider offset and
sends one chunk. Requests use the bounded request helper and never retry.
Source size, chunk offsets and returned offsets require safe integers. Missing,
negative, fractional or exponent-form offset headers are rejected rather than
coerced to zero. A chunk receipt must advance by exactly the submitted byte count.

This is not an upload orchestrator. The caller must admit upload URLs before
passing them in, protect those capability URLs, bound source/chunk sizes, persist
tickets and offsets, claim work, and reconcile uncertain remote creation or
chunk outcomes. The client does not validate upload hosts or DNS destinations.
Tests use synthetic responses only; full connector safety remains unqualified.
