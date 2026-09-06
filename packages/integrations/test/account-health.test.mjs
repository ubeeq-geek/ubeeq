import test from "node:test";
import assert from "node:assert/strict";
import { projectIntegrationAccountHealth as project } from "../dist/index.js";

const nowMs = Date.parse("2026-08-25T12:00:00Z");
const options = { nowMs, expiryWarningWindowMs: 1000 };
const account = (changes = {}) => ({ connectionStatus: "connected", ...changes });
const at = (offset) => new Date(nowMs + offset).toISOString();

test("expiry boundaries use the supplied clock and product warning window", () => {
  for (const [offset, token, state] of [[-1, "expired", "authentication_required"], [0, "expired", "authentication_required"],
    [1, "expires_soon", "attention"], [1000, "expires_soon", "attention"], [1001, "valid", "connected"]]) {
    const result = project(account({ tokenExpiresAt: at(offset) }), options);
    assert.equal(result.token.status, token); assert.equal(result.state, state);
  }
  assert.equal(project(account({ tokenExpiresAt: at(1) }), { ...options, expiryWarningWindowMs: 0 }).state, "connected");
  for (const tokenExpiresAt of [undefined, "", "invalid"]) assert.equal(project(account({ tokenExpiresAt }), options).token.status, "unknown");
});

test("durable state outranks cooldown, and active cooldown outranks expiry", () => {
  for (const connectionStatus of ["disabled", "authentication_required", "temporarily_unavailable", "rate_limited", "custom_pending"]) {
    assert.equal(project(account({ connectionStatus, tokenExpiresAt: at(-1), rateLimitedUntil: at(10) }), options).state, connectionStatus);
  }
  assert.equal(project(account({ tokenExpiresAt: at(-1), rateLimitedUntil: at(10) }), options).state, "rate_limited");
  for (const rateLimitedUntil of [at(0), at(-1), "invalid", undefined]) {
    const result = project(account({ tokenExpiresAt: at(-1), rateLimitedUntil }), options);
    assert.equal(result.state, "authentication_required"); assert.equal(result.sync.coolingDown, false);
  }
});

test("projection retains diagnostic metadata but excludes credentials and product decisions", () => {
  const input = account({ accessTokenEncrypted: "secret", provider: "private-provider", grantedScopes: ["read"],
    lastIssue: { code: "network", message: "Unavailable", remediation: "Retry", occurredAt: at(-10) },
    lastSyncAttemptAt: at(-20), lastSuccessfulSyncAt: at(-30) });
  const result = project(input, options);
  assert.equal(result.state, "attention");
  assert.equal(result.sync.lastAttemptAt, input.lastSyncAttemptAt);
  assert.equal(result.sync.lastSuccessfulAt, input.lastSuccessfulSyncAt);
  assert.deepEqual(result.issue, input.lastIssue);
  assert.equal("accessTokenEncrypted" in result, false);
  assert.equal("provider" in result, false);
  assert.equal("capabilities" in result, false);
  assert.equal("recommendedAction" in result, false);
  result.token.grantedScopes.push("write"); result.issue.message = "Changed";
  assert.deepEqual(input.grantedScopes, ["read"]); assert.equal(input.lastIssue.message, "Unavailable");
});

test("invalid clocks and warning windows fail explicitly", () => {
  for (const nowMs of [NaN, Infinity, -Infinity]) assert.throws(() => project(account(), { ...options, nowMs }));
  for (const expiryWarningWindowMs of [-1, NaN, Infinity]) assert.throws(() => project(account(), { ...options, expiryWarningWindowMs }));
});
