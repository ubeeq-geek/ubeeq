# Persistence ports

`@ubeeq/persistence` defines durable, provider-neutral repository contracts. It contains no database driver or cloud SDK.

## Required adapter behavior

- Repository writes use optimistic revision checks and throw `OptimisticConcurrencyError` for stale writes.
- Adapters retain idempotency keys for a documented period and return the original result for a repeated key.
- Multi-record operations execute through `UbeeqRepositories.transaction` and commit atomically or roll back together.
- List operations use opaque cursors and stable ordering.
- Each adapter executes `verifyRevisionedRepositoryContract` for every revisioned repository it provides.

## Local implementation decision

The reference local adapter will use SQLite with checked-in, ordered migrations and transactional writes. SQLite belongs in `@ubeeq/adapters-local`, not in this port package. The adapter must publish its schema/migration compatibility policy and run this package's conformance fixture.

The optional DynamoDB implementation belongs in `@ubeeq/adapters-aws` and must satisfy the same contracts.
