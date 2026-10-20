# DeviantArt galleries

The integrations package exports `deviantArtGalleryCreateForm` and
`deviantArtGalleryPublicationForm`. Hosts provide OAuth transport, authorization,
durable publication jobs and receipts. These functions make no network requests.

Creation supports a regular folder name, optional description, and optional parent
folder UUID for a sub-gallery. Hosts must verify that the selected parent belongs
to the authenticated account and is a regular top-level gallery. DeviantArt checks
Core membership and account limits. Invalid names are rejected rather than truncated.

Premium and Watchers-Only creation are explicitly unsupported by this adapter:
the documented OAuth creation endpoint exposes no visibility or price fields.
Requests for either type throw before transport. Products should link to the
account's DeviantArt gallery manager, then synchronize the resulting folders.
Do not claim an OAuth-created regular folder restricts access.

Publication emits an explicit `feature` boolean independently from `galleryids[]`.
Use no folder IDs and `true` for Featured-only, folder IDs and `false` for gallery-only,
or folder IDs and `true` for both. Folder IDs can identify regular galleries or
sub-galleries; provider validation remains authoritative for restricted destinations.
No gallery and Featured disabled is rejected. The default preserves DeviantArt's
existing Featured-on behavior. The `feature` field applies to new Sta.sh publications;
the documented deviation edit endpoint does not expose that field.

Provider references checked October 20, 2026:

- [Gallery creation](https://deviantart.readme.io/reference/gallery_folders_create)
- [Sta.sh publication](https://deviantart.readme.io/reference/stash_publish)
- [Deviation editing](https://deviantart.readme.io/reference/deviation_edit)
- [Gallery and sub-gallery eligibility](https://www.deviantartsupport.com/kb/en/article/how-do-i-create-new-galleries-and-sub-galleries)
- [Premium gallery setup](https://www.deviantartsupport.com/kb/en/article/what-are-premium-galleries/)
