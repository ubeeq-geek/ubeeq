# Atomic regional metadata import

After manifest validation, all destination metadata creates now share one
repository transaction, including their idempotency keys. Existence checks use
that transaction context too. A late write failure must leave no new creator,
work, asset, collection or related metadata committed by that attempt.

The local two-cell regression injects a SQLite failure on the final integration
account write. Before the fix, the destination creator remained. After the fix,
creator/work/asset records are absent, the directory still points at the source,
and the checkpoint remains `transferred`. Removing the injected failure allows
the same migration to resume through cutover, rollback, retry and retirement.

This is metadata atomicity, not a distributed transaction. Transferred objects
remain for retry; the remote control-plane checkpoint is advanced separately.
Large AWS imports must respect the transaction adapter's action limit and fail
without splitting into non-atomic batches. A staged large-import design remains
future work. Existing-ID skip semantics, destination conflict reconciliation,
per-asset read-time integrity, source write fencing and production AWS testing
are not solved here. No retained or live data is migrated by the tests.
