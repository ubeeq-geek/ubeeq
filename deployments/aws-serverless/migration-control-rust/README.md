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
