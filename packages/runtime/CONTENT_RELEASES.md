# Retained accepted content releases

`@ubeeq/runtime/content-releases` owns the complete retained release orchestration: exact review, saved-actor reauthorization, frozen media and offers, per-Work and per-Collection transactions with receipts, connected provider review/dispatch/cancellation, announcements, and restart recovery. Hosts must supply all real capabilities and the same canonical conditional transaction owner used by preparation. No default provider, identity, entitlement, policy or history is invented.

Generic record types retain the full authoritative host records and opaque file descriptors. New preview collections and authoring rows pass through typed host constructors. Native destinations and announcement bindings come from the actual host; existing persisted identifiers and aliases must remain unchanged. Provider-specific unsupported operations continue through their existing review flows.

This service needs the actual retained `release`, `release-receipt` and `representation` records in addition to preparation history. A preparation-only repository adapter cannot stand in for missing release history. Bind `tick` to the real durable worker and current access checks; do not create a parallel writer or infer empty histories. Extraction alone does not establish complete managed-runtime or three-product acceptance.

Hosts without durable release storage can still initialize unrelated routes. The service validates the actual conditional transaction, publication writer and active transaction capabilities when a release operation accesses them; missing capabilities return `503` before a release effect. It does not install a temporary or in-memory replacement.
