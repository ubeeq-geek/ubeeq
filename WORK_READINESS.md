# Work readiness and destination visibility

A Work is editable creator content. A Publication records its visibility at one
destination. A successful local publication leaves the Work `ready` and creates
the live Publication, request receipt and audit event atomically. The Work revision
still advances to fence the admitted content against concurrent edits or deletion.

Public delivery and website sources require a ready Work, a live Publication,
ready assets and the existing live admission checks. Readiness alone grants no
public access. Draft, archived and deleted Works remain unavailable to those
readers. Archived and deleted Works must be restored before a new publication.

The destination withdrawal endpoint removes all its matching live local receipts
and records the audit in one transaction. It preserves the Work's readiness and
other destinations. Provider-aware records continue to require their reviewed
workflow. Repeating a completed withdrawal creates no new audit event. Deletion
checks every page of live receipts inside its content transaction; the Work CAS
also conflicts with a concurrent publication.

Existing `published` Work values remain readable for compatibility and still
require live receipts for public access. Reads do not migrate them. A later
explicit publication command writes `ready`; imported content continues to have
its live bindings removed through the existing import policy. No records, IDs,
source keys, metadata or original bytes are copied into a second authority.

This change resolves one shared runtime integration issue. It does not complete
the default retained host composition, shared applications, or release gates.
