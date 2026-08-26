import assert from "node:assert/strict";
import test from "node:test";
import {
  AuthorizationDeniedError,
  isAuthorized,
  requireAuthorization
} from "../dist/index.js";

const subject = {
  id: "subject-1",
  roles: ["workspace.member", "workspace.editor"],
  scopes: ["work.read", "work.write"]
};

test("evaluates role and scope requirements without a built-in hierarchy", () => {
  assert.equal(isAuthorized(subject, {
    allRoles: ["workspace.member"],
    anyRoles: ["workspace.viewer", "workspace.editor"],
    allScopes: ["work.read"],
    anyScopes: ["work.publish", "work.write"]
  }), true);
  assert.equal(isAuthorized(subject, { anyRoles: ["instance.operator"] }), false);
  assert.equal(isAuthorized(subject, { allScopes: ["billing.manage"] }), false);
});

test("treats omitted requirements as unrestricted", () => {
  assert.equal(isAuthorized({ id: "anonymous", roles: [] }, {}), true);
});

test("throws a typed error for a missing product-defined permission", () => {
  const requirement = { allRoles: ["instance.operator"] };
  assert.throws(
    () => requireAuthorization(subject, requirement),
    (error) => error instanceof AuthorizationDeniedError && error.requirement === requirement
  );
});
