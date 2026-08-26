import assert from "node:assert/strict";
import test from "node:test";
import {
  INTEGRATION_CAPABILITIES,
  UnsupportedIntegrationOperationError,
  requireIntegrationOperation,
  runIntegrationConformanceSuite
} from "../dist/index.js";

const definition = {
  id: "example.connector",
  capabilities: ["connect", "publish"],
  credentialCustody: "application",
  ownerModel: "creator",
  connectionModel: "external_account"
};

test("exposes the supported integration capability vocabulary", () => {
  assert.deepEqual(INTEGRATION_CAPABILITIES, [
    "connect", "catalogue_import", "source_migration", "publish", "remote_update",
    "remote_delete", "engagement_read", "engagement_write", "webhook_receive", "reconcile"
  ]);
});

test("guards unsupported operations", () => {
  assert.doesNotThrow(() => requireIntegrationOperation(definition, "publish"));
  assert.throws(
    () => requireIntegrationOperation(definition, "reconcile"),
    UnsupportedIntegrationOperationError
  );
});

test("requires executable evidence for every conformance scenario", async () => {
  const passingAdapter = {
    integrationId: "example.connector",
    scenarios: Object.fromEntries([
      "oauth-expiry", "pagination", "rate-limit-backoff", "duplicate-retry",
      "remote-deletion", "unsupported-fields", "reconciliation"
    ].map((scenario) => [scenario, async () => ({ assertions: 1, summary: `${scenario} verified` })]))
  };
  await assert.doesNotReject(() => runIntegrationConformanceSuite(passingAdapter));

  const invalidAdapter = {
    ...passingAdapter,
    scenarios: { ...passingAdapter.scenarios, "oauth-expiry": async () => ({ assertions: 0, summary: "none" }) }
  };
  await assert.rejects(() => runIntegrationConformanceSuite(invalidAdapter), /did not report executable assertions/);
});
