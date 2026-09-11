# Job uniqueness by cell

Migration 019 replaces global uniqueness of `ubeeq_jobs.idempotency_key` with
uniqueness of `(cell_id, idempotency_key)`. Existing stored keys and every job
field remain unchanged, including IDs, leases, attempts, errors and timestamps.
The old encoded key could be identical for different cell/key pairs; the new
constraint matches the adapter's already-scoped reads and cancellation queries.

SQLite rebuilds the table inside one immediate transaction. The migration can
be reapplied after a commit-before-marker interruption without losing rows.
Tests cover full row preservation, reapplication and same-cell duplicate
rejection. The shared queue contract additionally exercises ambiguous delimiter
pairs, stable retries and isolated cancellation/completion on both adapters.

This code change was tested with temporary databases, not existing product data.
Before adopting the new pin against retained data, back up the database and
coordinate startup migration with writers. Custom external indexes/triggers on
the jobs table are outside the supported schema and would need explicit handling
before this table rebuild. Payload-bound idempotency and notification recovery
remain separate requirements.
