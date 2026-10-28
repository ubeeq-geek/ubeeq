# Collection destination contracts

`@ubeeq/core` exports storage-independent collection destination configuration,
observations, planning and execution contracts. Canonical Works remain members of
native collections; observed destination membership refers to remote Publication
identities. A role and a platform audience are separate values.

`validateCollectionMapping` enforces selection membership, one gallery owner, one
inbound membership authority and one authority per native metadata field. Callers
must enforce these constraints transactionally with their repositories.

`planCollectionDestination` is pure. It retains missing Publication blockers,
release/policy exclusions, membership additions and removals. Partial, restricted,
future-dated or stale observations cannot establish exactness. An exact comparison
requires equal Publication identities, including the representation variant.

`executeCollectionDestinationPlan` uses the supplied port to serialize both a
mapping and its remote gallery, fence every remote write against current revisions,
validate publication/access effects, retain stable operation keys, reconcile
uncertain results before retry, and verify success through complete API readback.
The port must durably store receipts and enforce leases. No provider credentials,
product pricing, entitlement rules or provider-specific permissions belong in core.

An execution adapter must obtain release, capability and access revisions from
current authoritative records. Passing cached revisions defeats fencing. A readback
must explicitly establish completeness; finishing pagination alone is insufficient
for restricted inventories. Manual confirmation is separate from API verification.
