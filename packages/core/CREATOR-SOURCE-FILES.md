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
