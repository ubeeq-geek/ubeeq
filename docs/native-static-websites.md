# Native static websites

Status: native export foundation implemented; **not yet the complete initial export release**.
The shared renderer, authorized build/export lifecycle, durable local storage,
private API and reusable editor workspace are available. Do not advertise the
entire supplied specification or managed deployment as complete.

## Repository mapping

| Specification concept | Implementation |
| --- | --- |
| Workspace and publishing identity | Existing `WorkspaceMembership`, `membershipAllows`, product-supplied identity validation |
| Website, pages, selection settings, destinations, redirects | `packages/core/src/websites.ts` |
| Authoritative content document | Existing `ContentBlock` / `StoredPostBlock` tree, `WebsiteDocument` revision; one document can serve several pages |
| Existing Work/publication/catalogue | Trusted `resolveSnapshot` port; no second gallery catalogue is created |
| Website-specific gallery title/path/destination | `Website.gallerySettings`, keyed by the exact selected publication ID |
| Block editor | Existing `BlockEditor`, extended with optional website context and six website blocks |
| Pure static rendering | `packages/ui/src/website-renderer.ts`; shared between export and candidate preview |
| Editor workspace | `WebsiteWorkspace` from `@ubeeq/ui/react`, `WebsiteClient` from `@ubeeq/ui` |
| Snapshot, media projection, artifact validation, ZIP | `packages/portability/src/website-artifact.ts` |
| Authorization, policy, jobs, audit and private access | `WebsiteService`; trusted application ports are mandatory |
| Durable records/artifact contract | `WebsiteStore` in persistence; CAS writes and workspace-scoped keys |
| Local storage | `SqliteWebsiteStore`, separate private SQLite database under the local data directory |
| Reference API | `/v1/websites`, normal bearer-session authentication, existing durable job queue and worker |
| Product composition | Supply `WebsiteServicePorts`; optional `ReferenceApiConfiguration.websiteService` replaces local reference composition |
| Managed publication | Versioned adapter/capability interfaces only; no provider, target API, activation coordinator or rollback implementation |

The local reference maps its existing personal Creator to a personal website
workspace. It does not invent organization onboarding. Other ownership models
must supply current membership and creator-identity validation through the
service ports. The current public repository contains no consuming product
applications; their registrations, executable policies, quotas and credentials
must live in those applications, independently of this package.

## Using the API

Create a creator using the existing authentication/profile flow. Then:

1. `PUT /v1/websites/documents/:id` with `{document, expectedRevision}`.
   A document uses `{id, workspaceId, revision, blocks}`. New records use expected
   revision zero and stored revision one. Stored legacy blocks are normalized
   using the existing parser, after strict static-support checks.
2. `PUT /v1/websites/:id` with `{website, expectedRevision}`. Save the referenced
   documents first. Exactly one ready Home, safe routes, workspace ownership and
   the two editorial levels are checked. All settings/pages are one CAS write,
   so reorders/reparenting commit atomically.
3. `POST /v1/websites/:id/builds` with `{expectedRevision, idempotencyKey}`.
   Returns a queued private build. Reusing the key with another revision fails.
4. Run the normal reference worker. It leases `website.build` jobs, rechecks
   current authority, resolves sources, evaluates policy, renders and packages.
5. `GET /v1/websites/builds/:id` returns private state, dependencies, warnings,
   staleness, diagnostics code and output-validation report.
6. `GET /v1/websites/builds/:id/preview?inline=1` returns a self-contained HTML
   preview. Display it in an iframe with an **empty sandbox attribute**. The
   normal authenticated file interface is `preview?file=index.html` (or another
   artifact-relative file). Preview responses are private/no-store, sandboxed
   and have no execution or authenticated editor-session access.
7. `GET /v1/websites/builds/:id/export` downloads the exact ZIP after current
   owner/manager export authorization, policy, eligibility and digest checks.
   A new draft does not change bytes in a previous candidate. Invalidated,
   expired, missing or corrupt artifacts cannot be downloaded.

Other reads: `GET /v1/websites`, `/v1/websites/catalogue`, `/v1/websites/:id/builds`, `/v1/websites/builds/:id/pages`, `/v1/websites/capabilities`,
`/v1/websites/:id`, `/v1/websites/documents/:id`. Document reads include a
`sharedBy` list so an editor can explain affected destinations.

The workspace comes from the authenticated session, never a request-selected
principal. Credentials do not appear in snapshots or public files. The default
reference limits are 200 output HTML pages (including generated pages and 404),
500 supplied assets, separate 50 MiB source-projection/output budgets and seven-day download retention. The store's
`removeArtifact` hook supports deployment-owned cleanup; expiration rejects
access even before physical cleanup. A background garbage collector is not
installed by this change.

## React integration

```tsx
import { WebsiteClient } from '@ubeeq/ui';
import { WebsiteWorkspace } from '@ubeeq/ui/react';

// Memoize the client; keep the session credential in the existing session layer.
const client = new WebsiteClient(websiteId, () => sessionToken);
<WebsiteWorkspace client={client} mediaOptions={authorizedEditorMedia} />;
```

The workspace offers Pages, Appearance, Gallery destinations, Preview and
Publishing. It injects the existing long-form BlockEditor rather than storing a
second rich-text format. Its framework-neutral equivalent accepts an editor
mount callback. New websites/Home documents are created with the API above;
the component manages an existing website. The reference web app mounts this React workspace at `/websites`, with website
creation and an authorized publication catalogue. Consuming applications can
mount the same component in their existing creator tools.

## Static block compatibility matrix

The exhaustive, exported `STATIC_BLOCK_SUPPORT` table is authoritative. Unknown
required blocks are rejected **before** the ordinary import parser can omit them.
Child content on a leaf block is rejected rather than silently discarded.

| Existing block | Static behavior |
| --- | --- |
| paragraph, heading, quote | Escaped text or existing allowlist-sanitized inline HTML; generated heading fragments |
| divider | Semantic horizontal rule |
| section, grouping | Nested semantic section / responsive ordered group |
| image | Approved public rendition, alt text, dimensions, caption and ordinary image link |
| video, audio | Approved public media with native controls and ordinary-link fallback; no autoplay |
| file, pdf_preview | Approved public file download link; no iframe/document script execution |
| link, credit | Validated URL and public text/attribution |
| carousel | Ordered responsive media group with all content visible without JavaScript |
| embed | Labelled external link **only** with `data.staticFallback = "link"` explicitly accepted |
| html_fragment | Required block errors; convert to structured content before exporting |
| gallery_preview | `data.publicationIds` containing exactly one selected publication |
| premium_promotion | Exactly one selected publication; public previews or text-only promotion, external access link |
| selected_portfolio | Ordered `data.publicationIds`; the same destination resolver as every gallery block |
| gallery_list | Explicitly selected eligible pool, optional tags/collectionIds/publicationIds filters, sort, maxResults, static pageSize |
| update_list | Ready update pages ordered by date and stable ID, static pagination |
| page_link | `data.pageId` resolves a ready page's current route |

Query sorts: `newest` (default), `oldest`, `title`; ID breaks ties. Maximum
results is 1–1000, page size 1–100. `data.empty = "omit"` omits an empty query;
otherwise `emptyMessage` or a neutral message is displayed. No live query APIs
or client clock release gates enter public output.

## Snapshot/media adapter requirements

The renderer never queries storage or fetches user URLs. `resolveSnapshot`
must pin the authoritative source revisions, return only the explicitly selected
publication pool, exclude future/restricted sources, apply approved filtering
semantics and supply the public projection of each selected presentation.
Publication mappings must match publication, destination instance, account and
Space exactly. Matching a Work or sibling publication is insufficient.

`WebsitePublicAsset` is a **trusted server-side rendition attestation**, not a
request-body schema: `approvedPublic` and `metadataStripped` must come from
rights/moderation and rendition processing. Bytes are SHA-256 checked. The
builder bundles only required assets, deduplicates by digest, rejects unsupported
active media types such as SVG/HTML, and never falls back to linked media on a
quota failure. Linked media is explicit and must use a stable public URL without
credentials or signed/token query parameters.

The ordinary reference processing path copies source bytes and does not prove
metadata removal. The website snapshot adapter therefore uses the existing Sharp
image decoder to create a bounded, upright JPEG without source metadata. It
caches that clean rendition in private workspace-scoped SQLite storage, keyed by
asset/source checksum and recipe version. Each build still checks current
publication/asset ownership and holds before using the cache. The reference
local-publication presentation is the same public selection exposed by its
existing public Work endpoint. Its public catalogue exposes eligible local
publications for deliberate website selection. Original storage objects, EXIF,
private filenames and tokens do not enter the artifact.

The reference adapter supports bundled images and live local publications.
Other media types, stable linked delivery and connected/premium source catalogues
require a trusted product/deployment snapshot adapter. The shared renderer and
artifact pipeline support those source projections, including distinct public
preview and premium presentations of the same Work, as exercised by the contract
fixtures. No source is promoted to public merely because the renderer supports
its media type.

`dependenciesEligible` must distinguish revoked rights/holds from ordinary newer
drafts and examine the exact pinned dependencies at execution/download time.
`dependenciesCurrent` optionally adds catalogue/media/theme staleness detection;
the service itself compares site and document revisions. Call `invalidate` for
rights/withdrawal events to stop future access to affected artifacts. Downloaded
ZIPs cannot be recalled. Managed takedown requires an actual deployment adapter.

## Output and verification

Public output contains HTML, one local stylesheet, required public media,
sitemap, robots, 404 and deployment README. Public output never serializes the
snapshot, private dependency index, internal record IDs, diagnostics, policy
evidence or workspace backup. ZIPs use stable lexical ordering, fixed DOS epoch,
UTF-8 paths and no changing timestamps. URLs use canonical NFC/lowercase path
segments; percent-authored paths, traversal, separators and reserved filenames
are rejected. Unicode archive filenames are decoded while HTTP paths are encoded.

`packages/portability/test/websites.test.mjs` verifies real ZIP inspection,
determinism, all block declarations, two-level hierarchy, cross-workspace
references, exact publication mappings, premium/unclean media rejection,
static query pagination, root/subpath/Unicode serving over HTTP, revocation,
holds, pinned old candidates, broken links/fragments, quota limits and removal
of obsolete files during clean rebuilds. The reference API integration verifies
authenticated persistence/build/download, preview isolation, local gallery image
decoding with EXIF removal, and denied access after a hold or from another creator.

Run `npm run build`, then `npm test` in a runtime that allows localhost servers.
The tests return per-artifact checks and page/media/byte/file counts. Their
automated coverage does **not** establish manual WCAG 2.2 AA, screen-reader,
mobile or keyboard acceptance; focused browser review is still required.

The runnable fixture in `examples/static-websites/export.mjs` produces six HTML
pages, one bundled metadata-clean image and twelve files (8,385 public bytes).
Its ZIP passes archive integrity inspection; its private report records all
seven output checks listed above. The private report stays outside `site/` and
outside the ZIP. See `examples/static-websites/README.md` to reproduce it.

## Remaining release work / explicit limitations

- Consuming applications still supply catalogue, public-preview approval and
  executable policy integration. The local reference implements local public
  galleries with metadata-clean image renditions and mounts the shared editor.
- Further theme variants such as crop/density controls and custom developer
  themes. Current theme supports title, logo, favicon, social preview, footer,
  light/dark/system, reading/wide widths, system/serif fonts, external header/footer
  links and an accent token validated for 4.5:1 canvas contrast.
- Richer child-resolution workflows and navigation editing. The workspace
  supports explicit document duplication, page lifecycle/SEO, redirect mappings,
  reparenting and reorder; domain errors require children to be resolved first.
- Dedicated resource-isolated build workers, coordinated cache/retention cleanup,
  debounced event-driven/scheduled rebuilding and product usage metering. Current
  explicit builds use the existing durable queue and bounded full-site generation.
- Deployment targets, desired-generation activation CAS, ambiguous-outcome
  reconciliation, secrets, recovery, rollback and managed withdrawal. All adapter
  capabilities remain unadvertised until provider acceptance tests exist.
- Consuming product registrations and executable policies in their separate
  repositories; no product enum, brand switch or shared credential boundary was added.

The public export path is separate from existing portable editing/workspace
backup exports. Static servers need no Ubeeq instance. Manual ZIP download is
audited as **Exported**, never as a confirmed live release.
