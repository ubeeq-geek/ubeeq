# AWS serverless multi-cell operator runbook

This runbook operates independent Ubeeq regional cells. It does not make a
global database, cross-region replication, or automatic failover acceptable.
Every creator remains in one authoritative home cell until an explicit,
audited migration changes that assignment.

## Boundaries

- Treat the control plane as operator metadata only. Its routing directory may
  contain creator ID, home cell, endpoint, revision, and migration state; it
  must never contain originals, credentials, moderation evidence, or mutable
  Work data.
- Keep each cell's table, buckets, queues, credential vault, logs, and backup
  plan in that cell's region. CDN caching is not a second canonical copy.
- The control worker receives exact source/destination bucket and private
  migration-function ARNs. Never grant wildcard S3 or Lambda access.
- A home-cell outage makes writes unavailable. Do not redirect writes to
  another cell as an implicit failover.

## Cell inventory and registration

Maintain an operator-owned inventory with the cell ID, region, public HTTPS
endpoint, private migration-handler ARN, object bucket, backup location,
recovery objective, and status. Do not include any secret values.

Before registering a cell, verify all of the following:

1. The single-cell stack is deployed in the selected region with a stable
   `UBEEQ_CELL_ID` and no DynamoDB Global Tables or S3 replication rule.
2. `/health` and `/ready` succeed through the intended API endpoint.
3. Point-in-time recovery, bucket versioning, backup retention, and restore
   evidence are recorded for that specific cell.
4. The cell's private `MigrationCellFunctionArn` allows invocation only from
   the control worker role, and the control worker allows only that exact
   function ARN and bucket ARN.
5. The creator-facing region disclosure names the operator, home region,
   normal-location of originals/private data, CDN-cache distinction, and
   migration consequences.

Register only an active, verified cell through an administrator-authorized
control-plane operation. The registration contains the public endpoint plus
the private function and bucket identifiers for the worker; public routing
responses never disclose the private identifiers.

## Regional selection and migration

At creator creation, select and persist the `homeCellId`, region, assignment
time, and routing revision. A region change is a migration, never a profile
preference update.

For each migration:

1. Check destination capacity, compatible adapter revisions, required policy
   approval, and current source/destination backup health.
2. Create a checkpoint through the administrator control-plane API. Record the
   requested source, destination, creator authorization, and rollback window.
3. Queue `resume`. Confirm the source hold before export; source writes,
   uploads, and regional jobs must reject while held.
4. Review the versioned export checksum and object inventory. The worker must
   verify each destination object checksum and count before route cutover.
5. Confirm the route revision moved exactly once to the destination. Viewers
   may be redirected to the new endpoint; no global service proxies writes.
6. Retain the source read-only through the recorded rollback window. Use the
   checkpoint's `rollback` operation—not a manual route edit—to reverse the
   cutover if necessary.
7. After the window and the disclosed retention period, invoke `retire`.
   Reconcile source objects, records, audit retention, and credential
   reconnection status. Credentials are never transferred unless the vault
   explicitly supports authorized re-encryption.

For an emergency recovery, restore in the original region first. If that is
not possible, open an audited emergency migration; do not silently create a
second writable home cell.

## Observability and recovery

Deployments create these operator signals:

- Single-cell dashboards and alarms for API Lambda failures, API Gateway 5xx,
  job dead letters, worker errors, and private migration-handler errors.
- Multi-cell dashboard and alarms for migration command backlog, migration
  dead letters, control-worker errors, and transfer-byte observations.

Connect alarm actions to the operator's incident channel in private deployment
configuration. The public stack intentionally does not hard-code pager routes,
retention schedules, account topology, or production hostnames.

When a migration command fails, inspect its checkpoint and worker log first.
Do not purge a command queue until every message is known to be either an
authorized active checkpoint or a stale disposable-test command. Record the
recovery action and checkpoint ID in the operator audit trail.

## Protected development validation

`.github/workflows/aws-dev-multi-cell-live.yml` is manual-only. It runs only
after the `ubeeq-dev-multi-cell-live` GitHub Environment approves it and its
`confirm-dev-mutation` input is set. Configure only these protected environment
variables:

- `UBEEQ_DEV_LIVE_ROLE_ARN` — an OIDC role scoped to the named development
  cells and development control plane;
- `UBEEQ_DEV_AWS_ACCOUNT_ID` — the expected development account ID.

The workflow rejects any assumed account mismatch, uses fixed dev stack names
and regions, creates disposable identities/data, runs adapter/API and
cross-cell migration proof, then removes its identities. It never runs on a
pull request and cannot accept an operator-provided production stack, region,
or role as input.

## Production readiness: do not reuse development

Production setup is a separate change and authorization boundary. Before
registering even one production cell:

1. Deploy separate production cell and control-plane stacks in the production
   account(s), with separate buckets, tables, queues, KMS keys, Cognito pools,
   logs, backup vaults, and operator roles. Never point a production registry
   at a development resource or vice versa.
2. Use a pinned, reviewed Ubeeq release/artifact revision and record its
   checksum, configuration revision, domain/certificate ownership, and restore
   evidence.
3. Configure production-only alert routing, access reviews, backup retention,
   incident access, cost/transfer budgets, and data-home disclosures.
4. Run read-only health/readiness and isolated restore validation first. Run
   destructive disposable validation only through a separately approved
   production procedure, never the dev workflow.
5. Have an authorized operator review exact private handler/bucket permissions
   and register the production cell only after all checks pass.

This repository intentionally does not register, deploy, or infer production
cells from its development configuration.
