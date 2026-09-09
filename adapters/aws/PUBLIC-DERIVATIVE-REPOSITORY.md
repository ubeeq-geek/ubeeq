# Public derivative publication repository

`createDynamoPublicDerivativeRepository` preserves an existing single-PK
publication schema: `ASSET#`, `PUBLICATION#`, and `AUDIT#` records. It is separate
from the generic repository schema. Product and region identifiers are supplied
by consumers, not an embedded catalogue.

Begin conditionally claims a publication while checking the asset's product,
environment, home/canonical region, consumed processing entitlement, eligible
delivery state and current media version/scan group. Completion atomically
updates the receipt and asset with the supplied destination key and appends an
audit event. Failure only transitions a still-publishing receipt.

`completedReceipt` transactionally reads the receipt and current asset. It
returns persisted timestamps only for an exact publication identity, matching
current version/scan group, published destination key and consumed entitlement.
Missing, replaced, revoked or mismatched records return no result. Read errors
propagate. This performs no writes and is not a policy or delivery authorization.

This is a persistence adapter, not admission or recovery orchestration. Callers
must provide authoritative admitted records, configured cell tables and owned
object keys. It neither copies nor removes bytes. Service errors propagate
unchanged; ambiguous completion, interrupted attempts and cleanup reconciliation
remain caller responsibilities. It does not prove policy freshness beyond the
stored conditions or add a live data migration. Tests inspect mocked SDK writes;
they do not claim live DynamoDB conformance.
