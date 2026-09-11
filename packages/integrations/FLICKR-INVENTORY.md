# Shared Flickr inventory and confirmation

The optional `albums` argument distinguishes an omitted snapshot (`undefined`,
retain saved albums on photo continuation) from an explicitly empty snapshot
(`[]`, replace the saved provider album list). This does not delete local content.

`FlickrInventoryService` owns inventory page merging, publication observations,
provenance, saved collection reconciliation continuity, migration selection and
confirmation checkpoints. Applications supply a `FlickrRepository` and a required
`FlickrReferenceMaterializer` callback. The callback may set canonical mappings on
the migration before confirmation is persisted. Provider communication, source
transfer, scanning, routes and content-store implementation are not built in.

Callers must authorize the actor and connection before invoking this service.
Storage confirmation is an input assertion, not a billing or quota authorization.
This extraction preserves existing behavior and state shapes, including separate
content and checkpoint writes. A failed callback prevents the confirmation write
but cannot roll back content side effects. Repository writes are not revision
fenced. The class does not guarantee complete multi-page inventories, enforce
worker deadlines, or bound accumulated photos and audit history. These remain
workflow hardening requirements, not guarantees provided by the extraction.
