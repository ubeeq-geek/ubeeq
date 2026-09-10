# Staged job-discovery indexes

This template supports the reference runtime's bounded indexed discovery. It
does not deploy itself, qualify historical jobs, or grant approval for a backfill.
Default synthesis remains unchanged. Context values are strings, not booleans.

| CDK context | Indexes added beyond repository-id-index | Runtime discovery |
| --- | --- | --- |
| omitted, or jobDiscoveryIndexStage=none | None | Legacy |
| jobDiscoveryIndexStage=cell | job-cell-due-index | Legacy |
| jobDiscoveryIndexStage=both | Both job indexes | Legacy |
| both plus jobDiscoveryQualified=true | Both job indexes | Indexed |

The second index is `job-cell-type-due-index`. Both use KEYS_ONLY projection and
numeric `jobDue`; partitions are `jobCell` and `jobCellType`, respectively.
See [adapter schema and qualification requirements](../../../adapters/aws/INDEXED-JOB-DISCOVERY.md).

## Existing-table procedure (requires separate execution approval)

1. First roll out queue attribute-writing code with legacy discovery. Keep that
   same packaged application asset and all unrelated context stable during index
   provisioning; inspect the actual change set for unrelated changes.
2. Advance from `none` to `cell` only. Confirm the table identity is unchanged,
   the existing repository index is preserved, and only one GSI is added.
3. Wait for the first index to be ACTIVE using DescribeTable, then separately
   advance to `both`. Wait for the second index to be ACTIVE as well.
4. Qualify historical queued/retry/leased attributes, actual index visibility,
   IAM permissions, claims and throughput. Index creation does not populate
   missing application attributes. Historical-data tooling remains unfinished.
5. Only after qualification, retain `both` and set `jobDiscoveryQualified=true`
   in a separate runtime update. This injects both names and the qualification
   assertion into API, worker and private cell runtimes, never the web runtime.

AWS permits only one GSI addition or deletion per table update. Stack completion
does not wait for index backfill to finish. AWS recommends avoiding unrelated
resource changes during index updates; failed rollback can require manual index
cleanup. See [CloudFormation DynamoDB table guidance](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-dynamodb-table.html).

CDK cannot know your deployed stage, index status or historical coverage. It
rejects invalid stage values and qualification without `both`, but cannot prevent
skipping stages, premature assertions or destructive downgrades. Never use a
stage downgrade as a runtime rollback. Keep `both` and set
`jobDiscoveryQualified=false` to remove runtime opt-in while retaining indexes;
legacy discovery still has its first-page starvation limitation. Persist stage
context in the operator's deployment configuration: forgetting it can propose
index deletion. Any index removal needs its own reviewed procedure.

## Offline verification

`npm test --workspace @ubeeq/deployment-aws-serverless-single-cell` compiles and
synthesizes temporary templates using a local fixture asset. Tests compare
successive stages, key schemas, retention, stable resource identities, unchanged
non-table resources, runtime-only qualification and invalid configurations.
These are not live DynamoDB acceptance tests or a deployed change-set review.
