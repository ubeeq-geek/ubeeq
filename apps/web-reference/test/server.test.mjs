import assert from "node:assert/strict";
import test from "node:test";
import { createReferenceApp } from "../src/server.mjs";

test("starts without hosted-product modules and exposes neutral contracts", async (context) => {
  const app = createReferenceApp();
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  context.after(() => app.close());
  const address = app.address();

  const health = await fetch(`http://127.0.0.1:${address.port}/health`);
  assert.deepEqual(await health.json(), { status: "ok" });
  const contracts = await fetch(`http://127.0.0.1:${address.port}/extension-contracts`);
  assert.deepEqual(await contracts.json(), {
    apiVersion: "1",
    contracts: ["brand", "moderation-policy", "billing-provider", "discovery", "integration-provider", "federation-policy", "operations"]
  });
});
