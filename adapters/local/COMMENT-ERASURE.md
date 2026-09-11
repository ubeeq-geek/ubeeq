# Replay-safe comment body erasure

`LocalCommentStore.eraseComment(targetType, targetId, commentId, deletedAt)` clears
the standard body and marks a scoped record deleted. It retains identity and
creation metadata so create retries cannot reuse the primary key. Raw lookup
returns the erased record; ordinary and moderation lists omit it. Visibility
updates cannot restore it. Repeated erasure returns false without changing the
original deletion timestamp. No schema migration is needed for the JSON marker.

Applications must authorize erasure and atomically commit their audit record.
They must reject create retries when raw lookup reports `deletedAt`. This is not
a forensic purge of SQLite pages, WAL files or backups. Extension fields are
retained and must not duplicate the comment body. The legacy physical
`deleteComment` method remains for compatibility; do not use it or purge erased
identity records where replay protection is required.
