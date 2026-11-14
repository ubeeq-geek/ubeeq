# Preparation records on canonical repositories

`@ubeeq/runtime/preparation-records` implements the existing persistence
`ContentPreparationStore` transaction port with the host's `UbeeqRepositories`.
Progress and receipts join canonical Work writes in the same transaction.
`transaction()` exposes that active transaction to the canonical-content bridge.

Call `prepareNewCreatorPreparationRecords` only from the trusted Creator factory,
inside its actual creation transaction. It creates the five empty kind roots.
Missing roots on existing Creators require an explicit, fenced inventory migration;
reads and writes never infer an empty history from an absent discovery index.

The namespace has one writer protocol. Point-read directory tries supply its
complete record inventory. Each kind root changes with every accepted write,
guarding both existing and absent records and lists used by dependent commands.
Read dependencies retain their conditions even when a command changes only
canonical content and leaves the preparation records unchanged.
Leaves split at 64 identities; the record history does not accumulate in one
growing ID aggregate. Payloads retain the original workflow IDs and JSON values.
Each payload remains subject to the safe per-record storage size limit.
The current limit is 300 KiB; legacy adoption must explicitly account for larger
payloads before switching their writer.

Nested operations join only while their owning transaction is open. Detached
continuations cannot reuse its cache after the callback or transaction finishes.
A failed nested write marks the whole unit for rollback, including when a caller
catches that error; canonical effects cannot commit without their progress record.

The adapter checks instance, cell, region and current Creator custody. The host
must authenticate the actor and retain current permission conditions in the same
transaction. Worker enumeration permission must never replace actor authorization.
Only this adapter or an explicitly fenced migration may write its namespace.

This is the record authority needed by a full preparation store. It does not
implement the canonical Work/asset/collection bridge, mount HTTP handlers,
initialize legacy libraries, publish content, or switch a serving application's
writer. Those bindings and their complete acceptance journeys remain required.
