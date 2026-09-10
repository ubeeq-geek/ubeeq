# Historical job-index attribute audit

`auditJobIndexPage(documentClient, { tableName, limit?, cursor? })` performs one
read-only base-table Scan, with 1–100 evaluated items (default 100). It deliberately
does not use either discovery GSI or the repository index: missing index
attributes must not hide historical records from inspection. This is table-wide
operator tooling, not a cell-authorized application endpoint or worker read path.
It requires separately authorized table-scoped Scan access; no IAM policy is
changed by this implementation. Do not expose it to tenants.

The projection retrieves keys, identity/revision metadata and discovery fields,
not payloads, errors or credentials. The result contains per-page evaluated/job/
matching counts, issues with record keys and fixed reason codes, and an optional
table-bound continuation cursor. Keep these operational identifiers private.
Persist the cursor only after processing that page; call again explicitly to
continue, including pages with zero jobs. No automatic loop or retry is added.
SDK retries and total operational cost must be bounded by the caller.

For recognizable durable-job records, the audit checks envelope identity and
revision consistency, known state and the exact attributes computed by the
queue writer. Active records require valid discovery inputs; terminal records
must omit sparse attributes. It does not validate every job domain invariant.
Malformed envelope keys or responses reject the page rather than silently
advancing. Unknown non-job records are ignored, so records lacking both the
durableJobs repository marker and key prefix cannot be identified as jobs.

## What this does not prove

A clean page is not full-table coverage. A completed traversal is not a snapshot:
even strongly consistent DynamoDB scans do not provide snapshot isolation.
Projection also does not make table scans cheap in read capacity. See
[AWS Scan semantics](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_Scan.html).
Coordinate an approved audit window and reconcile concurrent writes before
using results as historical coverage evidence. The helper does not inspect GSI
status, schema, permissions, lag or actual query visibility and never sets the
runtime qualification flag. It has no repair, backfill or deployment operation.

Missing/mismatched attributes need separately approved, resumable,
revision-conditional repair tooling; malformed records need explicit handling.
Run the audit again after repair and complete the remaining
[rollout qualification](INDEXED-JOB-DISCOVERY.md) before enabling discovery.
Tests use command fakes only; no live table has been audited.
