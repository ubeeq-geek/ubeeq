# Per-object export and regional transfer checksums

An asset's checksum identifies its original upload. Its active storage location
may identify a processed rendition with different bytes, length, and checksum.
Creator exports now describe the active location's checksum when recorded, and
schema-2 validation binds that inventory entry to the same location metadata.
Regional transfer inventories use each active/original location's own checksum.
The original asset checksum is not rewritten.

For compatibility, locations without a checksum retain the asset-checksum
fallback. This does not establish that a legacy rendition matches the original:
regional byte verification must still reject a mismatch before cutover. No
retained records or exports are repaired automatically. Previously generated
schema-2 manifests whose inventory contradicts an explicit storage checksum
must be regenerated from the source, not re-signed to bypass validation.

Tests use distinct original and rendition bytes through real local source and
destination endpoints, including transfer verification, atomic import failure,
retry, cutover, rollback, and retirement. Portability tests reject an inventory
bound to the original checksum when an explicit different active checksum exists.
This is local dev coverage, not live cloud migration qualification.
