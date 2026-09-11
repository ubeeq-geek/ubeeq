# Explicit per-record job-index repair

`repairJobIndexAttributes(documentClient, { tableName, cellId, jobId,
expectedRevision, apply? })` is privileged operator tooling, not a runtime or
startup operation. Live use requires a separately approved target list and
table-scoped permissions. Do not expose it to tenant callers.

Each call strongly reads one explicit job with a metadata-only projection.
Malformed envelopes, unknown states and foreign-cell records reject. Missing
records return `missing`; a changed expected revision returns `conflict`.
Obtain the expected revision from a separately reviewed read: an audit key alone
is not a repair instruction.

The default is dry-run (`would_repair`), with no write. Only boolean `apply: true`
can update the three discovery attributes. Terminal jobs have those attributes
removed; active jobs receive values from the queue writer's shared calculation.
Matching attributes return `unchanged`. No job value, payload, revision, attempt,
timestamp, primary key or unrelated attribute changes. No notifications are sent.

Conditions fence the observed envelope, projected job fields and discovery
attributes, including continued absence. Concurrent claims, cancellation,
timestamp changes or another repair return `conflict`; no automatic retry occurs.
Unexpected failures propagate. A timeout can follow a successful write: reread
and reconcile before retrying. An already repaired target returns `unchanged`;
a new job revision needs renewed review. Exceptions do not prove no write occurred.

This is a per-record primitive, not a bulk backfill runner. Persistent manifests,
checkpoints, approval tracking and rate controls remain caller responsibilities;
bound SDK retries separately. Re-run the [audit](JOB-INDEX-AUDIT.md) and complete
live index qualification before runtime opt-in. Tests use stateful command fakes,
not live DynamoDB. No historical records were repaired during implementation.
