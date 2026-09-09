# Flickr album page primitives

`FlickrClient.albumsPage(credentials, page, perPage = 100)` and
`albumPhotoIdsPage(credentials, albumId, page, perPage = 100)` each issue one
provider request using the existing bounded transport. Page sizes are 1–500.
They validate returned page/count metadata, item identities, duplicate IDs within
the page and the requested album identity. Provider order is retained.

These primitives support persisted worker continuation. They do not themselves
schedule jobs, checkpoint pages or prove a consistent snapshot across provider
changes. Existing `albums` and `albumPhotoIds` convenience methods remain unchanged
and still walk the full catalogue. Consumers must migrate to these page APIs to
gain bounded album work; adding the methods alone does not change their runtime.

`initialFlickrAlbumInventory` and `advanceFlickrAlbumInventory` provide a cloned
checkpoint state machine for album-list and membership pages. Each advance makes
at most one page call. Applications must authorize, persist and revision-fence
the result. Cross-page duplicate IDs fail rather than silently corrupting order.
The accumulated snapshot is still held in memory; total size limits, provider
snapshot consistency and automatic scheduling are not supplied by this helper.
