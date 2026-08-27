# Optional AWS self-host example

The CDK composition in [`packages/aws-self-host-infra`](../../packages/aws-self-host-infra) is the optional AWS implementation of Ubeeq ports. It provisions encrypted/versioned S3 stores, DynamoDB with point-in-time recovery, SQS with a dead-letter queue, EventBridge recovery scheduling, Cognito, Secrets Manager, and a dead-letter alarm.

It does not make AWS a Ubeeq requirement. Local and Compose reference deployments remain the default portable path. Before deployment, replace the inline health Lambda with an artifact built from `apps/reference-api` and select the AWS adapters through composition.

To synthesize, run `npm run synth:aws-self-host-infra` from the repository root. Keep production backup retention, alert routing, key management, domains, and network policy in your own deployment configuration.

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
npm run test:live --workspace @ubeeq/adapters-aws
```

This gate creates and removes isolated contract records and objects, enqueues a contract job, and revokes the disposable user's session.

See [MIGRATION.md](MIGRATION.md) for the supported local SQLite/filesystem migration path.
