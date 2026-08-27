import assert from "node:assert/strict";
import test from "node:test";
import { effectiveAuthorizationSubject } from "../dist/index.js";

test("merges only active creator delegations into an effective subject", () => {
  const subject = effectiveAuthorizationSubject(
    { id: "session", subject: { id: "person", roles: ["member"], scopes: ["work.read"] }, issuedAt: "now", expiresAt: "later", authenticationMethod: "oidc" },
    [
      { id: "active", creatorId: "creator", subjectId: "person", roles: ["creator.editor"], scopes: ["work.write"], expiresAt: "2027-01-01T00:00:00.000Z" },
      { id: "expired", creatorId: "creator", subjectId: "person", roles: ["creator.admin"], scopes: ["work.delete"], expiresAt: "2025-01-01T00:00:00.000Z" },
      { id: "other", creatorId: "other", subjectId: "person", roles: ["creator.admin"], scopes: ["work.delete"] }
    ],
    "creator",
    "2026-01-01T00:00:00.000Z"
  );
  assert.deepEqual(subject.roles, ["member", "creator.editor"]);
  assert.deepEqual(subject.scopes, ["work.read", "work.write"]);
});
