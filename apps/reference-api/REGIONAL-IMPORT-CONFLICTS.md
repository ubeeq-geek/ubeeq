# Regional destination record conflicts

Destination imports no longer treat an existing ID as sufficient evidence of a
completed write. Within the metadata transaction, each existing record must
equal the intended destination record after JSON serialization, excluding only
repository-generated revision, createdAt, and updatedAt fields. Ownership,
destination home and routing, content, and remapped storage remain significant.
Matching records are unchanged; differing records reject the whole import.

This supports retries of the same manifest/checkpoint without overwriting
destination edits or unrelated records. It deliberately changes the old
rollback/re-migration behavior: a new checkpoint cannot silently reuse retained
destination records with old routing metadata. It stays before cutover and
requires explicit reconciliation. No automatic deletion or overwrite is added.

Local real-cell tests cover foreign-owner collisions, transaction rollback,
matching replay, same-owner content conflicts, harmless repository revision
changes, blocked re-migration after rollback, and successful retirement on the
non-rollback path. This is not a concurrent destination-write fence or a complete
reconciliation workflow. AWS read/write race qualification and staged large
imports remain pending. No retained databases or live resources are changed.
