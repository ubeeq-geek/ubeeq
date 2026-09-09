# Local SmugMug inventory runner

`LocalSmugMugInventoryRunner` composes the shared inventory workflow with the
SQLite job queue. Applications provide the database, admitted integration
service, synchronous source checkpoint callback and stable cell ID. The default
table is `ubeeq_smugmug_inventory_runs`; the default job type is
`ubeeq.smugmug.inventory.page`. Optional validated table/job names allow existing
applications to retain their persisted records without renaming or backfilling.
These configuration names must remain stable across restarts.

Starting a run checkpoints source state before acknowledging queued work. Each
tick advances one inventory invocation. Queue acknowledgement, next-page enqueue
and the visible run pointer commit atomically in SQLite. Healthy continuation
pages receive separate jobs; failures use the shared three-attempt budget and
require explicit admitted recovery after dead-lettering. Status omits credentials
and raw provider diagnostics. Applications supply polling and HTTP/UI composition.

This is single-process development infrastructure. The source checkpoint and job
database are not one transaction: safe retries depend on persisted source cursors
and completion receipts. The instance busy guard does not fence separate workers
or external effects. A five-minute lease is not an enforced provider-call deadline.
Changing storage/job names does not migrate old work. No cloud scheduler, live
provider acceptance or multi-process readiness is implied by extraction.
