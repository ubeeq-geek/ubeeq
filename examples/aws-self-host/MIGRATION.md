# Migrating a local Ubeeq reference instance to AWS

This procedure moves portable creator metadata and original objects deliberately. It does not copy SQLite files into DynamoDB or grant cross-environment database access.

1. Stop writes to the local instance and back up its `ubeeq-data` volume.
2. Generate an authenticated creator manifest with `GET /v1/exports/me`. Keep the checksum reported by the API.
3. Deploy the optional CDK example and record the DynamoDB table, S3 bucket, SQS queue, Cognito pool/client, and Secrets Manager outputs.
4. Configure the AWS composition with those outputs. The reference API remains the same application; only its repository, storage, jobs, identity, and vault adapters change.
5. Import each manifest with `POST /v1/imports/validate`, resolve every conflict, then use `POST /v1/imports` with `dryRun: false` and a stable `importId`.
6. Transfer original objects separately to the private source bucket. Verify each source checksum and immutable version, then enqueue processing. Manifest import intentionally leaves transferred assets pending until this step succeeds.
7. Compare creator, Work, Asset, Collection, and publication counts; verify export checksums; then verify public delivery and job recovery against the AWS deployment.
8. Keep the local backup until the AWS deployment has passed a defined observation window. Roll back by restoring the local volume and routing traffic back; do not mutate the old local state after cutover unless rolling back.

Credentials, sessions, and encrypted connector values are never part of creator exports. Reconnect identities and integrations through their configured AWS adapters after the metadata and object migration is verified.
