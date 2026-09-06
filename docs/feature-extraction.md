# Shared feature extraction

## Review checkpoints

Commit and push each tested, coherent feature slice before starting another.
Keep an open review PR updated with test results, unresolved limitations, and
cross-repository dependencies. Do not let passing local work accumulate across
multiple slices without a remote checkpoint. Work-in-progress checkpoints must
be labelled as draft and must not be described as merge-ready.

Publish shared changes first, then pin consumer compatibility manifests to the
exact published commit. Merge shared prerequisites before their consumer PRs;
if squashing changes the shared commit, update and revalidate consumer pins.
Review branches do not authorize deployment or production qualification.

The current priority is development-mode feature parity. The open core owns reusable behavior; consuming applications own branding, commercial terms, eligibility decisions, discovery policy, and enabled connector catalogues.

Cloud deployment hardening follows local feature parity. Authentication boundaries, atomic persistence, durable jobs, provider-independent services, and explicit product policy are architectural requirements during extraction.

Features are complete only when a consuming application executes the shared implementation through a package contract and its behavioral tests pass. A compatibility manifest alone does not establish feature parity.

## Initial integration slice

`@ubeeq/integrations` supplies normalized reconciliation, failure recovery, and
sync checkpoint advancement. Optional connectors supply provider identifiers and
normalized observations. Product adapters map legacy publication records and
choose which fields must be excluded when creating detached copies.

The checkpoint tests cover overlapping pages, preservation of the high watermark,
incomplete walks, and ambiguous external writes. Consumers should exercise these
functions through installed package imports, with explicit policies and provider
adapters around them.

## Creator content storage slice

`@ubeeq/persistence` exposes `CreatorContentStore` and a generic
`MemoryCreatorContentStore` reference implementation for the existing tenant,
creator, Work, asset, collection, publication, intent and discovery storage keys.
Its generic record family preserves consumer-specific metadata without putting
product policy into persistence. This compatibility port does not replace the
revisioned cell repositories or imply that the memory reference is durable.
Scalable adapters and callers still need a paginated contract and transaction
boundaries as their behavior is migrated.

The reference adapter retains enumerable arrays for existing local snapshots.
Publication writes invoke an overridable validation hook before replacing state.
`@ubeeq/core` supplies the reusable append-only disclosure history checks, while
consumers define disclosure contents. Shared content lifecycle vocabulary and
content availability are also consumed through the core package.

## Creator collection operations

`@ubeeq/core` now provides `CreatorCollectionService` through a storage-independent
port. It implements listing, creation, updates, soft deletion, and ordered Work
membership replacement. Every operation requires an actor-bound authorization
callback; products continue to parse inputs, choose metadata, and enforce their
own creator access policy. Consumer HTTP routes execute these shared operations.

Creation and renaming both check current and historical slugs. Renames preserve
history. Membership is deduplicated in order and fully validated before writing;
missing, deleted, other-tenant and other-creator Works are rejected. This does not
establish atomic slug reservation under concurrent writers, nor protect against
concurrent ownership/status changes between validation and membership writes.
Versioned transactional storage remains required for those guarantees. Public
collection delivery, cover-asset policy and the reusable UI are still separate
migration work, not covered by this service slice.

## Creator Work operations

`CreatorWorkService` in `@ubeeq/core` now owns authorized Work listing/search,
lookup, draft creation and revision bookkeeping. It preserves slug history and
immutable ownership, increments revisions, and manages archive/delete timestamps.
Consumer callbacks interpret editable product fields, including provenance;
publication and discovery are deliberately independent operations. Editing
callbacks receive a cloned record so rejected edits cannot mutate an in-memory
adapter by reference. Consumer route tests execute the installed service.

Shared edits now require `commitWorkRevision` with the previously read revision;
the memory, SQLite and private cloud compatibility paths implement that condition.
Stale edits cannot silently overwrite attachments committed at a later revision.
Legacy `updateWork` callers remain outside this guarantee. Slug reservations still
depend on the adapter; combined creation/discovery persistence, asset processing,
enriched/public Work views and cross-product UI parity remain unfinished.

## Local library consumer

The local adapter now exports `LocalCreatorLibraryStore` for the compatibility
Work/collection services. Its SQLite rows are indexed by cell, tenant, record kind
and owner. Ordered membership replacement is a single SQL statement; Work updates
require the stored prior revision and return a typed conflict. The second private
consumer now executes these services through an authenticated local HTTP library,
with a separate creator repository and explicit admission policy. Restart tests
exercise persisted sessions, Works and collection membership. This narrow adapter
does not implement publications or the entire `CreatorContentStore` port,
or collection revision control. Its SQL mutations now atomically reject conflicts
with current and historical slugs in the same cell/tenant/creator and record kind.
Deleted records release their aliases; restoration must reacquire all of them.
Two-connection tests cover concurrent creation, rename conflicts, and restoration
after an old alias was reused. This guarantee is local-adapter-specific; other
compatibility adapters still need equivalent atomic behavior.

## Media credential diagnostics

The processing package now supplies bounded Content Credentials marker inspection
for media preflight. It accepts byte views, scans at most 2 MiB, reports truncation,
and returns `verification: "not_performed"`. Candidate AI markers are diagnostics,
never authenticated provenance. Generic creation/editing actions are not AI
indicators; see the [C2PA action specification](https://spec.c2pa.org/specifications/specifications/2.3/specs/C2PA_Specification.html).
The consuming upload route stores diagnostic metadata without assigning asset
provenance. Actual manifest/signature/trust verification remains to be implemented;
the scan must not be used to make eligibility or disclosure decisions.

## Request identity resolution

`@ubeeq/auth` supplies `createRequestIdentityResolver` for credential selection.
Verified-provider mode never falls back to a development identity on missing,
malformed or rejected credentials. Development mode is opt-in at composition time,
not selected by request headers. Both private consumers now use the resolver;
provider claim mapping, hosted/local mode selection and role policy stay private.

## Editor block normalization

`parseContentBlocks` now normalizes the editor tree shared by both consumers.
`parseStoredPostBlocks` retains existing `blockId/mediaId/payload/blocks` storage
keys while the portable result uses `id/assetId/data/children`. The parser preserves
file references, optional section payloads, nested content, bounded post text and
unbounded Work text. Generated nested IDs include their parent path; supplied IDs
are preserved. Runtime route tests cover both stored formats and local restart.
This is structural normalization, not HTML/URL sanitization or publication policy.
Depth/resource validation, renderer extraction and editor UI remain unfinished.

## Private original attachment

`CreatorAssetService` now owns authorized attachment of a stored private original
to a Work. Its port requires an atomic asset/attachment/revision commit; there is
no sequential-write fallback. `LocalCreatorLibraryStore` implements this using a
synchronous SQLite transaction with a previous-revision check. Failure-injection
tests prove all metadata rolls back and concurrent attachments cannot overwrite
one another. The local consumer provides raw source upload and owner-only download
with checksum verification. Sources remain pending processing, never implicitly
published. External object writes are not part of the database transaction, so
orphan recovery is still required. The other private consumer now also uses this
service, supplying explicit validation for its existing hosted-asset shape. The
default validator continues to require the private original format. Shared memory
persistence stages all three records before synchronous replacement; the private
cloud compatibility adapter submits one conditional DynamoDB transaction retaining
its persisted keys/indexes. Tests verify request construction, not a live cloud
deployment. Legacy connector mirrors and other Work mutation paths remain outside
this transaction contract; durable processing/renditions are unfinished.

## Media-reference normalization

Media-reference normalization is shared through `parseContentMediaReferences` and
its stored-Post conversion. Credits, captions, ordering and comparison-item metadata
are preserved in both field formats. Consumers explicitly select their discovery
default; the portable default is false. Post create/edit routes and the second
consumer's Work editor execute the shared code, with restart coverage for references.
Reference existence/ownership, public exposure and URL/rendering safety are not
conferred by this parser and remain separate migration requirements.

## Local processing queue prerequisite

Before connecting the pending-source processing worker, the local queue claim was
made atomic with a single SQLite update/returning statement. Concurrent enqueue
resolves a winning idempotency key instead of surfacing a uniqueness race. Expired
tokens cannot complete/retry/dead-letter jobs; expired-lease recovery is cell-scoped
and exhausted attempts dead-letter automatically. Six independent worker
connections exercise the enqueue/claim race. This does not fence external side
effects by itself: processing-result commits must also check their lease/source
version. The media worker and equivalent cloud queue fixes remain unfinished.

## Decoded image previews

The optional `@ubeeq/media-sharp` adapter now supplies actual image decoding,
orientation correction and JPEG preview generation. A private consumer uses it
for fitted Work thumbnails and cropped import thumbnails; dimensions, cropping
and quality remain consumer choices. The default input budget is 40 million
pixels. Consumer storage still retains the original when preview creation fails.
Tests exercise real image bytes, invalid inputs, the pixel limit, both recipes
and immutable source-version lineage, plus shared invocation from an upload route.
The processor returns transient rendition bytes for a worker to store separately;
it does not itself persist outputs, validate provenance, or implement a durable
processing workflow. The second consumer's worker remains outstanding.

## Atomic local image scheduling

The local creator-library adapter can now opt into image job scheduling. Image
attachment metadata, Work revision and a `creator-asset.process` job commit in
one synchronous SQLite transaction. Job payloads retain tenant, creator, Work,
asset and immutable source-version identity. Queue failure rolls back attachment
and revision changes, and jobs remain leasable after database reopening. The
private local consumer enables this option. Non-image uploads remain source-only;
MIME declarations select work but are not evidence of successful decoding.
Worker execution, fenced rendition commits and delivery remain unfinished.

## Fenced local processing results

The local processing result boundary now commits stored rendition references and
job completion together. It verifies the unexpired lease token, cell, full job
scope, current immutable source version, Work ownership and attachment. Stale
workers cannot attach results after a replacement lease; failure completing the
job rolls back asset processing metadata. Only references are retained, not
transient rendition bytes. Processing completion leaves publication/safety status
unchanged. Tests cover expiry, replacement, source changes, scope mismatch,
rollback and restart. Worker orchestration and preview delivery remain pending.

## Shared creator-asset worker

`CreatorAssetWorker` now executes one durable image-processing attempt through
queue, asset, object-storage and processor ports. It verifies source size/hash
and version, stores private attempt-specific rendition objects, and uses the
fenced atomic commit. Failed attempts retry up to the job budget and then
dead-letter; ambiguous commits retain objects for later reconciliation. A private
local launcher polls this worker without overlapping attempts. Real image upload
tests verify processing after restart and persisted JPEG references; invalid
image bytes exercise retry exhaustion. Processing remains independent of safety
approval or publication. Protected preview delivery and orphan reconciliation
remain unfinished, as do equivalent cloud adapter semantics.

## Private rendition selection and delivery

Core now selects only completed private renditions whose source version still
matches the original. The private local consumer authorizes the owning Work and
attachment before reading a preview; deleted Works, foreign owners, wrong-Work
references and stale outputs are rejected. JPEG-only inline responses verify
stored length/hash and use private/no-store and nosniff headers. Tests cover
unauthenticated and cross-user requests, mismatched Work IDs, corrupted output
and deletion. This owner-only route does not grant public delivery or implement
the creator UI, and does not claim hosted safety-policy integration.

## Worker failure recovery

The shared worker also checks returned asset tenant/ID before object reads and
validates the complete output set before writing: unique IDs, immutable source
lineage, supported rendition roles, byte counts, a 16-rendition maximum and a
configurable total output byte budget (50 MiB by default). Failure tests cover
storage errors, exhausted attempts, rejected stale leases and ambiguous completed
commits. Retained unreferenced objects still need reconciliation; these checks
do not implement garbage collection or authorize deletion.

## Creator membership compatibility service

Core now supplies authorized member listing, addition and removal through a
tenant-bound storage port. The first private consumer's studio routes execute it
while retaining role parsing and read-versus-account-management authorization.
Tests verify shared invocation and preserve editor read access without granting
membership management. This extraction preserves existing direct membership
writes; it does not implement invitation acceptance, account existence checks,
atomic last-owner protection or delegation in the second consumer. Those remain
required work, not production-only hardening.

## Durable local delegation

The local adapter now provides a tenant-bound creator-member store using
cell/tenant-scoped keys. The second private consumer composes the shared service
for direct grants to active local editor accounts. Its original authoritative
owner remains separate and cannot be replaced by a membership grant; only that
owner administers delegates. Granted editors can access creator content and
private previews, but cannot manage members. Restart and revocation tests cover
the real HTTP composition, with separate tenant/cell isolation checks. Invitation
consent, ownership transfer, concurrent revocation/write fencing, and hosted
delegation policy remain unfinished.

## Atomic local collection membership validation

The SQLite compatibility adapter rechecks collection existence/status, Work
ownership/status, uniqueness and ordering within the same transaction that
replaces membership. A second-connection test deletes a Work after the service
reads it and verifies the commit rejects it without losing existing membership.
Injected write failure also preserves the previous order. This local guarantee
does not provide collection revision conflict detection or cloud-adapter parity.

## Local asynchronous transaction ownership

Independent transaction callbacks now serialize per connection, with ownership
tracked by asynchronous context rather than a shared nesting counter. Standalone
queries and prepared statements from unrelated contexts fail while a transaction
owns the connection; callers can retry or use a separate connection. Genuine
nested callbacks share identity, and any nested failure makes the transaction
rollback-only. Descendants executing after completion cannot reuse the context.
Synchronous library transactions remain non-yielding. External object writes
remain outside SQLite atomicity, and cloud transaction parity is still pending.

## Remaining slices

Creator content and membership, durable media processing, collections and
publication, optional provider connectors, community mechanisms, safety and
provenance, accounting, regional adapters and reusable UI must each reach behavior
parity. Preserve existing local contracts and add missing behavior through services
and ports. Keep branded decisions out of these packages.

Production deployment qualification follows development parity. Correct
authorization, transactions, job recovery, bounded queries and explicit adapter
boundaries are required before declaring their respective implementations ready.
