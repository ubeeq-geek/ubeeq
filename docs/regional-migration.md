# Regional creator migration

Migration changes the authoritative home cell for a creator. It is never background replication, global-table failover, or a switch that silently accepts writes in another region.

`@ubeeq/deployment-platform` provides the portable control-plane contract:

- `CellRoute` contains only a creator identifier, home cell/region, HTTPS endpoint, routing revision, state, and update time.
- `MigrationCheckpoint` records source/destination identity, the export checksum, object-inventory counts, verification evidence, rollback window, and any failure reason.
- Route cutover compares the checkpoint's source revision with the current route and increments the routing revision atomically in the directory implementation.

The required lifecycle is `requested → source_hold → exported → transferred → verified → cutover → retired`. A verified inventory must have matching source and destination object counts before cutover. Cutover requires a future rollback window; only an unretired cutover can roll back. Failures require an auditable reason.

An operator implementing `CellRoute` storage must use an atomic conditional write for the routing revision. The routing directory must not store source files, credentials, moderation evidence, private profiles, or mutable Work records. Transfers and imports use the existing export/object-store ports and must record checksums; credentials require a dedicated re-encryption capability and creator authorization, otherwise the creator reconnects them in the destination cell.

The reference API remains a single-cell application. A managed multi-cell deployment supplies the directory and migration worker outside the reference application's data plane. Until such an operator adapter is installed, a regional outage remains unavailable for writes and cannot trigger failover.
