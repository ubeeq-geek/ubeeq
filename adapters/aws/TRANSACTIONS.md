# Repository transactions

`createDynamoRepositories().transaction()` stages repository Put/Delete commands
and commits one `TransactWriteCommand` with a client request token after the
callback succeeds. Callback failure discards staged writes. Independent async
contexts do not share batches, and expired/foreign explicit handles are rejected.
Point reads see staged records; other reads use strong consistency, not a
serializable multi-record snapshot. Conditions on writes are retained.

The supported batch is at most 100 distinct-item writes. Repeated writes to one
item and index queries inside the callback fail before committing. A caught
unsupported operation still aborts the batch. The service also enforces its
aggregate size and item limits; see [AWS TransactWriteItems](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_TransactWriteItems.html).
Do not split a failed batch into individual writes to bypass these limits.

Only repositories from this factory participate. Queue notifications, S3 writes,
standalone repositories and external services are not enlisted. In particular,
upload-to-queue atomicity still needs an outbox or equivalent recovery design.
Revision-condition cancellations with complete AWS cancellation reasons map to
the shared `OptimisticConcurrencyError`; other cancellations and ambiguous errors
remain unchanged. Point reads request strong consistency, and updates reject a
loaded revision that differs from the caller's expected revision. Idempotency
recovery still requires further work. Tests exercise
command staging and failure boundaries with a mock, not deployed DynamoDB.
