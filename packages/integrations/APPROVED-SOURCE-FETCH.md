# Per-hop approved anonymous source fetch

fetchApprovedSource accepts url, approveUrl, signal, optional maxRedirects and
optional fetcher. It performs anonymous GETs only: no caller credentials or
headers, no referrer, HTTPS/default port only and no URL userinfo. Product domain
allowlists belong in approveUrl, which must explicitly return true for each
canonical destination before any request. Use stable product policy for the
duration of the operation.

Redirects are manual. Relative Location values resolve against the previous URL,
fragments are removed, and every new destination is checked again. Only the
standard 301/302/303/307/308 statuses are followed. The default budget is three
redirects (four requests); callers may choose zero through ten. URL length is
bounded at 8192 characters. Loops, missing locations, exhausted budgets and
transports that unexpectedly follow redirects raise SourceUrlPolicyError.

Intermediate and rejected responses are cancelled. The caller owns the returned
terminal response, including non-success HTTP statuses: validate its status,
collect its body with a byte bound and dispose of it. A caller-supplied abort
signal is required and passed to every request. The helper checks it before
requests and after headers. It does not create its own timer or retry requests.
Injected transports must honor manual redirect, abort and credential options.

This validates URLs, not resolved network addresses. It is not DNS pinning,
private-address screening, a network sandbox or a complete SSRF defense. An
approved hostname can still resolve to an inappropriate address; deployment
egress controls and trusted DNS policy remain necessary. It adds no final-body
byte limit, complete job deadline or automatic runtime adoption.

Tests use Response streams and fake transports; no live source was fetched.
Product wiring remains separate. The helper is not intended for authenticated
provider APIs, signed-header requests or general-purpose browser navigation.
