import assert from "node:assert/strict";
import test from "node:test";
import { advanceIntegrationCheckpoint, integrationRecoveryDecision } from "../dist/index.js";

test("ambiguous writes require remote reconciliation instead of blind retry", () => {
  for (const operation of ["publish", "update_remote", "delete_remote"]) {
    assert.deepEqual(integrationRecoveryDecision({ operation, code: "ambiguous_submission" }), {
      disposition: "reconcile_before_retry", requiresRemoteLookup: true
    });
  }
  assert.equal(integrationRecoveryDecision({ operation: "import", code: "ambiguous_submission" }).disposition, "terminal");
  assert.deepEqual(integrationRecoveryDecision({ operation: "publish", code: "rate_limited", retryAfterSeconds: 30 }), {
    disposition: "retry", retryAfterSeconds: 30, requiresRemoteLookup: false
  });
  assert.equal(integrationRecoveryDecision({ operation: "publish", code: "authentication_required" }).disposition, "reauthorize");
  assert.equal(integrationRecoveryDecision({ operation: "publish", code: "permission_denied" }).disposition, "policy_blocked");
});

test("overlapping pages preserve the high watermark and incomplete walks cannot look successful", () => {
  const checkpoint = {
    platform: "connector", connectionId: "account", resourceType: "work", resourceId: "catalogue",
    highWatermarkAt: "2026-09-03T00:00:00.000Z", recentRemoteIds: ["recent", "older"],
    lastSuccessfulAt: "2026-09-02T00:00:00.000Z"
  };
  const partial = advanceIntegrationCheckpoint(checkpoint, {
    items: [{ remoteId: "older", occurredAt: "2026-09-01T00:00:00.000Z" }], complete: false, nextCursor: "page-2"
  }, "2026-09-04T00:00:00.000Z", 2);
  assert.equal(partial.highWatermarkAt, checkpoint.highWatermarkAt);
  assert.equal(partial.lastSuccessfulAt, checkpoint.lastSuccessfulAt);
  assert.equal(partial.cursor, "page-2");
  assert.deepEqual(partial.recentRemoteIds, ["older", "recent"]);
  assert.throws(() => advanceIntegrationCheckpoint(checkpoint, { items: [], complete: false }), /continuation cursor/);
  const complete = advanceIntegrationCheckpoint(partial, { items: [], complete: true }, "2026-09-04T01:00:00.000Z");
  assert.equal(complete.cursor, undefined);
  assert.equal(complete.lastSuccessfulAt, "2026-09-04T01:00:00.000Z");
  assert.equal(checkpoint.lastSuccessfulAt, "2026-09-02T00:00:00.000Z");
});
