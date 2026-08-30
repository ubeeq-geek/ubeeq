/**
 * Deliberately opt-in real-service parity gate. It is not part of the default test
 * suite because it mutates the caller's isolated AWS self-host example resources.
 */
import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { createHash } from "node:crypto";
import { S3Client } from "@aws-sdk/client-s3";
import { SQSClient } from "@aws-sdk/client-sqs";
import { verifyIdentityAdapterContract } from "@ubeeq/auth";
import { verifyJobQueueContract } from "@ubeeq/jobs";
import { verifyRevisionedRepositoryContract } from "@ubeeq/persistence";
import { verifyObjectStorageContract } from "@ubeeq/storage";
import { AwsJobQueue, CognitoIdentity, DynamoRevisionedRepository, S3DirectUploadAdapter, S3ObjectStorage } from "../dist/index.js";

const required = ["UBEEQ_AWS_REGION", "UBEEQ_AWS_RECORDS_TABLE", "UBEEQ_AWS_OBJECT_BUCKET", "UBEEQ_AWS_JOBS_QUEUE_URL", "UBEEQ_AWS_USER_POOL_ID", "UBEEQ_AWS_USER_POOL_CLIENT_ID", "UBEEQ_AWS_TEST_USERNAME", "UBEEQ_AWS_TEST_PASSWORD"];
const missing = required.filter((name) => !process.env[name]);
if (missing.length) {
  console.error(`AWS live contract test requires: ${missing.join(", ")}`);
  process.exitCode = 2;
} else {
  const region = process.env.UBEEQ_AWS_REGION;
  const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
  const repositoryConfiguration = { tableName: process.env.UBEEQ_AWS_RECORDS_TABLE };
  const key = `aws-live-contract-${Date.now()}`;
  const jobId = `job-${createHash("sha256").update(key).digest("hex").slice(0, 32)}`;
  const directCellId = key;
  const directCreatorId = `creator-${Date.now()}`;
  const directBody = new TextEncoder().encode("ubeeq-direct-upload-contract");
  const directChecksum = createHash("sha256").update(directBody).digest("hex");
  const directObject = { bucket: process.env.UBEEQ_AWS_OBJECT_BUCKET, key: `cells/${directCellId}/creators/${directCreatorId}/uploads/${Date.now()}`, contentType: "text/plain", byteLength: directBody.byteLength, checksum: directChecksum, scope: "private" };
  const directStorage = new S3ObjectStorage(new S3Client({ region }), process.env.UBEEQ_AWS_OBJECT_BUCKET);
  let directCompleted;
  try {
    await verifyRevisionedRepositoryContract({ repository: new DynamoRevisionedRepository(dynamo, repositoryConfiguration, "liveContractCreators"), createRecord: (id) => ({ id, instanceId: "aws-live", handle: id, displayName: "AWS live contract" }), change: () => ({ displayName: "AWS updated" }) });
    await verifyObjectStorageContract(new S3ObjectStorage(new S3Client({ region }), process.env.UBEEQ_AWS_OBJECT_BUCKET, undefined, `cells/${key}`));
    const direct = new S3DirectUploadAdapter(new S3Client({ region }), process.env.UBEEQ_AWS_OBJECT_BUCKET);
    const initiated = await direct.initiate({ object: directObject, checksumAlgorithm: "sha256", expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const put = await fetch(initiated.parts[0].url, { method: "PUT", headers: { "content-type": directObject.contentType, "x-amz-checksum-sha256": Buffer.from(directChecksum, "hex").toString("base64"), "x-amz-meta-checksum": directChecksum, "x-amz-meta-scope": "private", "x-amz-meta-bytelength": String(directBody.byteLength) }, body: directBody });
    if (!put.ok) throw new Error(`Direct S3 upload failed with ${put.status}: ${await put.text()}`);
    directCompleted = await direct.complete({ uploadId: initiated.uploadId, cellId: directCellId, creatorId: directCreatorId, checksum: directChecksum, byteLength: directBody.byteLength });
    if (!directCompleted.versionId) throw new Error("Direct S3 upload did not return an immutable version.");
    await verifyJobQueueContract(new AwsJobQueue(dynamo, repositoryConfiguration, new SQSClient({ region }), process.env.UBEEQ_AWS_JOBS_QUEUE_URL), key);
    const identity = new CognitoIdentity(new CognitoIdentityProviderClient({ region }), process.env.UBEEQ_AWS_USER_POOL_ID, process.env.UBEEQ_AWS_USER_POOL_CLIENT_ID);
    const authenticated = await identity.authenticate({ username: process.env.UBEEQ_AWS_TEST_USERNAME, password: process.env.UBEEQ_AWS_TEST_PASSWORD });
    const session = await identity.verifySession({ credential: authenticated.token });
    if (!session) throw new Error("Cognito did not verify its own test-user access token");
    await verifyIdentityAdapterContract(identity, { credential: authenticated.token, subjectId: session.subject.id });
    console.log("AWS repository, storage, job, and identity conformance passed.");
  } finally {
    await directStorage.remove(directCompleted ?? directObject).catch(() => undefined);
    await dynamo.send(new DeleteCommand({ TableName: repositoryConfiguration.tableName, Key: { pk: `durableJobs#${jobId}`, sk: "record" } })).catch(() => undefined);
  }
}
