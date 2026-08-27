# Optional AWS self-host example

The CDK composition in [`packages/self-host-infra`](../../packages/self-host-infra) is the optional AWS implementation of Ubeeq ports. It provisions encrypted/versioned S3 stores, DynamoDB with point-in-time recovery, SQS with a dead-letter queue, EventBridge recovery scheduling, Cognito, Secrets Manager, and a dead-letter alarm.

It does not make AWS a Ubeeq requirement. Local and Compose reference deployments remain the default portable path. Before deployment, replace the inline health Lambda with an artifact built from `apps/reference-api` and select the AWS adapters through composition.

To synthesize, run `npm run synth:aws-self-host-infra` from the repository root. Keep production backup retention, alert routing, key management, domains, and network policy in your own deployment configuration.
