# Direct activity workflows

Extends the direct-messaging integration with all five first-priority workflows. No runtime AI, generated replies, or assistant subscription is required. Creator-owned assistants can later use the same authenticated operations.

## Implemented behavior

| Feature | Implementation |
| --- | --- |
| Since last check | Persisted per-profile/per-selection checkpoints; bounded ingestion-sequence pages; explicit acknowledgement so a failed response does not mark unseen activity handled. Late-arriving source events remain visible. |
| Creator/platform selection | Authorized choices, paginated listings, saved multi-ID selections and `all`; permission rechecks on queries and writes. |
| Comment inbox/replies | Current comment/thread lookup; all/unread/unanswered/resolved filters; separate read/resolve/reopen state; exact-text preview and explicit, expiring confirmation; atomic send reservation. |
| Digests | Off/hourly/daily/weekly preferences, IANA timezone quiet hours, minimum event threshold and selected sources; atomic persisted outbox plus checkpoint advancement; restart discovery and guarded delivery. |
| Integration health | Transition projection for authorization expiry, publish failure, stale sync and recovery; independently enabled alerts using the same outbox, quiet hours and delivery gates. |

`LocalActivityWorkflowStore` provides durable SQLite storage for the compact profile, indexed scoped keyset reads, idempotent ingestion and atomic conditional batches. The service's store contract is provider neutral; scalable deployments should supply their own implementation rather than adopting SQLite.

## Direct interfaces

`ActivityCommandInterface.execute(principal, text)` provides commands without LLM interpretation. `handleActivityWorkflowMessage` accepts decoded WhatsApp messages and resolves the full receiving-account/sender identity through the host's active link registry. Existing raw-body verification and inbox admission must run first.

The reference API exposes `POST /v1/activity/command` when its `activityCommands` configuration is supplied. It derives the actor from the verified bearer session, uses the fixed `web` profile and ignores caller-supplied actor/profile IDs. Replies are private/no-store. Unconfigured instances return 404; anonymous requests cannot execute commands.

Example conversation:

1. `creators`, `platforms` (use the displayed next-offset command for more choices).
2. `select creators creator-a,creator-b`; `select platforms native,deviantart`.
3. `activity`, then the returned `ack <token>`. Repeat `activity` for the next page.
4. `inbox unanswered`, then `thread <reference>` to open and mark read.
5. `reply <reference> Thank you!`, then the displayed `confirm <token>` to send that exact text.
6. `resolve <reference>` handles a comment without replying; `reopen <reference>` reverses it.
7. `digest daily`, `zone America/Winnipeg`, `quiet 22-8`, `minimum 3`, `alerts on`.

Quiet start/end are local hours; equal hours disable quiet hours. Digests run at elapsed intervals after configuration/last queueing, not at a fixed local clock time. Quiet hours defer delivery. A digest contains up to 20 events; its threshold counts events, not the numerical change in favourites. Source timestamps are displayed; aggregate counts never imply named favourite actors, and missing baselines/counts remain explicitly unavailable.

## Host composition

Construct `ActivityWorkflows(store, ports)` and `ActivityCommandInterface(workflows)`. Pass the command interface to the reference API or the decoded-messaging handler. Ports must supply:

- Current authorized creator/platform choices and operation-specific permission checks.
- Current visible comments and bounded thread history, including provider answered/reply-capability state. IDs must match the exact creator/platform/comment reference. Content holds/deletions must be respected by `visible` and `comment`.
- Provider reply execution with deadlines, bounded errors and an idempotency key where supported. Return `not_sent` only when failure is certain; ambiguous timeouts return `unknown`.
- Notification channel admission and delivery: active opt-in/link, provider template/window rules, host quotas and budget limits. Disabled/unconfigured sending must fail closed.

Existing connector sync workers append normalized events with stable source-event IDs. Append each comment-created event once; updates belong to the current-comment reader. Favourite snapshots must use compatible scope and sample ordering when supplying `previousCount`; do not fabricate deltas from unavailable baselines. Health pollers use `integrationHealthActivity`, preserve its signature and reuse observation IDs on retries. Persist ingestion and source checkpoint progression safely in the host worker.

A host scheduler calls `prepareNotification` for a due linked principal and notification kind. It then calls `deliverNotification`; on restart, use paginated `notifications` to rediscover pending work. Do not scan every account per user message. The profile's checkpoint and new outbox record are committed atomically, so restart cannot silently lose a prepared notification. Quiet hours, preference changes, access and channel admission are checked again at delivery. Notification queueing has a bounded look-ahead of 100 source events; hidden events never lower the threshold. Very sparse visible activity beyond that bound may require host-side filtered ingestion/query optimization.

Creation of scheduled jobs, deployment-specific stores, live provider adapters, account-linking screens and ES/NF application composition are not enabled by this PR. The workflows and reference endpoint are implemented and tested; this is not a claim of live WhatsApp delivery. The earlier messaging PR's host activation requirements still apply. No change to shared-viewing sessions is required.

## Recovery and bounds

- Replies and notifications reserve `sending` atomically before external I/O. Concurrent confirmations/workers cannot call the provider twice.
- An uncertain provider result or crash while `sending` requires reconciliation. Never blindly resend it. `retryNotification` only requeues a confirmed `not_sent` result.
- Viewing a comment does not resolve it. Activity acknowledgement does not change inbox status. Digest checkpoints are independent of manual activity checkpoints.
- Tokens are profile/actor scoped and previews/references expire after 15 minutes. Outbox entries expire after 24 hours. Hosts must apply retention cleanup to stored previews, references and terminal delivery records; expiry admission alone does not remove their bytes.
- Rooms/other features do not gain permission through these APIs. Profiles are bound to the store's instance/cell. A revoked selected creator causes access to fail closed until the selection is corrected.
- Enforce host request/ingestion quotas and retention. The service bounds choice counts, pages, comment reply lengths, checkpoint selections and outbox payloads; it is not a deployment-wide rate limiter.

## Validation

Workflow tests exercise all five features, current-access checks, checkpoint pagination, late ingestion, hidden content, exact reply confirmation, concurrent sends, uncertain outcomes, timezone quiet hours and restart discovery. SQLite tests verify restart durability, cross-instance isolation, idempotent ingestion, keyset continuation and atomic batch rollback. The HTTP integration test uses the actual command service and SQLite adapter behind verified sessions and confirms caller-supplied identity cannot override the session.
