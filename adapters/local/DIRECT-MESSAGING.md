# Persistent SQLite messaging

`SqliteDirectMessagingStore(database, instanceId, cellId)` accepts a synchronous
Node SQLite connection supplied by the host. The host owns database lifetime,
WAL/busy-timeout configuration, filesystem permissions, and persistent backups.
Use a dedicated persistent volume, not a Lambda temporary directory.

The store implements challenges, verified links, inbox claims, and outbound
replies. Link verification and revocation use transactions. Inbox admission has a
two-minute lease; `commitInboxReply` atomically saves a reply and completes the
matching claim. A stale processor cannot replace the winner. Recovery before
acknowledgement depends on signed webhook redelivery; raw message bodies and
link tokens are not persisted for background replay. Interrupted outbound sends
become uncertain rather than being resent automatically.

Instances cannot read, consume or revoke one another's links and challenges.
Ports must still check current Creator authorization before reading or sending
activity. This store does not provide HTTP authentication or provider credentials.

`startPeriodicWorkers` in `@ubeeq/jobs` starts non-overlapping periodic tasks.
Call and await `stop()` during host shutdown before closing the database; it
stops future ticks and drains already accepted work. Provider activation and
worker scheduling remain explicit host responsibilities.
