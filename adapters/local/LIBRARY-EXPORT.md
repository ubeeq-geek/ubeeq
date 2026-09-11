# Creator-library metadata snapshots

`readCreatorLibrarySnapshot(local, { tenantId, creatorId }, limits?)` reads the
compatibility library in one synchronous SQLite read transaction. It is not an
authorized endpoint: callers must authenticate, authorize and apply export policy
before returning resources to a user.

The snapshot contains all scoped Works, assets, attachments, collections and
collection memberships, including archived/deleted Works and detached retained
assets. It preserves product fields, slug history, source/rendition references
and ordering. It excludes the live `processingJobId` fence, queue state, object
bytes, credentials and records in other tables. Returned objects are detached
from storage. Unknown row kinds, foreign payload identity and dangling/duplicate
membership links fail rather than silently disappearing.

Defaults limit snapshots to 50,000 rows and 20 MiB of stored UTF-8 JSON. The count
and byte sum are checked within the same read snapshot before rows are loaded.
Over-budget reads reject completely; they do not truncate at a page boundary.
This is a bounded local metadata primitive, not a streaming export for arbitrarily
large libraries or an import validator. It does not validate every product field.

The product export bridge must still include creator identity and applicable
publication/integration records, enforce per-resource policy, distinguish retained
assets from current attachments, and declare object-transfer exclusions. A
corresponding validated restore and actual byte transfer remain necessary for
full portability. Do not substitute a repository-v2 export for this snapshot:
the compatibility library is deliberately not duplicated into those repositories.
