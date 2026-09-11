# Shared Flickr migration state

The integration package exports Flickr connection, OAuth request, migration,
collection, publication, provenance and item contracts plus `FlickrRepository`
and its in-memory reference implementation. Existing field names and state values
are retained for consuming applications; this extraction performs no backfill.

The reference repository clones values on writes and reads. OAuth requests are
consumed once per process only when both user and creator match. Expiry checking
remains the caller's responsibility. The repository does not provide durable
storage, multi-process fencing, schema validation or creator authorization.
Connection lookup returns the first inserted matching migration, not necessarily
the most recently updated one. These are existing semantics, not production
guarantees.

Provider clients and bounded source downloads are separate shared components.
Application routes, credential configuration, canonical content writes and scan
policy remain application responsibilities. Extracting these state contracts does
not yet extract the full migration orchestration or establish end-to-end parity.
