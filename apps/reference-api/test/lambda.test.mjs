import assert from "node:assert/strict";
import test from "node:test";
import { handler, migrationControlApi, migrationControlWorker, web, worker } from "../dist/lambda.js";

Object.assign(process.env, {
  UBEEQ_PUBLIC_BASE_URL: "https://reference.example",
  UBEEQ_RECORDS_TABLE: "records",
  UBEEQ_SOURCE_BUCKET: "objects",
  UBEEQ_JOBS_QUEUE_URL: "https://sqs.example/jobs",
  UBEEQ_USER_POOL_ID: "pool",
  UBEEQ_USER_POOL_CLIENT_ID: "client",
  UBEEQ_CREDENTIAL_SECRET_PREFIX: "ubeeq/test",
  UBEEQ_REFERENCE_WEB_API_URL: "https://api.example",
  UBEEQ_REFERENCE_WEB_MODULE_PATH: "../../web-reference/src/server.mjs",
  UBEEQ_ROUTING_DIRECTORY_TABLE_NAME: "routing-control",
  UBEEQ_ROUTING_DIRECTORY_REGION: "us-east-2",
  UBEEQ_MIGRATION_COMMANDS_QUEUE_URL: "https://sqs.example/migrations",
  UBEEQ_MIGRATION_OPERATOR_PRINCIPAL_ARN: "arn:aws:iam::123456789012:role/ubeeq-operator",
});

test("Lambda reference API composes the standard health route without dependency access", async () => {
  const response = await handler({ rawPath: "/health" });
  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body).ok, true);
});

test("Lambda reference API exposes the standard unmatched-route error", async () => {
  const response = await handler({ rawPath: "/not-a-route" });
  assert.equal(response.statusCode, 404);
  assert.equal(JSON.parse(response.body).error.code, "not_found");
});

test("Lambda worker accepts an empty SQS batch without initializing a local adapter", async () => {
  assert.deepEqual(await worker({ Records: [] }), { batchItemFailures: [] });
});

test("migration control worker accepts an empty operator queue batch", async () => {
  assert.deepEqual(await migrationControlWorker({ Records: [] }), { batchItemFailures: [] });
});

test("migration control API rejects a request without its allow-listed IAM operator", async () => {
  const response = await migrationControlApi({ rawPath: "/v1/operations/regional/routes", requestContext: { http: { method: "GET" } } });
  assert.equal(response.statusCode, 403);
  assert.equal(JSON.parse(response.body).error.code, "operator_authorization_denied");
});

test("migration control API accepts an allow-listed principal at the transport boundary", async () => {
  const response = await migrationControlApi({ rawPath: "/not-a-route", requestContext: { http: { method: "GET" }, authorizer: { iam: { userArn: "arn:aws:iam::123456789012:role/ubeeq-operator" } } } });
  assert.equal(response.statusCode, 404);
});

test("Lambda reference web serves the same neutral workspace at the edge", async () => {
  const response = await web({ rawPath: "/", requestContext: { http: { method: "GET" } } });
  assert.equal(response.statusCode, 200);
  assert.match(response.body, /Ubeeq reference workspace/);
});
