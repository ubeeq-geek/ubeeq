# Local favorite persistence

`LocalFavoriteStore(localDatabase, tenantId)` implements the shared
`FavoritePort` for `FavoriteService`. Migration 011 adds a table keyed by cell,
tenant, profile type/ID and target type/ID. The actor remains attribution, not part
of the favorite's identity. Duplicate adds preserve the original row; authorized
delegates can remove their profile's favorite regardless of its original actor.

Every statement uses the bound cell and tenant. Add/remove are single SQLite
statements and participate in `LocalSqliteDatabase.transaction` when composed
inside it. Target counts query the canonical rows, without a second mutable
counter. Tests reopen the database and verify rollback, duplicates and tenant
isolation through the shared service boundary.

The adapter is not an authorization boundary. Callers must check actor identity,
profile delegation and target eligibility; reads and counts also need product
admission before exposure. `listByProfile` includes private records and currently
materializes the complete result. It is not a public response or a scalable
paginated feed. Product HTTP/UI composition, audit/idempotency integration and
cloud adapter qualification remain separate work.
