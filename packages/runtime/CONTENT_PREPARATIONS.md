# Durable content preparation

`@ubeeq/runtime/content-preparations` provides the complete preparation coordinator:
drafts, authored and uploaded intake, arrangements, existing-content changes,
previews, versioned presets, review, private assembly, archive portability and
resumable child commands. It does not publish content or send announcements.

Bind `ContentWorkflowService` to the host's existing authoritative records with
`ContentPreparationStore` and `ContentPreparationHost`. These are required
capabilities, not optional extensions with sample implementations. A missing
capability or a storage authority without conditional transactions fails closed.

The store's transaction must atomically include canonical changes, progress,
receipts, and authorization/source read conditions. A process-local lock does not
satisfy this contract. Keep provider requests outside that transaction. Preserve
opaque organization fields and original record identities when adapting types.

The host supplies fresh product defaults, original-file verification, existing
metadata/setup behavior, volume validation and image compatibility projections.
Bind request authorization to the verified actor. Pass the verified actor ID to
`begin` and archive restoration; do not trust an actor ID from request JSON.

Recovery may use a privileged worker to enumerate accepted work. Its
`recoveryAuthorization(actorId)` must return live checks for the saved actor,
using the same transaction authority as the store. A cached permission snapshot
is insufficient. Every resumed child checks current edit access; collection
preparations also require current management access. Revocation retains already
accepted progress and receipts so an authorized retry can continue without
duplicating earlier children. Worker enumeration permission never grants the
saved actor permission to write.

The coordinator retains existing `content-workflow:` record namespaces, revision
conditions, operation fingerprints and deterministic child identities. Reviewed
preset requests include the selected version; legacy callers omitting that field
retain their original receipt digest. Transport adapters must expose reviewed
application separately when compatibility with an older server could otherwise
silently discard that field.

This module does not install HTTP routes, authenticate sessions, migrate legacy
data, or create a second content store. Hosts must bind those existing operations
and verify their complete route/worker journeys before switching authority.
