# Durable local creator follows

`LocalCreatorFollowStore(database, tenantId)` supplies the persistence port for
`CreatorFollowService`. Migration 012 keys each relationship by cell, tenant,
user and creator. Re-follow atomically replaces that pair's record, including
notification preference; unfollow is an idempotent delete. Operations participate
in the local database transaction when called within it.

The adapter does not authorize actors, admit creators, send notifications, or
grant content access. Products must bind the shared service's authorization
callback and protect list responses. Lists include all matching records and are
not yet paginated. Product API/UI composition, notification delivery, audit and
privacy/export policy remain separate integration work.
