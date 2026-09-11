# Local repository create atomicity

Revisioned repository creates run inside a synchronous local transaction, including
the existing-record lookup, record insertion, and optional retry-key insertion.
An insertion failure rolls back both writes. A caught failure in a nested create
marks the enclosing transaction rollback-only. Creates do not yield while holding
the write lock; SQLite's immediate transaction protects the write sequence against
other connections. Calls outside an active asynchronous transaction cannot join
that transaction's connection ownership.

Regression tests inject a retry-key insertion failure, verify enclosing rollback,
and exercise concurrent identical calls on one connection. They do not simulate
process crashes or independently qualify cross-process contention.

This does not strengthen the existing retry-key receipt semantics: keys still
point to the current record, are not bound to the original payload, and are not
immutable receipts after update or deletion. Update/remove retry keys and parity
with remote adapters remain separate acceptance work. No schema change is needed.
