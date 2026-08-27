# Regional creator migration

Migration changes the authoritative home cell for a creator. It is never background replication, global-table failover, or a switch that silently accepts writes in another region.

`@ubeeq/deployment-platform` provides the portable control-plane contract:

- `CellRoute` contains only a creator identifier, home cell/region, HTTPS endpoint, routing revision, state, and update time.
- `MigrationCheckpoint` records source/destination identity, the export checksum, object-inventory counts, verification evidence, rollback window, and any failure reason.
- Route cutover compares the checkpoint's source revision with the current route and increments the routing revision atomically in the directory implementation.

The required lifecycle is `requested → source_hold → exported → transferred → verified → cutover → retired`. A verified inventory must have matching source and destination object counts before cutover. Cutover requires a future rollback window; only an unretired cutover can roll back. Failures require an auditable reason.

An operator implementing `CellRoute` storage must use an atomic conditional write for the routing revision. The routing directory must not store source files, credentials, moderation evidence, private profiles, or mutable Work records. Transfers and imports use the existing export/object-store ports and must record checksums; credentials require a dedicated re-encryption capability and creator authorization, otherwise the creator reconnects them in the destination cell.

## Reference control-plane adapter

`@ubeeq/adapters-local` supplies `LocalRoutingDirectory` and
`LocalMigrationCheckpoints`. They use SQLite tables separate from the regular
creator repositories and implement creation plus optimistic compare-and-swap
updates. The adapter is useful for local operator workflow development and
restart-safe migration workers; it is not exposed as a public reference API
route. An operator-facing route must be protected by a deployment's own
administrator authorization extension before it can disclose even routing
metadata.

The next managed deployment adapter must implement the same two interfaces in
an operator control plane (for example, a dedicated DynamoDB table), rather
than placing routing records in any regional creator-data table.

## AWS managed control plane

`@ubeeq/adapters-aws` provides `createAwsRoutingControlPlane`. It uses a
dedicated DynamoDB table with `route` and `migration` partitions and conditional
writes for route revisions and checkpoint update times. It does not use DynamoDB
Global Tables and does not access regional `Records` tables.

The optional `RegionalControlPlaneStack` creates that table in one declared
operator control region:

```sh
(cd packages/aws-self-host-infra && \
  UBEEQ_CONTROL_PLANE_STACK_NAME=UbeeqRoutingControl \
  UBEEQ_CONTROL_PLANE_REGION=us-east-2 \
  npx cdk deploy UbeeqRoutingControl)
```

For a regional cell, pass the output table name, ARN, and deployment region as
`UBEEQ_ROUTING_DIRECTORY_TABLE_NAME`, `UBEEQ_ROUTING_DIRECTORY_TABLE_ARN`, and
`UBEEQ_ROUTING_DIRECTORY_REGION`.
The cell Lambda receives read-only access for edge route resolution. A separate,
explicitly authorized migration-worker deployment receives write access and a
`MigrationExecutor`; no ordinary cell runtime can mutate the global directory.

## Operator procedure and recovery

1. Publish the operator's supported cells, regions, endpoints, backup location,
   recovery objectives, and rollback retention period.
2. Confirm source and destination capacity, then create a checkpoint through an
   authorized control-plane worker. The source hold is visible before export.
3. Export and transfer only under the migration namespace. Verify the manifest
   checksum plus source/destination object counts before enabling the destination.
4. Atomically compare-and-swap the route revision. Edge clients receive a `307`
   to the home cell; writes are never proxied or silently failed over.
5. Keep the source read-only until the recorded rollback deadline. Roll back only
   through the checkpoint and audit the action. Retire source data only after that
   window and the operator's disclosed retention policy.

Monitor every cell independently: regional storage/transfer usage, queue backlog,
processing failures, route-checkpoint conflicts, backup success, and delivery
errors. Migration transfer is metered separately from ordinary public delivery.

## Verification matrix

- A foreign-cell repository record, job, object key, credential reference, or
  delivery token is rejected by the receiving cell.
- The normal upload path touches one cell's storage and queue only.
- A stopped migration resumes from its durable checkpoint; repeated worker calls
  do not create a second route revision.
- Route cutover and rollback use optimistic compare-and-swap; source deletion is
  impossible before retention expiry and explicit retirement.
- The public route endpoint returns only endpoint/cell/revision metadata and a
  same-method redirect. Operator lists and lifecycle actions require the
  deployment-supplied authorization requirement.

The reference API remains a single-cell application. A managed multi-cell deployment supplies the directory and migration worker outside the reference application's data plane. Until such an operator adapter is installed, a regional outage remains unavailable for writes and cannot trigger failover.
