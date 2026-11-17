# Retained preparation HTTP composition

`@ubeeq/runtime/content-preparation-http` registers the complete retained
preparation contract through a structural registrar. Native hosts retain their
authentication middleware, rich content store, upload/storage checks and release
drivers. The shared registration does not construct substitute stores or publish
through a default provider.

`@ubeeq/runtime/content-preparation-node` adapts that registration to Node HTTP.
It serves `/studio/content/*` and the retained `/api/studio/content/*` alias.
It resolves a verified, unexpired creator session before reading the request
body or constructing services. Customer sessions cannot use these routes.
JSON object bodies default to a 16 MiB limit; hosts may configure a limit from
1 byte to 128 MiB. Reviewed media retains its bytes, MIME type, private caching,
attachment disposition and `nosniff` header. HEAD returns headers without bytes.

`createCoreRuntime({contentPreparation: context => bindings})` mounts the Node
adapter. The factory receives the actual adapters, resolved extension ports and
instance/cell/region. Core checks its configured tenancy before calling the
host's access callback. Hosts must supply the actual preparation service,
release driver and capability inventory. Optional upload adapters remain
unavailable when absent; they are never silently replaced.

Preflight access is not commit authority. The supplied service and release
drivers must join canonical writes, receipts, source checks, current membership
and policy evidence in their durable conditional transaction. Recovery must use
the accepted actor and current permissions. The factory must bind the retained
rich authority; it must not introduce a second writer or flatten advanced
content into a smaller record model. Its optional `close()` runs when the core
runtime closes. Worker recovery remains the retained host's responsibility.

The Node adapter is optional for hosts that already register through their own
transport. The existing native transport uses the same shared registration with
its established authentication, upload and release implementations.
