/**
 * Deliberately opt-in real-service parity gate. It is not part of the default test
 * suite because it mutates the caller's isolated AWS self-host example resources.
 */
import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { SQSClient } from "@aws-sdk/client-sqs";
import { verifyIdentityAdapterContract } from "@ubeeq/auth";
import { verifyJobQueueContract } from "@ubeeq/jobs";
import { verifyRevisionedRepositoryContract } from "@ubeeq/persistence";
import { verifyObjectStorageContract } from "@ubeeq/storage";
import { AwsJobQueue, CognitoIdentity, DynamoRevisionedRepository, S3ObjectStorage } from "../dist/index.js";

const required = ["UBEEQ_AWS_REGION", "UBEEQ_AWS_RECORDS_TABLE", "UBEEQ_AWS_OBJECT_BUCKET", "UBEEQ_AWS_JOBS_QUEUE_URL", "UBEEQ_AWS_USER_POOL_ID", "UBEEQ_AWS_USER_POOL_CLIENT_ID", "UBEEQ_AWS_TEST_USERNAME", "UBEEQ_AWS_TEST_PASSWORD"];
const missing = required.filter((name) => !process.env[name]);
if (missing.length) {
  console.error(`AWS live contract test requires: ${missing.join(", ")}`);
  process.exitCode = 2;
} else {
  const region = process.env.UBEEQ_AWS_REGION;
  const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
  const repositoryConfiguration = { tableName: process.env.UBEEQ_AWS_RECORDS_TABLE };
  await verifyRevisionedRepositoryContract({ repository: new DynamoRevisionedRepository(dynamo, repositoryConfiguration, "liveContractCreators"), createRecord: (id) => ({ id, instanceId: "aws-live", handle: id, displayName: "AWS live contract" }), change: () => ({ displayName: "AWS updated" }) });
  await verifyObjectStorageContract(new S3ObjectStorage(new S3Client({ region }), process.env.UBEEQ_AWS_OBJECT_BUCKET));
  await verifyJobQueueContract(new AwsJobQueue(dynamo, repositoryConfiguration, new SQSClient({ region }), process.env.UBEEQ_AWS_JOBS_QUEUE_URL), `aws-live-contract-${Date.now()}`);
  const identity = new CognitoIdentity(new CognitoIdentityProviderClient({ region }), process.env.UBEEQ_AWS_USER_POOL_ID, process.env.UBEEQ_AWS_USER_POOL_CLIENT_ID);
  const authenticated = await identity.authenticate({ username: process.env.UBEEQ_AWS_TEST_USERNAME, password: process.env.UBEEQ_AWS_TEST_PASSWORD });
  const session = await identity.verifySession({ credential: authenticated.token });
  if (!session) throw new Error("Cognito did not verify its own test-user access token");
  await verifyIdentityAdapterContract(identity, { credential: authenticated.token, subjectId: session.subject.id });
  console.log("AWS repository, storage, job, and identity conformance passed.");
}
