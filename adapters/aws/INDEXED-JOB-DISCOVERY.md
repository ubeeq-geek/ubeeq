# Indexed due-job discovery

`AwsJobQueue` accepts optional `configuration.jobDiscoveryIndexes` with two
distinct index names, `cellDue` and `cellTypeDue`. `createAwsAdapterSet` forwards
the same configuration. **Do not enable it until the table/index rollout and
historical-record qualification below are complete.** Omission retains legacy
first-page discovery, including its known starvation problem; there is no silent
switch and no fallback to legacy discovery when an enabled index fails.

## Schema and writes

Provision both GSIs on the records table, preferably with KEYS_ONLY projection:

| Configuration name | Partition key (String) | Sort key (Number) |
| --- | --- | --- |
| `cellDue` | `jobCell` | `jobDue` |
| `cellTypeDue` | `jobCellType` | `jobDue` |

Queue-owned writes now maintain these attributes regardless of discovery mode.
`jobCell` is the cell ID; `jobCellType` is a JSON tuple of cell ID and job type,
avoiding delimiter collisions. `jobDue` is epoch milliseconds from availableAt
for queued/retry-scheduled jobs, or leaseExpiresAt for leased jobs. Terminal
states omit all three attributes and leave the sparse indexes. Existing primary
keys and value records are retained. `jobDiscoveryAttributes` is exported for
future explicitly approved migration/qualification tooling; it is not a backfill.

The same job-item conditional write changes state and index attributes. Index
propagation is asynchronous, so these attributes are discovery hints, not lease
authority. See [AWS GSI synchronization and projection](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/GSI.html).

## Bounded reads and claims

Untyped workers query the cell/due index. Typed workers query only their exact
cell/type partitions, with at most 16 nonempty requested types. One call divides
a 100-candidate budget across distinct types, queries one oldest-due page per
partition, and does not chase unbounded pagination. No FilterExpression, Scan,
terminal-history walk or process-local discovery cursor is used.

Each returned key is validated and reread with strong consistency from the base
table. Missing, foreign-cell, wrong-type, future, terminal or active-lease rows
cannot be claimed just because an old index entry exists. Candidates are ordered
by due time before attempting conditional claims. Revision, cell, state and the
exact observed due/expiry value fence the write after the parsed-time check;
offset timestamps therefore do not depend on lexical ISO comparisons. Expired
leases preserve the existing reclaim/attempt-exhaustion rules.

The bound is at most 16 index queries and 100 strongly consistent candidate reads
per call (96 for 16 equally budgeted types), plus existing conditional transitions.
This is not a hard deadline or fair scheduling under arbitrary infinite load.
Stale pages can temporarily yield no lease; poll again after index propagation.
Query/read failures propagate. See [AWS Query limits and consistency](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_Query.html).

## Rollout and remaining acceptance work

1. Roll out attribute-writing code while retaining legacy discovery.
2. Provision both indexes using an approved table rollout, observing AWS's index
   update restrictions and waiting for indexes to become active. This PR does not
   change infrastructure templates or create indexes.
3. Inventory historical queued/retry/leased records. Populate/validate their
   attributes through approved, resumable, revision-conditional migration tooling;
   malformed records need explicit handling. Do not assume all historical jobs
   received a new write. No automatic backfill or implicit state repair occurs.
4. Qualify visibility, index lag, permissions, throughput and claims against the
   actual table, then pass both index names in the consuming runtime configuration.

The adapter tests use a stateful command fake, including the shared queue contract,
400 unrelated records, stale index pages, strong-read races, lease expiry, every
state transition, bounded populated partitions and failure handling. They are not
deployed DynamoDB acceptance. Runtime/infrastructure adoption, historical index
coverage, notification recovery, bounded administrative listing, durable enqueue
idempotency and job-dependent content transaction fencing remain unfinished.
