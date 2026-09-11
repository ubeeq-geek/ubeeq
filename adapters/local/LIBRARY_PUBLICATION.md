# Publishing existing local library records

`LocalLibraryPublicationView` supplies the Work and asset ports consumed by
`PublicationService` from `@ubeeq/api`. Create a fresh view for one authenticated
request, bound to a server-resolved tenant, Creator and Work. The view is not an
authorization service: the publication service still requires both ownership and
product admission callbacks.

The library remains the source of truth. Work IDs, revisions, body, slug history,
primary selection and asset IDs are preserved; no shadow Works or assets are
inserted into the generic repositories. Cell ownership is projected from the
current canonical Creator. Intent, publication and audit records use the existing
cell-owned repositories. Their writes and the library Work status/revision update
share the same SQLite transaction. The admitted library/Creator/asset snapshot is
rechecked at the status update; a changed source, membership or Work causes all
publication writes to roll back. This does not transactionally fence external
policy services or membership repositories.

The required `selectRendition(asset)` callback returns a persisted rendition ID,
not an object reference supplied by an HTTP client. No selection means not ready.
Only a completed, current-source, private stored rendition is projected as ready.
The original object's storage reference is never included in that asset projection.
Selecting a video poster publishes that poster, not a playable video; products must
not claim media parity from previews alone. Original audio/video/document delivery
needs a separately qualified processing and selection contract.

This is an integration building block, not an enabled public endpoint. Consumers
must also implement public response projections, destination restrictions,
withdrawal/current-policy revalidation and protected object delivery. The reference
API's canonical public routes and exports do not automatically read this library
view. Keep them separate until explicitly composed against the same source of truth.

The view paginates its selected assets but currently materializes the bound Work's
membership, matching the compatibility library. Large-work limits/indexed paging,
cloud implementations and export/import integration remain outstanding.

The integration test in `apps/reference-api/test/library-publication.test.mjs`
exercises the real publication service and SQLite storage: denied admission,
scope isolation, stale processing, complete paging, snapshot races, final-write
rollback, identity preservation and durable replay after reopening the database.
