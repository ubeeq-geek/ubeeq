import assert from "node:assert/strict";
import test from "node:test";
import { handler } from "../dist/lambda.js";

test("Lambda reference API exposes a cloud-neutral health response without dependency access", async () => {
  const response = await handler({ rawPath: "/health" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), { ok: true, service: "ubeeq-reference-api", runtime: "aws-lambda" });
});

test("Lambda reference API does not expose unmatched paths", async () => {
  const response = await handler({ rawPath: "/not-a-route" });
  assert.equal(response.statusCode, 404);
});
