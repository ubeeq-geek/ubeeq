# AWS serverless single-cell example

The CDK composition in [`deployments/aws-serverless/single-cell`](../../../deployments/aws-serverless/single-cell) is the optional AWS serverless implementation of Ubeeq ports. It provisions encrypted/versioned S3 stores, DynamoDB with point-in-time recovery, SQS with a dead-letter queue, EventBridge recovery scheduling, Cognito, Secrets Manager, and a dead-letter alarm.

It does not make AWS a Ubeeq requirement. Local and Compose reference deployments remain the default portable path. The deployment packages `apps/reference-api` with its Ubeeq and AWS runtime dependencies, then composes the same `/v1` API against DynamoDB, S3, SQS, Cognito, and Secrets Manager ports.

To synthesize, run `npm run synth:aws-serverless-single-cell` from the repository root. Each deployment is one regional cell, so choose a stable cell identifier before deploying. To deploy, set `UBEEQ_REFERENCE_API_PUBLIC_BASE_URL` to the HTTPS URL users will reach (normally a custom domain) and run:

```sh
UBEEQ_CELL_ID=community-us-east-2 \
UBEEQ_CELL_REGION=us-east-2 \
UBEEQ_REFERENCE_API_PUBLIC_BASE_URL=https://ubeeq.example \
npm run deploy --workspace @ubeeq/deployment-aws-serverless-single-cell -- --require-approval never
```

To map the API Gateway edge to a delegated Route 53 zone, also provide a regional ACM certificate, zone name, and hosted-zone ID. The API hostname may be the zone apex or a subdomain such as `api.dev-demo.example`:

```sh
UBEEQ_REFERENCE_API_PUBLIC_BASE_URL=https://api.dev-demo.example \
UBEEQ_REFERENCE_API_DOMAIN_NAME=api.dev-demo.example \
UBEEQ_REFERENCE_WEB_DOMAIN_NAME=dev-demo.example \
UBEEQ_PUBLIC_HOSTED_ZONE_NAME=dev-demo.example \
UBEEQ_PUBLIC_HOSTED_ZONE_ID=<delegated-public-zone-id> \
UBEEQ_REFERENCE_API_CERTIFICATE_ARN=<regional-acm-certificate-arn> \
npm run deploy --workspace @ubeeq/deployment-aws-serverless-single-cell -- --require-approval never
```

The stack creates separate regional API Gateway domains: the reference web at the hosted-zone apex and the API at the configured API hostname. It creates each `$default` mapping and its Route 53 alias record. A regional API Gateway certificate must be issued in the API’s region and cover both names.

The cell ID and region are injected into the API and worker, emitted as stack outputs, and applied as `ubeeq:cell-id`/`ubeeq:cell-region` resource tags. Create another independent stack for another region; do not enable DynamoDB Global Tables or S3 cross-region replication for normal operation. The adapter rejects a record, job, credential, upload, delivery object, or object key that belongs to a different cell.

For a managed multi-cell deployment, deploy the control plane first and supply its emitted `MigrationControlWorker` role ARN when deploying each participating cell. This adds a resource-policy permission for that exact worker role to invoke the cell's otherwise private migration handler; it does not grant account-wide invocation access:

```sh
UBEEQ_MIGRATION_CONTROL_WORKER_PRINCIPAL_ARN=arn:aws:iam::123456789012:role/MigrationControlWorkerRole \
npm run deploy --workspace @ubeeq/deployment-aws-serverless-single-cell
```

The multi-cell worker still needs separately scoped IAM and bucket-policy permissions for the registered source and destination stores. See [`../../../deployments/aws-serverless/multi-cell/README.md`](../../../deployments/aws-serverless/multi-cell/README.md).

The emitted Function URL is IAM-protected for operator diagnostics. The stack also emits `ReferenceApiGatewayUrl`, the HTTP API edge for the reference API; it passes requests to the API, whose protected routes validate Cognito bearer tokens through the identity port. Do not treat either generated hostname as a production public base URL. AWS uploads return a checksum-bound, time-limited S3 PUT URL; upload content goes directly to S3 and then `/v1/uploads/{uploadId}/complete` records the immutable object version. SQS invokes the bundled worker Lambda to process the completed asset.

Keep production backup retention, alert routing, key management, domains, and network policy in your own deployment configuration. See [BACKUP_RESTORE.md](BACKUP_RESTORE.md) for the operational runbook.

After deploying an isolated stack and creating a disposable Cognito test user, use its outputs to run the real-service adapter gate:

```sh
UBEEQ_AWS_REGION=us-east-2 \
UBEEQ_AWS_RECORDS_TABLE=<RecordsTableName> \
UBEEQ_AWS_OBJECT_BUCKET=<SourceStoreName> \
UBEEQ_AWS_JOBS_QUEUE_URL=<JobsQueueUrl> \
UBEEQ_AWS_USER_POOL_ID=<UserPoolId> \
UBEEQ_AWS_USER_POOL_CLIENT_ID=<UserPoolClientId> \
UBEEQ_AWS_TEST_USERNAME=<disposable-user> \
UBEEQ_AWS_TEST_PASSWORD=<disposable-password> \
npm run test:live --workspace @ubeeq/adapter-aws
```

This gate creates and removes isolated contract records and objects, enqueues a contract job, and revokes the disposable user's session.

To exercise the complete HTTP path after the stack emits `ReferenceApiGatewayUrl`, run the separate opt-in flow with the same disposable user:

```sh
UBEEQ_AWS_API_URL=<ReferenceApiGatewayUrl> \
UBEEQ_AWS_REGION=us-east-2 \
UBEEQ_AWS_RECORDS_TABLE=<RecordsTableName> \
UBEEQ_AWS_OBJECT_BUCKET=<SourceStoreName> \
UBEEQ_AWS_USER_POOL_CLIENT_ID=<UserPoolClientId> \
UBEEQ_AWS_TEST_USERNAME=<disposable-user> \
UBEEQ_AWS_TEST_PASSWORD=<disposable-password> \
npm run test:aws --workspace @ubeeq/reference-api
```

It creates a marked creator/work/object set, verifies direct upload through delivery, and removes only that test data afterward.

See [MIGRATION.md](MIGRATION.md) for the supported local SQLite/filesystem migration path.
