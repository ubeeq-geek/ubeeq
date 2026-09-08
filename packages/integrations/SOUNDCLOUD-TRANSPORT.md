# SoundCloud transport extraction

SoundCloudTransport owns token exchange, form API requests, provider error mapping and same-origin continuation validation. It supports an injected fetch implementation for repeatable fixtures. Credentials must be provided by the caller and enabled; requests disallow redirects. Token parameters cannot override configured client identity. No request occurs until a caller invokes an operation.

Product capability admission, OAuth state/PKCE, credential persistence, upload streams, recovery and canonical storage are not supplied here. This extraction retains existing response handling, including permissive JSON fallback, unbounded JSON reads and expiry coercion; deadlines and response budgets remain explicit follow-up requirements, not production-ready guarantees. No automatic retries or provider writes are initiated by constructing the transport. Test credentials and responses are synthetic.
