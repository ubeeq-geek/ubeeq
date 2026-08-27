import assert from "node:assert/strict";
import test from "node:test";
import { createReferenceApp } from "../src/server.mjs";

test("serves a neutral workspace and proxies only to the configured reference API", async (context) => {
  const upstream = await new Promise((resolve) => {
    const server = createReferenceApp();
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
  const app = createReferenceApp({ referenceApiUrl: `http://127.0.0.1:${upstream.address().port}` });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  context.after(() => { app.close(); upstream.close(); });
  const address = app.address();

  const health = await fetch(`http://127.0.0.1:${address.port}/health`);
  assert.deepEqual(await health.json(), { status: "ok" });
  const contracts = await fetch(`http://127.0.0.1:${address.port}/extension-contracts`);
  assert.deepEqual(await contracts.json(), {
    apiVersion: "1",
    contracts: ["brand", "moderation-policy", "billing-provider", "discovery", "integration-provider", "federation-policy", "operations"]
  });
  const workspace = await fetch(`http://127.0.0.1:${address.port}/workspace`);
  assert.match(await workspace.text(), /Ubeeq reference workspace/);
  const configuration = await fetch(`http://127.0.0.1:${address.port}/api-configuration`);
  assert.deepEqual(await configuration.json(), { apiPath: "/api", referenceApiUrl: `http://127.0.0.1:${upstream.address().port}` });
  const proxied = await fetch(`http://127.0.0.1:${address.port}/api/health`);
  assert.deepEqual(await proxied.json(), { status: "ok" });
});
