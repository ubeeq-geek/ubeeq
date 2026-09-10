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
