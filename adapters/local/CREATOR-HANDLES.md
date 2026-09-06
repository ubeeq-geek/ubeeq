# Local creator handles and aliases

Migration 009 adds a SQLite unique index over `(instanceId, handle)` for creator
records. The database enforces exact current-handle uniqueness on insertion and
revisioned updates, including competing connections. A conflict becomes the shared
`UniqueConstraintError` named `creator_current_handle`; failed writes leave the
record and revision unchanged.

Migration 010 backfills a unique alias table from current handles and canonical
`handleHistory`. Insert/update triggers reserve all supplied aliases in the same
SQLite statement as the record write; any collision aborts that write and all its
alias claims. The repository retains old history and appends renamed handles even
if a caller submits an empty history. Restoring one's own alias is allowed. Current
and historical collisions share the existing `creator_current_handle` error name.

Callers validate and normalize handles before persistence. These constraints do not
normalize existing identifiers, validate missing fields or enforce uniqueness across
independent databases/cells. Instance identity is immutable through normal repository
updates. Explicit record removal releases its aliases; no permanent post-deletion
identity reservation is claimed. Direct SQL writes are not a supported history-edit
interface. Canonical history travels with record exports; aliases are rebuilt locally.

Existing duplicate current or historical aliases stop migration. No records are
renamed or removed automatically. Resolve such conflicts through an explicitly
approved identity migration before restarting; do not drop the index to bypass it.
This is a local-adapter guarantee, not a claim about AWS or machine adapters.
