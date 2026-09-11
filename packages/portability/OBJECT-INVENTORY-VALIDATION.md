# Schema-2 export object inventories

`validateCreatorExport` requires exactly one inventory entry for every asset.
Repeated asset entries cannot substitute for an omitted asset, even if the
inventory length and manifest checksum are otherwise valid.

Each entry must match its asset checksum and the storage version when present,
or the legacy `objectVersion` otherwise. Recorded storage keys and byte lengths
must also match. Inventory state remains `manifest_only`; a caller cannot turn
metadata into proof of byte transfer by changing that field and recalculating
the manifest checksum. Legacy assets without storage key/size metadata remain
supported, but still require matching checksum and version.

This validates internal metadata consistency, not authenticity, object access,
actual byte integrity or a completed backup. Storage references remain untrusted.
The reference API and regional migration handler consume this validator; this
change does not execute an import, transfer bytes or qualify the whole restore
path. The separate content-v1 product export format is unchanged.
