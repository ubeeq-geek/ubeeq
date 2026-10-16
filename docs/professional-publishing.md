# Professional publishing foundation

Ubeeq provides product-neutral workspace authorization and server-side Facebook Pages and LinkedIn Posts API building blocks. Private and self-hosted products supply persistence, UI, credential vaults, provider registrations, review status, and policy; no managed-service secret or approval is bundled here.

`Workspace` is the ownership/isolation boundary, while creator identity and credits remain separate. `ProfessionalPublicationRevision` selects ordered preview renditions and an exact external author. `AuthorizationGrant` stores only an opaque credential reference. `publicationExecutionBlocks` rechecks membership, resource scope, target-specific grant, expiry, and exact-revision approval immediately before dispatch.

`FacebookPagesClient` deliberately supports Page discovery plus text/link and one image-preview post. It does not claim personal-profile, Group, carousel, video, read, edit, delete, analytics, or scheduling support. `LinkedInPostsClient` uses the versioned `/rest/posts` endpoint; organization authoring remains disabled until explicitly enabled by a deployment with approved access.

Both adapters reject redirects, bound responses, set deadlines, and represent unverifiable writes as `outcome_unknown`. Workers must not blindly retry those writes. Hosts must validate exact scopes, API versions, App Review/product access, and intended non-administrator accounts before release.

Hosts must migrate existing owners without changing IDs or URLs, persist all records under workspace keys, keep tokens in a vault, show the exact author and target before publishing, never substitute protected originals for previews, persist intent before dispatch, isolate each destination in its own job, and never reactivate credentials, memberships, approvals, or jobs during import.
