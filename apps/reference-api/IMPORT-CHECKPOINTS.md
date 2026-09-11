# Import checkpoint boundaries

Repository-v2 imports bind a retry ID to the authenticated target Creator, instance,
data home and exact manifest checksum. The checks apply before completed replay
and after idempotent checkpoint creation. Cross-creator IDs return a generic
conflict without returning checkpoint contents. Changed manifests require a new
ID. Explicit IDs must be non-empty strings of at most 200 characters.

Imported records, completed checkpoint and completion audit now share one repository
transaction. A failure in either final write rolls back all imported records.
The earlier running checkpoint can be marked failed and retried. A lost response
after a successful commit is resolved by rereading the matching completed receipt.
The checkpoint revision fences competing attempts. This relies on the adapter's
real transaction/CAS guarantees; it is not a waiver of cloud-adapter qualification.

Old checkpoints with a missing checksum or a different data home fail closed rather
than being silently rebound. Existing published source Works still import as ready,
publication receipts as draft, and assets as pending without transferred storage.
No original bytes are transferred and no provider publication is triggered.

These safeguards cover the repository-v2 path only. Creator-library content-v1
restore, full object transfer and complete migration/backup parity remain pending.
