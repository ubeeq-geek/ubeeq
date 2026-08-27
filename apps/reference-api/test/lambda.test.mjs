import assert from "node:assert/strict";
import test from "node:test";
import { handler, worker } from "../dist/lambda.js";

Object.assign(process.env, {
  UBEEQ_PUBLIC_BASE_URL: "https://reference.example",
  UBEEQ_RECORDS_TABLE: "records",
  UBEEQ_SOURCE_BUCKET: "objects",
  UBEEQ_JOBS_QUEUE_URL: "https://sqs.example/jobs",
  UBEEQ_USER_POOL_ID: "pool",
  UBEEQ_USER_POOL_CLIENT_ID: "client",
  UBEEQ_CREDENTIAL_SECRET_PREFIX: "ubeeq/test",
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
