# Migration source hold traversal

The reference API's creator write guard uses shared `repositoryItems` traversal
to inspect all moderation-hold pages. Previously it examined only 100 entries,
so a later active migration hold could be missed. Matching active migration
holds still reject creator writes with `migration_source_held`; other creators'
holds and released holds do not block the request.

The local HTTP regression first reproduced a 201 work creation where 409 was
required, with the matching hold beyond 105 other holds. With the fix, work and
collection creation both reject and neither repository gains a record. The
existing regional-control-plane flow continues after the hold is released.

This closes a pagination bypass, not every regional-migration concurrency gap.
The read-side guard is not an atomic fence between the final check and mutation.
It still walks the cell-scoped hold repository rather than an indexed per-creator
lookup. Repeated cursors and page failures propagate as errors, not write grants.
No live migration or deployment is performed by these disposable tests.
