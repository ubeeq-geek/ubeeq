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
