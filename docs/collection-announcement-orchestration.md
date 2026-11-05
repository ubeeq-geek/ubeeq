# Collection announcement orchestration

The public packages provide the provider-neutral domain layer for collection
announcements. These exports do not enable automation, dispatch providers, migrate
historical records, or install product routes or UI. New Creator preferences have
both triggers off. Applications must opt into a versioned `first_delivery` stage
independently of the existing authoring payload version.

## Package boundaries

| Package | Available implementation |
| --- | --- |
| `@ubeeq/core` | Exact release requirements and readiness, baseline reservation proposals, preference patches and revision provenance, fixed-variable block templates, local time resolution, initial/follow-up schedules, plan transitions, materialization reservations, send eligibility and unsent replacement proposals |
| `@ubeeq/integrations` | Completion capability and authoritative observation contracts, release/destination ownership checks, opt-in immutable planned delivery snapshots |
| `@ubeeq/persistence` | Byte-bounded checksummed manifest generation and verification, optional transactional repository contract |

Production repository adapters, adapter-specific evidence readers, reconciliation
workers, authoring integration, list projections, migrations, feature rollout and
product UI remain application work. The new repository interface is optional;
existing repositories and queued announcements keep their original contracts.
The pure state proposals are not a substitute for conditional database writes.

## Release capture and evidence

Capture a release for each deliberate publication operation, including operations
that only target native collections or websites. Allocate its operation key with
`collectionReleaseOperationKey`. Freeze requested works, exact publication copies,
content revisions, collection revision, placement, audience and required flags
before starting child jobs. Do not rebuild the manifest from current membership.

Use `prepareCollectionReleaseManifest` to stage immutable chunks, then activate
their reference with the release header, reservations, plans and outbox intents
in one conditional transaction. Workers call `readCollectionReleaseManifest`
only for the reference on the activated header. Chunks are bounded by encoded
UTF-8 bytes and result count, not merely JavaScript string length. Large baselines
also require immutable chunk generations and conditional header activation.

`evaluateCollectionReleaseReadiness` accepts authoritative observations. Neither
worker success, an event payload, desired membership nor queued downstream work
constitutes evidence. Observations must match every identity, revision, placement
and audience field on the expected result. Duplicate observations fail closed;
read one current authoritative outcome per result first.

Native observations must prove effective release availability and eligible live
work inclusion. Website observations additionally identify the active deployment
revision and a durable URL. External gallery observations confirm live content
and placement. Forum observations confirm required messages and retained remote
IDs. Future adapters explicitly declare revision completion support. The
integration capability contract grants no provider capability by default.

All selected content links are extra hard dependencies. Supply the complete
expected result IDs for each link's scope. A primary-only completion rule does
not exempt an optional destination used as a secondary link. Work progress and
result progress are distinct fields in the readiness result.

## Baseline claims

Reconcile historical live content before setting a baseline's `initialized` flag.
Unknown evidence must never initialize an empty baseline that treats historical
content as new. `reserveCollectionRelease` returns a pure proposal:

- An initial claim serializes subsequent releases until it finishes.
- Overlapping addition scopes wait rather than silently dropping reserved works.
- Repeated claims retain the original reserved scope.
- Zero new works yields a no-op.

Persist the proposal using the expected baseline revision. Only the winning
transaction may create the plan. `recordCollectionReleaseExposure` advances the
monotonic baseline as soon as any exact result proves exposure, regardless of
announcement status. `finishCollectionReleaseReservation` frees reservations
when publication terminates, retaining all confirmed exposure. Cancelling an
unexposed initial claim permits the next release to classify as initial.

## Preferences and content

`resolveCollectionAnnouncementPreferences` applies Creator defaults, collection
patches, then release patches. Preference groups replace as a unit; omitted or
null groups inherit. Use an explicit disabled follow-up value to override an
inherited enabled follow-up. Store the detached effective settings and all
contributing revisions on each plan. Saving preferences must not mutate old plans.

`renderAnnouncementTemplate` substitutes only the exported fixed variable set in
typed block fields. Values remain inert text for the existing renderer. HTML,
opaque data and arbitrary expressions are not evaluated. Unknown or unresolved
variables fail validation. Required links must be durable and credential-free;
the existing public URL policy also checks nested redirect links.

Callers derive counts from confirmed content at the chosen primary destination.
Set `sharedCountsAvailable: false` when scopes differ; render separate destination
values or omit shared count variables. The block renderer and provider validators
remain mandatory after substitution. Before materialization, resolve managed
media to authorized asset revisions and pin those references on the authoring
snapshot. Never put signed URLs or current, unsnapshotted collection members in
the delivery content. Refreshing content requires an explicit reviewed revision.

## Scheduling and follow-ups

`resolveAnnouncementCivilTime` records the local civil time, IANA zone, selected
offset and resolved instant. DST gaps fail, folds require an explicit choice, and
fractional offsets and half-hour transitions are supported. Durations are elapsed
milliseconds; one day is 24 hours. Calendar viewing zones never alter these values.

`evaluateAnnouncementSchedule` returns no `dueAt` while release readiness is
unresolved. A chosen absolute instant remains `requestedAt` for provisional
calendar presentation. Persist the first `releaseReadyAt` exactly once under CAS.

`evaluateAnnouncementFollowUpSchedule` consumes one authoritative parent outcome
per logical destination. Only `published` outcomes anchor a follow-up. Provider
drafts, queue acceptance, failures and unknown outcomes do not. A new follow-up
destination requires first success or an explicitly chosen existing parent
destination. Persist resolved anchors and supply `fixedAnchorAt` thereafter.
Cancellation propagates through the selected corresponding parent; explicit
independent anchors retain their own gate.

Absolute times missed before dependency completion use the saved late policy.
The maximum lateness also bounds scheduler outages for relative times. The
default is hold, with a 24-hour maximum automatic lateness. Removing the limit
requires explicit `null`. A draft's timing is informational until a separate
review authorizes sending.

## Materialization and delivery

`reserveAnnouncementMaterialization` assigns one deterministic authoring ID.
Crashes resume using that ID. Atomically create-or-find the authoring record,
complete materialization and switch the single list projection. Until then,
`announcementLogicalRow` exposes the plan ID without an invented announcement ID.
Replacement generations retain the same plan and authoring ID.

Validate every selected destination before handing off any automatic delivery.
Draft mode never passes `assertAnnouncementSendEligible`. Material source,
account, permission and rule changes retain a review hold. A transient feature
pause may clear after revalidation without replacing the plan. Feature rollout
must remain separate from saved user authorization.

`createPlannedAnnouncementDeliverySnapshot` reuses the existing delivery factory
and hashes, adding a plan/step/generation tuple to the supplied idempotency key.
That isolates replacements even if an operation key is reused. Existing calls to
`createAnnouncementPublication` and their persisted identities are unchanged.
Use the explicit `AnnouncementDeliverySnapshot` alias at application boundaries
that also handle an authoring record.

Persist handoffs and due-index entries before enqueueing. Immediately before a
provider call, acquire a conditional send claim and recheck the plan revision,
generation, due time, authorization, source, policy and required links. A timed-out
provider request becomes `needs_reconciliation`, never an automatic blind retry.

`replaceUnsentAnnouncementSteps` prepares a conditional replacement proposal,
preserves successful snapshots and returns cancellation tombstones. It conflicts
with in-flight or unknown requests and requires all pending requests to move
together. The application owns destination-specific retry and cancel actions,
their review tokens and audit persistence. Missing delivery records are incomplete
handoffs rather than successful empty batches.

`collectionPlanOwnsAnnouncement` scopes legacy per-work suppression to the exact
release and selected announcement destination. Propagate release/result IDs to
child jobs. Imported history must not produce a fresh publication or sent event.

## Application integration exit checks

Before enabling automation, applications still need real conditional-write and
recovery tests for every storage adapter, authoritative native/website/gallery/
forum fixtures, due and reconciliation sweep workers, provider send integration,
authorization and policy checks, filter-before-pagination projections, reviewed
subset amendments, management actions, and complete product browser flows.
Observe readiness before staged draft-only rollout. Historical backfills must
preserve IDs, schedules, queued snapshots and private imported history, and must
never replay a send.
