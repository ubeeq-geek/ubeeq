# Canonical source reuse capability

`CreatorContentSourceReuseStore` is a separate capability for committing an
existing asset's new membership, target Work revision and opaque source receipt
together. Consumers must not simulate it with independent writes. Provider
admission, storage safety and the choice of Work metadata remain consumer-owned.

The reference memory adapter checks tenant/creator scope, current source
membership, active source/target Works, checksum, the admitted asset snapshot,
target revision and append position. It stages all fallible copying before
replacing state, without creating or altering the existing asset. A matching
receipt replay preserves later target edits and requires that its target
attachment still exists. Removal is not repaired automatically. The original
source Work need not remain attached after the receipt has committed.

Receipts are cloned on reads and are included in the enumerable `sourceReceipts`
array for snapshot compositions. Memory staging is not disk durability: consumers
must persist/restore the complete checkpoint. Durable database implementations,
platform admission and source-discovery wiring remain separate work. The asset
snapshot comparison is conservative JSON equality, not a universal revision token.
