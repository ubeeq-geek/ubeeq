# Repository export pagination

Repository manifest export and both import preflight paths now exhaust repository
pagination instead of reading only the first 100 rows. This includes related
publications, intents, moderation, audit, usage, sanitized integration accounts,
and export/import checkpoints. Object inventory and processing state are derived
from the complete creator asset set. Repeated cursors fail the request rather
than returning a silently truncated manifest.

The regression fixture creates 101 records in every exported repository, checks
later-page relationships and import conflicts, excludes foreign-owned records,
and verifies credential-reference removal and manifest checksum validation.

This is not a snapshot/streaming export implementation. Reads are sequential and
materialize repository records before filtering; concurrent changes can still
produce inconsistent views, and large exports need a bounded background export
job or consistent paginated snapshot. Original bytes are still excluded.
The separate creator-library compatibility records are not part of repository
manifest v2 and require their own export/import bridge. Pagination correctness
alone does not establish complete creator portability or retirement readiness.
