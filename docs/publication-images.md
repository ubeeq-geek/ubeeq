# Publication image selection and durable commands

Ubeeq supplies optional image configuration on existing Publications, one pure
resolver, immutable review contracts, durable preparation/configuration/delivery
commands, shared React controls, and disconnected image-history restore. No new Work,
original Asset bytes, or copy hierarchy is required. Missing settings inherit with
configuration revision zero. A preview label selects no variant and grants no access.

This is shared infrastructure. Product routes, watermark rendering/schema, membership
and commercial policy, existing gallery grouping/moves, provider workers and branded
Studio integration remain consumer responsibilities. Consumer compatibility and
activation must be verified separately against its actual dependency pin.
This change enables no new public provider capability by itself.

## Resolution and evidence

`@ubeeq/core` exports `PublicationImageSelection`, `resolvePublicationImageSelection`,
`comparePublicationImage` and `PublicationImageReviewSnapshot`. Variant, watermark and
collection context inherit independently. Explicit Original stays explicit; dormant
watermarks stay saved. The required watermark validator reuses the consumer's existing
schema. Ubeeq introduces no renderer, arbitrary source URL or alternative primary Asset.

Map server-loaded records into the resolver while preserving existing scopes/order:
Publication override; Work connection/default; collection connection/platform/default;
Creator connection/platform/default; platform fallback. Resolve collection context
first using explicit context or existing defaults-source/sole-membership rules, never
the first of multiple collections. Foreign/missing context, disabled optional variants
and unavailable media block dispatch. A requested context must match the saved context.

Use this resolver for preview, review, worker preparation, replacement and drift.
Include existing size and renderer/version settings in the recipe fingerprint. The
image fingerprint captures effective delivery settings; defaults hidden by overrides
and dormant watermark changes do not create image drift. The dependency fingerprint
also binds Publication identity/configuration revision. Source bytes, exact file,
metadata, galleries/access and verified principal are bound in the complete review.
Product adapters map comparable legacy rendition records into delivery evidence;
unknown/imported evidence must never be inferred from current defaults.

Drift distinguishes unknown evidence, unavailable configuration, source, variant,
size/recipe and watermark changes. Keep-image acceptance binds the exact desired
settings and observed evidence; it does not change saved configuration.

## Durable composition and policy

```ts
const repositories = createLocalPublicationCommandRepositories(database);
const commands = new PublicationCommandService(repositories, productPolicy);
```

`createDynamoPublicationCommandRepositories(client, configuration)` supplies hosted
composition. Both share ordinary authoritative `works`/`publications` storage and
add claim, operation and outbox buckets to existing generic records. SQLite uses
`BEGIN IMMEDIATE`; DynamoDB uses conditional writes and commit-time revision checks
in one regional transaction. Reservations never rely on secondary-index uniqueness.

The factories return ordinary repositories using the **same transaction coordinator**
so compatibility intents/assets/audits can join preparation. Do not use repositories
from a separately constructed DynamoDB coordinator with that transaction. Products
using separate external tables must supply an atomic implementation encompassing
those tables. Memory state or sequential JSON checkpoints cannot provide authority.

The mandatory `PublicationCommandPolicy` must implement these boundaries:

- `authorize`: current actor/Creator/Work/Publication authority, connection identity,
  feature gate and operation eligibility. Recording a dispatched result is independent
  of eligibility for new dispatch: later edits must not erase historical success.
- `validateSelection`: existing watermark schema, current collection ownership and
  membership, enabled variants and availability. Saving makes no provider call.
- `review`: the one resolver plus server-verified immutable files, checksums, metadata,
  gallery access, stable principal, source restrictions and safety policy. Browser
  checksums/file references establish no authority. A custom operation image retains
  its trusted approved file reference and remains subject to availability checks.
- Guard relevant Creator, connection, collection/membership, source, access and safety
  records with `checkRevision(id, revision, { transaction })`. Commands guard Work and
  affected Publication. Render ahead of the transaction if needed, then verify all
  relevant dependencies before acceptance. Do provider network work outside database
  transactions; admit its recorded observations inside them.
- `verifyRemoteResult`: canonicalize the provider's actual object namespace and admit
  verified evidence associated with this exact operation/principal. An arbitrary
  caller-supplied remote object is insufficient. `verifyFinalFailure` is required to
  declare a dispatched write definitely failed and permit fresh approval.
- `commitPreparation`: atomically add external/canonical compatibility rows, exact
  per-Publication intent, necessary Asset metadata and any proven singleton-intent
  rebinding. Preserve existing settings on reuse and dispatch no publishing job.

`checkRevision` is additive/optional for older repositories and mandatory for the new
commands. An unguarded read/write sequence is insufficient. DynamoDB permits at most
100 distinct items including condition checks; a guarded item cannot also be written.
Oversized preparation fails before mutation; split bulk work into bounded commands.

## Commands and worker contract

`prepare` takes the adapter's target key, exact intent, verified account, existing
gallery-derived Publication ID and stable request ID. Preserve regular/exclusive
gallery grouping. Equivalent requests recover the target without resetting settings;
changed intent under one request key conflicts. No publishing outbox is created.
Publication identity reservations survive row removal. Creation receipts do not
authorize moving a Publication back to a historical target.

`saveImageSelection` takes a full selection, expected configuration revision and
request ID. It patches only image settings, preserving concurrent remote observations.
A competing settings edit conflicts. Exact replays recover the original applied
revision without resetting newer settings. Copy/record CAS revisions remain separate.
`savePublicationImageSelectionBatch` requires explicit Publication IDs/revisions and
reports stable per-item outcomes and separate Work/Publication counts.

`reviewImage` produces a **private** snapshot/fingerprint. Project safe settings,
labels and evidence into reads; never expose its private file reference. `approve`
revalidates the fingerprint and commits operation, pointer, receipt, audit and outbox
together. A transport may return 202 after that durable commit during a queue outage.
`recoverPublicationOutbox` always resubmits the same operation identity after enqueue
failure or lost acknowledgement. Send explicit operation/Publication IDs and schema
version through the queue; never rebuild approval from latest defaults in a worker.

`beginDispatch` commits authority before returning approved inputs. The adapter **must
check `record.operation.state === 'IN_FLIGHT'` before sending**. Changed review returns
a cancelled operation needing review; unavailable files/context/policy fail closed.
Duplicate dispatch cannot begin again. Send precisely approved bytes, metadata,
principal, access and targets. Sibling setting edits do not invalidate this operation.
UPDATE snapshots must include the verified `remoteBinding` (provider namespace,
object type, ownership boundary and remote ID). CREATE snapshots must omit it.
Reviews and dispatch bind that identity; workers must use the snapshot binding,
never reload a different remote target after approval. Confirmed results retain the
full binding on the Publication and may not change an UPDATE's approved namespace.

`recordResult` requires worker identity and fencing generation. It records the old
snapshot's actual outcome while retaining newer desired settings. Remote claim,
canonical binding, evidence and audit commit atomically. Consumers must include
their external projections in their transaction-aware adapter implementation. Another
owner's claim produces durable ambiguous/audit evidence and an identity conflict.
Stale/expired workers append quarantined evidence without replacing current pointers.
Generic repository guards also protect snapshots, prepared identity and config revision.

An expired lease after dispatch or lost provider response requires read-back.
`beginReconciliation` advances the fence and grants no permission to upload again.
Uncertain writes cannot be called failed without evidence. No remote exactly-once
guarantee is claimed. Existing provider replacement capability/read-back remains
required; never delete/recreate implicitly or lose preserved discussions.
The current fenced reconciler may close AMBIGUOUS as FAILED only after
`verifyFinalFailure` accepts definitive evidence that the attempted write failed.
That closure permits a fresh review and approval; stale workers remain quarantined.

## Shared controls

`@ubeeq/ui/react` exports `PublicationImageControls` and
`selectPublicationImageModel`. The controls show account/galleries, saved effective
variant/provenance, unavailable choices, dormant watermark and last confirmed image.
Supply the existing watermark editor/schema. Errors preserve drafts, retries retain
their request key, duplicate submits are blocked and explicit reload adopts current
settings. Missing selected IDs never fall back to siblings.

`CreatorClient.publicationImageSelection` and `savePublicationImageSelection` target
GET/PUT `/studio/works/:workId/publications/:publicationId/image-selection`. Consumers
must install authorized handlers before using these methods. Preview delegates to
existing authenticated expiring delivery for saved settings; it never silently saves
drafts. Consumers retain normal reviewed publishing/replacement, bulk review and
branding (`brand.studioName`). There is no additional approval screen/duplicate button.

## Legacy adaptation, migration, portability and rollback

The older copy helpers/types remain compatible preparation primitives, not a separate
finished provider-publishing path. Old operation helpers refuse new image-aware
approval/dispatch; already-dispatched outcomes remain recordable. The local-only
withdrawal helper refuses managed external Publications, which require their ordinary
provider-aware reviewed workflow.

`adaptLegacyDraft` preserves ID, creation history and immutable `copy` identity. It
requires explicit gallery/account setup, current revisions and authorization, plus
`validateLegacyAdaptation`. That hook must transactionally inspect original command,
slot/remote claims, compatibility projections and all legacy jobs. Dispatched,
ambiguous or inconsistent drafts stay blocked. Missing inventory capability fails
closed. Reserved targets conflict instead of merging. An immutable adaptation receipt
and validated versioned execution-policy marker enable the common reviewer/writer.

`inventoryPublicationCommands` is a read-only authorized-Creator inventory grouped by
Work using durable status, bindings and markers. It reports operational/legacy records,
current/historical targets, receipts, uncertain operations, expired leases, stale
reviews, pending outbox count/age and conflicts. Consumer inventory must supplement
external rows, unscoped intents, legacy stores and pending provider jobs.

Before activation, inventory and backfill only unambiguous facts with durable product
cursors and CAS. Preserve IDs/conflicts. Ship compatible readers, switch readers and
writers to transactional authority, then fence old workers. Drain eligible snapshotless
jobs before cutover or pause them for fresh review; reconcile dispatched jobs first.
Never backfill evidence, overrides or approval from latest defaults. Keep legacy
routes/types until a separate versioned removal after usage/inventory review.

Schema-v2 export adds optional desired settings and nonsecret delivery history while
excluding Publication execution authority, active operations, claims, leases, outbox
and private file/preview references. Restore remaps context/source references, retains
missing explicit contexts as unresolved and keeps remote IDs/copy receipts only as
disconnected history. It restores neither current delivery pointers nor execution
markers/jobs. Coincidentally matching collection IDs cannot resolve an unmapped
context. The reference API uses this path even when preserving imported IDs.

Disable controls/new commands through product policy while preserving saved fields.
Pause/reconcile accepted work. Roll back only to binaries preserving these fields,
claims and guards; otherwise fence/drain writers and use coordinated backup recovery.
Never clear history/claims to fit an older schema.

## Verification and remaining qualification

Focused tests cover resolver precedence/context and drift; real SQLite rollback and
restart with independent settings/CAS/replay; preparation conflicts; stale reviews;
outbox recovery; duplicate dispatch; post-dispatch edits; uncertain results/fences;
remote claims; adaptation/batches; transaction-aware DynamoDB commit races; UI errors,
selection/retries; and disconnected export/restore.

Provider fixtures establish application behavior, not DeviantArt permissions/paywall
behavior. The authorized real PUB-30 journey has **not** been run. No Discord, Tumblr,
native or website per-Publication image capability is advertised as enabled here.
Consumer completion still requires its actual source-pin compatibility run, existing
route/gallery/preview/replacement/drift and Studio integration, production projection
transactions, migration/worker cutover, affected regressions and the real journey.
Retain safe IDs/checksums, gallery access and remote observations; exclude credentials
and preview URLs. Emit sanitized typed failure/correlation codes at route/worker
boundaries for preparation, review, identity and adaptation errors. Never log private
file references or raw provider responses. Activate the cohort only after qualification.
