# AWS serverless multi-cell

This optional deployment owns the routing-directory, migration-checkpoint, and migration-cell registry control plane for independent AWS serverless cells. It stores only route/checkpoint/registered-resource metadata; creator records, source media, credentials, moderation evidence, queues, and backups remain in each cell.

Deploy this only after at least one [`../single-cell`](../single-cell) deployment exists. Configure each cell with the emitted directory table name, ARN, and region. The cell receives read-only routing access; an explicitly authorized migration worker receives directory write access.

## Migration execution

The stack creates a dedicated SQS command queue and a `MigrationControlWorker` Lambda. It consumes only `{ migrationId, operation: "resume" | "rollback" | "retire" }` commands. The worker resolves the source and destination from the operator-only cell registry, invokes their private migration endpoints, transfers only the exported S3 object inventory, verifies checksums/counts, and advances the checkpoint/routing revision atomically.

Before deployment, provide exact resource ARNs for the participating cells:

```sh
UBEEQ_MIGRATION_BUCKET_ARNS=arn:aws:s3:::source-cell-bucket,arn:aws:s3:::destination-cell-bucket \
UBEEQ_MIGRATION_FUNCTION_ARNS=arn:aws:lambda:us-east-2:123456789012:function:source-cell-migration,arn:aws:lambda:eu-central-1:123456789012:function:destination-cell-migration \
UBEEQ_MIGRATION_OPERATOR_PRINCIPAL_ARN=arn:aws:iam::123456789012:role/ubeeq-operator \
npm run deploy --workspace @ubeeq/deployment-aws-serverless-multi-cell
```

The worker has no wildcard S3 or Lambda permissions. For cross-account cells, each bucket policy must grant this worker role the listed object actions, and each cell migration Lambda must grant invocation to the worker role/account. Register only active cells after those permissions are in place. Public edge routing remains read-only and exposes only the cell HTTPS endpoint—not bucket names or Lambda ARNs.

The stack also outputs an AWS-IAM Function URL for operator diagnostics and lifecycle commands. Its handler independently verifies `UBEEQ_MIGRATION_OPERATOR_PRINCIPAL_ARN`; without that explicit value, every operator request is denied. It can list routes, migrations, and redacted cell status, then queue `resume`, `rollback`, or `retire` for a checkpoint. It never returns the registered bucket or migration-function ARN.

It also creates a migration operations dashboard and alarms for visible command backlog, dead-letter depth, and control-worker errors. Completed commands emit a non-secret transfer-byte metric for operational trend monitoring; it is not a billing ledger. Configure alarm actions in private operator infrastructure.

See [`../../../docs/aws-multi-cell-operator-runbook.md`](../../../docs/aws-multi-cell-operator-runbook.md) for registration, region selection, backup/recovery disclosure, migration/rollback, and production-readiness procedures.

The package native suite synthesizes the real stack and checks retained recovery state, IAM-only control access, queue/worker timing, operational alarms and exact configured migration-resource grants. Provider behavior is separately exercised by the opt-in two-cell development workflow. That workflow uses issued upload headers, stable publication retries, owned fixture teardown and serialized access to its fixed development cells.

## Deploying reference profiles to AWS development

Use the manual **Deploy Ubeeq AWS development profile** workflow from `main`.
The standalone choice deploys `UbeeqStandaloneDev` in `us-east-2`. The regional
choice updates the existing Ohio and Frankfurt development cells and their Ohio
control plane. It shares the concurrency group used by live validation.

Configure the protected `ubeeq-aws-dev-deploy` GitHub environment with
`UBEEQ_DEV_AWS_ACCOUNT_ID` and `UBEEQ_DEV_DEPLOY_ROLE_ARN`. Grant the OIDC role
access to the development CDK bootstrap roles, the selected stacks, and their
outputs. Bootstrap each selected region separately before dispatching.

For standalone, set `UBEEQ_DEV_SINGLE_BASE_URL` to the reviewed HTTPS API base
URL. For regional, set `UBEEQ_DEV_SOURCE_BASE_URL`,
`UBEEQ_DEV_DESTINATION_BASE_URL`, `UBEEQ_DEV_SOURCE_CELL_ID`,
`UBEEQ_DEV_DESTINATION_CELL_ID`, and `UBEEQ_DEV_MIGRATION_OPERATOR_ARN` to the
existing target identities. The workflow checks the account before deploying
and verifies the resulting API health endpoints.
