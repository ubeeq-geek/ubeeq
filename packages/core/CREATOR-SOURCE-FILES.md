# Creator source-file metadata catalogue

`CreatorSourceFileService` provides creator-authorized list/create operations
over a tenant-bound compatibility port. It preserves additional product fields,
snapshots creation input before asynchronous admission and isolates records from
caller/store mutation. Creation validates basic identity and metadata shape.

This is not upload admission, object verification, publication permission or
download authorization. Products own commercial flags, request parsing, role
rules and access to referenced storage keys. The compatibility list still reads
the supplied catalogue before filtering; scoped pagination and atomic identifier
reservation require adapter work. This extraction does not claim those guarantees
or change the legacy store's collision semantics.

`listCreator(creatorId, { limit, cursor })` is the bounded alternative: admission
precedes the adapter read, limits are 1–100, and foreign-creator results are rejected.
It requires a scoped port; there is no catalogue-wide fallback.
`LocalCreatorSourceFileStore` binds that port to one cell and tenant, with an indexed
creator/ID page query and scope-bound continuation. Migration 017 adds the index.
Creates reserve IDs with INSERT rather than overwrite existing records. Additional
product fields survive restart. Pages are keyset reads, not a frozen snapshot;
these methods still provide no object custody or publication authorization.
