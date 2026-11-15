# Retained original files

`RepositoryRetainedSourceFiles` extends the retained repository with complete
original-file records and the established source mutation rules. It does not
rewrite file IDs, storage keys, unknown JSON fields or audit events. Original
metadata is separate from permission to read private bytes.

One live `resolveSourceAccess` binding supplies the actual guarded account,
platform-role and owner/member evidence. Canonical content authorization and
source mutation checks use that same authority. A canonical Creator ownership
record can prove ownership without synthesizing a membership. Existing member
and administrator evidence remains conditional, including changes between two
roles that could both edit content. Hosts must deny inactive/customer actors and
join all durable role guards to the supplied transaction.

Source, preparation commands and audit writes commit together. The audit uses
the ordinary audit repository; its full retained event, business ID and original
timestamp remain inside one payload. The surrounding repository metadata does
not replace those values. Repeated audit identities and stale source snapshots
cannot overwrite a prior event. Source rows with missing ownership or a mismatched
file ID require reconciliation instead of disappearing from the inventory.

Cancellation applies to pending uploads. A completed original cannot be changed
back to pending or cancelled. Cancellation metadata is the durable cleanup queue,
matching the retained local host: no second editable queue is created. Cleanup
deletes through the required physical storage driver and schedules another check
for a previously issued upload arriving late. Failed deletion stores retry
evidence; it does not claim completed deletion or quota closure.

Cleanup checkpoints can run after member revocation or Creator deletion begins.
Their maintenance authority permits exactly the checked cancelled-source update
and its generated audit. It cannot create a Work, change a publication or append
an unrelated event. Ordinary writes still require a current actor and reject a
Creator undergoing deletion. Persistence retains history for authorized admin
readers; HTTP authorization remains the host's responsibility.

`runNextJob()` attempts one due original, while `tick()` preserves the existing
bounded batch behavior. Physical deletion must be idempotent: competing workers
can repeat a deletion attempt, but the source revision and audit commit are
conditional. The source file retains its cancellation and retry history across
restarts. Paging cursors bind to the instance, tenant and Creator.

## Integration still required

This is not the default product composition. The shared commercial host still
needs the complete actual account/role, original upload/closure, private storage,
quota, organization, metadata and provider bindings, followed by the connected
browser/admin applications. This module does not issue upload URLs, certify quota
closure or pretend an absent storage provider succeeded. The physical storage
driver must preserve exact-key ownership checks and all-version deletion before
this worker is enabled. Existing data still requires a fenced complete migration.

Inventories currently materialize one Creator's records under the repository
snapshot protocol. Global aggregation, paged managed discovery, large-record and
transaction capacity, and product release acceptance remain separate requirements.
