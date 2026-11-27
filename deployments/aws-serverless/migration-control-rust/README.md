# Rust migration operator API

The AL2023 Lambda serves the IAM-protected regional operator API. It queries
the existing DynamoDB partitions, emits compatible pagination cursors, redacts
private cell locations, and enqueues commands in the existing SQS format.

Run `cargo test --locked` with Rust 1.100.0. The Rust migration control API
workflow packages the executable bootstrap for x86-64 Linux. Set CDK context
`rustMigrationControlApiAssetPath` or
`UBEEQ_RUST_MIGRATION_CONTROL_API_ASSET_PATH` to the ZIP or extracted directory
for the AWS multi-cell stack. Qualify the Function URL and approved role in
development before promoting this function.

## Migration SQS worker

Run `cargo test --locked --features worker` for the worker version. The same CI
workflow packages a separate worker executable as `bootstrap`. To use it, set
`rustMigrationControlWorkerAssetPath` or
`UBEEQ_RUST_MIGRATION_CONTROL_WORKER_ASSET_PATH` in multi-cell CDK synthesis.
The worker uses the existing queue, table, and registered private cell
functions. It returns failed SQS item identifiers for retries.

The S3 transfer stages one object at a time in Lambda temporary storage,
binds both buckets and cell prefixes to the active registry, and checks the
exported length and SHA-256 before a conditional destination write. A retry
reuses existing bytes only after verifying the migration identity and digest.
The Rust profile allocates 6 GiB of temporary storage. It uses single-object
PUTs, as the Node migration adapter does. The regional migration cell command
implementation is a separate port.

## Regional cell port status

The regional module validates command identity and cell/region scope, writes
source holds and releases with the existing DynamoDB snapshot fences, and
writes the existing destination audit records. The regional Lambda entry point
also needs the import and retirement operations before deployment.

The regional portability module implements the existing export checksum and
record graph checks. Its canonical encoder uses English collation, JavaScript
number formatting, and JSON array-index ordering. A vector from the Node
implementation verifies the cross-runtime digest. The module also prepares
asset transfer entries for the declared source and destination cells.
Regional export projects portable publication-image evidence and records a
versioned, conditionally written S3 manifest. An ambiguous write is reconciled
against the previously written bytes. Regional import, retirement and the
Lambda entry point are still required before deployment.

Regional import verifies the transferred manifest against both the byte digest
and the portable checksum. It checks asset inventory scope and verifies
destination bytes before writing records, preserves versioned rendition
references, and blocks integration credentials. Conditional creates and
snapshot guards protect destination retries. Regional retirement and the
Lambda entry point remain open.
