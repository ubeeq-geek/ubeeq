# Professional publishing foundation

Ubeeq provides product-neutral workspace authorization and server-side Facebook Pages and LinkedIn Posts API building blocks. Private and self-hosted products supply persistence, UI, credential vaults, provider registrations, review status, and policy; no managed-service secret or approval is bundled here.

`Workspace` is the ownership/isolation boundary, while creator identity and credits remain separate. `ProfessionalPublicationRevision` selects ordered preview renditions and an exact external author. `AuthorizationGrant` stores only an opaque credential reference. `publicationExecutionBlocks` rechecks membership, resource scope, target-specific grant, expiry, and exact-revision approval immediately before dispatch.

`FacebookPagesClient` deliberately supports Page discovery plus text/link and one image-preview post. It does not claim personal-profile, Group, carousel, video, read, edit, delete, analytics, or scheduling support. `LinkedInPostsClient` uses the versioned `/rest/posts` endpoint; organization authoring remains disabled until explicitly enabled by a deployment with approved access.

Both adapters reject redirects, bound responses, set deadlines, and represent unverifiable writes as `outcome_unknown`. Workers must not blindly retry those writes. Hosts must validate exact scopes, API versions, App Review/product access, and intended non-administrator accounts before release.

Hosts must migrate existing owners without changing IDs or URLs, persist all records under workspace keys, keep tokens in a vault, show the exact author and target before publishing, never substitute protected originals for previews, persist intent before dispatch, isolate each destination in its own job, and never reactivate credentials, memberships, approvals, or jobs during import.

## Review and execution contract

Hashing and execution checks are asynchronous (`professionalPublicationHash`,
`approvalMatches`, `publicationExecutionBlocks`). They use standard Web Crypto,
so the core barrel remains usable in browser builds. Canonical payloads bind
workspace, Creator, exact remote author, caption/link, ordered Work revisions,
rendition IDs and alternative text. Display-label changes and JSON property
order do not invalidate an otherwise identical approval. Duplicate item
positions and invalid revisions are rejected. Items without a rendition are
link references only; they never authorize an original or media upload.

Grants bind target **kind**, application deployment, current scopes and valid
expiry as well as target IDs. Hosts must supply the expected
`applicationDeploymentId`, recheck the current grant authorizer and approver,
and pass authoritative membership records at execution. A LinkedIn member
must match the grant's external principal. Unknown local roles are denied.
Text-only publications are supported without pretending to select an Asset.

Page discovery offers `pagesPage` with a safe cursor. The convenience `pages`
method collects at most ten pages and fails explicitly instead of silently
truncating. It never follows provider-supplied pagination URLs with a token.
Page creation requires current CREATE_CONTENT/MANAGE task access. A photo's
`post_id` is the publication identity; its `id` is only a media receipt.
Missing publication identity remains an unknown outcome, never a retryable
successful-media checkpoint.

LinkedIn articles require an explicit title; URL scraping is not assumed.
Successful creation requires HTTP 201 and a share/ugcPost receipt. Organization
publishing remains separately gated and requires current organization roles,
product access and `w_organization_social`; the flag is not proof of those
grants. See [LinkedIn Posts](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api),
[token introspection](https://learn.microsoft.com/en-us/linkedin/shared/authentication/token-introspection),
[member identity](https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/sign-in-with-linkedin-v2),
and [Facebook Pages](https://developers.facebook.com/docs/pages-api/posts/).

Provider response and network/body deadlines are bounded. Unverifiable writes,
including malformed 5xx responses, stay `outcome_unknown`. Public URL admission
rejects private/special-use literals, userinfo and fragments. A public-looking
HTTPS URL alone is **not** proof of derivative provenance or safe DNS: products
must validate retained rendition records, sharing policy and any signed/private
original URLs before giving them to a provider.

`verifyToken` provides an optional approved-pilot connection path for existing
application-issued tokens. Facebook checks the app, USER principal, scopes,
expiry and current Page task inventory; LinkedIn checks app-bound 3-legged
introspection and member userinfo. No token or scope supplied by a client is
trusted as an authorization assertion. These helpers do not register an app,
obtain platform approval, implement OAuth callback persistence, or refresh a
departed member's grant.
