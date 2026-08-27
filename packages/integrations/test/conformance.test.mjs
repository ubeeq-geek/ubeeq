import assert from "node:assert/strict";
import test from "node:test";
import {
  INTEGRATION_CAPABILITIES,
  UnsupportedIntegrationOperationError,
  requireIntegrationOperation,
  runIntegrationConformanceSuite,
  recordRemotePublicationState,
  scheduleRemotePublicationRetry,
  stableReconciliationJson,
  diffReconciliationSnapshots,
  reconciliationStatus,
  resolveReconciliation
  ,requireValidOAuthState, deriveIntegrationAccountHealth, classifyIntegrationFailure
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

test("normalizes OAuth expiry, scopes, cooldowns, and failure classifications", () => {
  assert.throws(() => requireValidOAuthState({ id: "state", integrationId: "connector", ownerId: "creator", redirectUri: "https://local.example/callback", requiredScopes: [], expiresAt: "2026-01-01T00:00:00.000Z" }, new Date("2026-01-01T00:01:00.000Z")), /expired/);
  const health = deriveIntegrationAccountHealth({ tokenExpiresAt: "2027-01-01T00:00:00.000Z", grantedScopes: ["read"], requiredScopes: ["read", "write"], cooldownUntil: "2026-01-01T01:00:00.000Z", now: new Date("2026-01-01T00:00:00.000Z") });
  assert.deepEqual(health, { status: "blocked", tokenExpiresAt: "2027-01-01T00:00:00.000Z", grantedScopes: ["read"], missingScopes: ["write"], cooldownUntil: "2026-01-01T01:00:00.000Z", lastSuccessfulSyncAt: undefined, remediation: ["grant_scopes", "wait_for_cooldown"] });
  assert.equal(classifyIntegrationFailure({ status: 429 }), "rate_limit"); assert.equal(classifyIntegrationFailure({ code: "invalid_token" }), "authentication");
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

test("records remote publication state and preserves retry idempotency", () => {
  const publication = { status: "live", sync: { status: "in_sync", errorCode: "OLD", errorMessage: "old" }, updatedAt: "before" };
  const active = recordRemotePublicationState(publication, "active", { observedAt: "2026-01-01T00:00:00.000Z" });
  assert.equal(active.status, "live");
  assert.equal(active.sync.status, "in_sync");
  assert.equal(active.sync.errorCode, undefined);
  const deleted = recordRemotePublicationState(active, "deleted", { observedAt: "2026-01-02T00:00:00.000Z", reason: "removed remotely" });
  assert.equal(deleted.status, "removed");
  assert.equal(deleted.sync.remoteState, "missing");
  assert.equal(deleted.sync.errorCode, "REMOTE_DELETED");

  const first = scheduleRemotePublicationRetry(deleted, { idempotencyKey: "key-1", connectionCooldownUntil: "later", now: "now" });
  const second = scheduleRemotePublicationRetry(first, { idempotencyKey: "key-2", now: "later" });
  assert.deepEqual(second.sync.retry, { idempotencyKey: "key-1", attempt: 2, connectionCooldownUntil: "later", nextAttemptAt: undefined });
});

test("normalizes, classifies, and explicitly resolves reconciliation", () => {
  assert.equal(stableReconciliationJson({ tags: ["b", "a"], title: "Work" }), stableReconciliationJson({ title: "Work", tags: ["a", "b"] }));
  const nonConflicting = diffReconciliationSnapshots({ title: "Original", tags: ["one"] }, { title: "Local", tags: ["one"] }, { title: "Original", tags: ["two"] });
  assert.equal(reconciliationStatus(nonConflicting), "non_conflicting_changes");
  const conflict = diffReconciliationSnapshots({ title: "Original" }, { title: "Local" }, { title: "Remote" });
  assert.equal(reconciliationStatus(conflict), "conflict");
  assert.throws(() => resolveReconciliation({}, {}, { action: "accept_remote", confirmed: false }), /confirmation/);
  assert.deepEqual(
    resolveReconciliation({ title: "Local" }, { title: "Remote", remoteId: "provider-id" }, { action: "create_detached_copy", confirmed: true }, { detachedCopyExcludedKeys: ["remoteId"] }),
    { local: { title: "Local" }, detachedCopy: { title: "Remote" } }
  );
});
