# Scoped job identities

New AWS queue jobs use a `job-v2-` ID derived from the JSON-encoded pair of cell
and idempotency key. Delimiter joining was ambiguous: cell `a:b` with key `c`
and cell `a` with key `b:c` produced the same legacy hash input. Enqueue now
captures its input before I/O and requires nonempty cell/key strings.

Enqueue checks the new ID first and verifies the returned job's cell/key. It
then checks the legacy ID, accepting it only when both stored values match.
A legacy collision belonging to another scope is neither returned nor changed;
the requested scope receives its own new-format job. A conditional create race
also checks the returned record's scope before notification. Existing job IDs
and notification payloads are not rewritten.

Rollout requirement: old and new enqueue writers must not race during migration.
An old writer can create a legacy job after a new writer's compatibility lookup,
creating two logical jobs. Quiesce or upgrade enqueue writers together before
using this ID transition in a live environment. This PR performs no deployment,
backfill, cancellation or notification against live services.

This fixes scope encoding, not full request-bound idempotency. Reusing a key in
the same cell retains the existing job; payload equivalence, notification outbox
recovery and durable receipts remain separate acceptance work. Tests cover the
ambiguous pair, matching/foreign legacy records and input capture with mocked
DynamoDB/SQS, not live service qualification.

## Retrying availability notifications

Enqueue retries for a matching queued or retry-scheduled job now re-send its
availability notification without rewriting the job or accepting changed retry
payloads. This lets a producer retry recover a failed notification after the
durable write. Leased and terminal jobs are returned without notification or
state changes. EventBridge per-entry failures are errors even when the API call
itself succeeds; the producer can retry them too.

Notifications are at-least-once wake-up hints, not permission to execute. Workers
must re-read and claim through the existing lease/due-time checks. A state change
between the read and notification can produce an unnecessary hint. If SQS succeeds
but EventBridge fails, retry can duplicate the SQS hint. The original payload and
job identity remain unchanged.

This is producer-retry recovery, not an atomic outbox. A producer that disappears
after the durable write may still leave notification work outstanding; durable
discovery/reconciliation remains required. No live notification was sent during
the mocked contract tests or this implementation change.
