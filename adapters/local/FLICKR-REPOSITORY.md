# Local Flickr repository

`LocalFlickrRepository(database, tenantId)` implements shared Flickr state storage
in SQLite with cell and tenant partitioning. Connections, migrations and pending
OAuth requests survive process restarts. OAuth consumption is an owner-bound
single DELETE RETURNING statement, including across database connections. Existing
database transactions can group writes or roll them back.

The adapter preserves the reference repository's first-inserted migration lookup
semantics. It stores supplied JSON, not plaintext credential material by design:
callers must supply encrypted credential fields or opaque vault references and
must check OAuth expiry. It does not itself encrypt arbitrary payload fields,
authorize creators, validate all record shapes or fence concurrent migration
updates. It is not a full local connector: routes, provider credentials, content
materialization, scanning and worker composition are still required.
