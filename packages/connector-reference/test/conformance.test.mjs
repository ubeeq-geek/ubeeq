import test from "node:test";
import { runIntegrationConformanceSuite } from "@ubeeq/integrations";
import assert from "node:assert/strict";
import { ReferenceConnector, createReferenceConnectorConformance } from "../dist/index.js";
test("reference connector runs real stateful conformance scenarios", async () => { await runIntegrationConformanceSuite(createReferenceConnectorConformance()); });

test("reference connector keeps OAuth credentials opaque, schedules sync, and exposes normalized health", async () => {
  const states = new Map(); const writes = []; const jobs = [];
  const connector = new ReferenceConnector({
    oauthStates: { create: async (state) => states.set(state.id, state), consume: async (id) => { const state = states.get(id); states.delete(id); return state; } },
    vault: { write: async (input) => { writes.push(input); return { reference: "opaque-vault-reference" }; }, read: async () => undefined, revoke: async () => {} },
    jobs: { enqueue: async (input) => { jobs.push(input); return { id: "job-1", ...input, state: "queued", attempt: 0, availableAt: new Date().toISOString(), createdAt: "", updatedAt: "" }; } }
  });
  await connector.beginOAuth({ id: "oauth-1", integrationId: "reference.connector", cellId: "cell-a", ownerId: "creator-1", redirectUri: "https://local.test/callback", requiredScopes: ["works:read"], expiresAt: new Date(Date.now() + 60_000).toISOString() });
  const connected = await connector.completeOAuth({ stateId: "oauth-1", credential: Buffer.from("secret-token"), grantedScopes: ["works:read"], expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  assert.equal(connected.credentialReference, "opaque-vault-reference"); assert.equal(writes.length, 1); assert.equal(Buffer.from(writes[0].value).toString(), "secret-token");
  assert.equal(await connector.enqueueSync({ cellId: "cell-a", accountId: "account-1", credentialReference: connected.credentialReference, idempotencyKey: "sync-1" }), "job-1");
  assert.equal(jobs[0].type, "reference.connector.sync");
  assert.equal(connector.health({ tokenExpiresAt: "2020-01-01T00:00:00.000Z", grantedScopes: [], requiredScopes: ["works:read"] }).status, "blocked");
});
