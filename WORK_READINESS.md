# Work readiness and destination visibility

A Work is editable creator content. A Publication records its visibility at one
destination. A successful local publication leaves the Work `ready` and creates
the live Publication, request receipt and audit event atomically. The Work revision
still advances to fence the admitted content against concurrent edits or deletion.

Both operational publication HTTP paths join the live Creator and role authority
to that transaction, guard a complete source inventory and repeat admission before
writing any publication record. Sources must belong to the current Work, instance,
Creator and data home. Missing inventory guards fail closed. New attachments,
changed sources, actor revocation and newly inserted holds or approval evidence
cannot commit through an earlier successful policy result.

The persistence snapshot contract captures the actual complete inventory before
the write transaction and binds a conditional mutation marker at commit. SQLite
and PostgreSQL triggers maintain the marker with every record mutation. DynamoDB
uses strongly consistent base-table scans with before/after marker reads; each SDK
mutation advances the marker in the same atomic transaction. Bound lists use that
captured inventory plus staged writes. Unbound transactional Queries remain
forbidden, and no GSI is used as complete authorization or publication history.
Legacy records are read in full even when no marker exists; IDs, unknown metadata
and source records are retained. Snapshot guards cover inserts and deletes as well
as revisions, with one marker per repository rather than one per attached asset.

Public delivery and website sources require a ready Work, a live Publication,
ready assets and the existing live admission checks. Readiness alone grants no
public access. Draft, archived and deleted Works remain unavailable. Archived and
deleted Works must be restored before a new publication.

Destination withdrawal removes all matching live local receipts and records its
audit atomically. It preserves readiness and other destinations. Provider-aware
records continue to require their reviewed workflow. Repeating a completed
withdrawal creates no new audit. Deletion binds the complete publication inventory
and refuses any live receipt; its Work CAS also conflicts with publication.

Existing `published` Work values remain readable for compatibility and still
require live receipts for public access. Reads do not migrate them. An explicit
publication command writes `ready`; import retains its existing live-binding
removal policy. No content or publication authority is duplicated.

## Limits and release prerequisites

DynamoDB inventory markers are coarse per table/repository. Unrelated writes can
cause conservative revision conflicts, and capture currently scans the complete
table. All old or raw DynamoDB writers must be quiesced before enabling this
protocol: older writers do not advance these markers. The rollout must preserve
one authoritative writer and its compatible rollback artifact. Ordinary preflight
can conservatively deny stale evidence; only the guarded repeated check admits
publication. Every physical write/guard still counts toward DynamoDB's 100-item
transaction limit, including bulk receipt withdrawal.

This resolves a shared runtime integration defect. The complete retained rich
model, worker composition and shared applications remain separate required work;
their release and browser acceptance gates are not satisfied by these checks.
