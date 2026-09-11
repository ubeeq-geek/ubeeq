# Regional manifest read binding

Immediately after reading the transferred manifest, the regional import endpoint
checks its actual byte length and SHA-256 against the checkpoint inventory entry.
After parsing, it validates the export and matches its manifest checksum, creator
ID and source cell/region to the checkpoint. These checks occur before any
repository access. A replaced object cannot rely on an earlier transfer verifier
or a newly calculated self-consistent export checksum alone.

The directory routing revision is not compared to the retained source-record
revision: rollback advances the directory independently in the current flow.
The exact exported metadata is still bound by the checkpoint manifest checksum.
Reconciliation of those revision lifecycles remains separate work.

Tests reject changed bytes/length, a different manifest checksum, foreign creator
and foreign source home before repository access. The existing two-cell local
transfer, rollback, retry and retirement test also passes. This does not add
per-asset read-time integrity checks, immutable destination version binding,
command authorization. Metadata atomicity is covered separately in
`ATOMIC-REGIONAL-IMPORT.md`. No live transfer is run.
