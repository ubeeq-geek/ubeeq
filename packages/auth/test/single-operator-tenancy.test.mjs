import test from "node:test";
import assert from "node:assert/strict";
import {
  SingleOperatorTenancyAdapter,
  createSingleOperatorTenancyAdapter
} from "../dist/single-operator-tenancy.js";
import {
  SingleOperatorLimitError,
  FeatureDisabledInSingleOperatorModeError
} from "@ubeeq/extension-sdk";

test("single operator creation allows first creator user", async () => {
  const tenancy = new SingleOperatorTenancyAdapter();
  await tenancy.assertCanCreateCreatorUser({
    existingCreatorUserCount: 0,
    actorUserId: "user-op-1"
  });
  assert.equal(await tenancy.getOperatorUserId(), "user-op-1");
});

test("single operator creation allows same operator multiple creator identities", async () => {
  const tenancy = createSingleOperatorTenancyAdapter({
    operatorUserId: "user-op-1"
  });
  // Same operator should succeed
  await assert.doesNotReject(async () => {
    await tenancy.assertCanCreateCreatorUser({
      existingCreatorUserCount: 1,
      actorUserId: "user-op-1"
    });
  });
  assert.equal(await tenancy.getOperatorUserId(), "user-op-1");
});

test("single operator creation rejects second creator user", async () => {
  const tenancy = new SingleOperatorTenancyAdapter({
    operatorUserId: "user-op-1"
  });
  await assert.rejects(
    async () => {
      await tenancy.assertCanCreateCreatorUser({
        existingCreatorUserCount: 1,
        actorUserId: "user-op-2"
      });
    },
    (err) => {
      assert(err instanceof SingleOperatorLimitError);
      assert.equal(err.code, "SINGLE_OPERATOR_INSTANCE_LIMIT");
      assert.equal(err.statusCode, 403);
      return true;
    }
  );
});

test("rejects when existing count >= 1 and actor is unknown", async () => {
  const tenancy = new SingleOperatorTenancyAdapter();
  await assert.rejects(
    async () => {
      await tenancy.assertCanCreateCreatorUser({
        existingCreatorUserCount: 1
      });
    },
    (err) => {
      assert(err instanceof SingleOperatorLimitError);
      assert.equal(err.code, "SINGLE_OPERATOR_INSTANCE_LIMIT");
      return true;
    }
  );
});

test("customer accounts are unlimited", async () => {
  const tenancy = new SingleOperatorTenancyAdapter({
    operatorUserId: "user-op-1"
  });
  await assert.doesNotReject(async () => {
    await tenancy.assertCanCreateCustomerAccount({ email: "buyer@example.com" });
    await tenancy.assertCanCreateCustomerAccount({ email: "another@example.com" });
  });
});

test("customer accounts have zero creator access", async () => {
  const tenancy = new SingleOperatorTenancyAdapter({
    operatorUserId: "user-op-1",
    listOperatorCreatorIds: () => ["creator-1", "creator-2"]
  });
  const accessible = await tenancy.listAccessibleCreatorIds("buyer-user-id");
  assert.deepEqual(accessible, []);
});

test("operator lists all managed creator IDs", async () => {
  const tenancy = new SingleOperatorTenancyAdapter({
    operatorUserId: "user-op-1",
    listOperatorCreatorIds: () => ["creator-1", "creator-2"]
  });
  const accessible = await tenancy.listAccessibleCreatorIds("user-op-1");
  assert.deepEqual(accessible, ["creator-1", "creator-2"]);
});

test("role resolution marks operator as owner and outsider as null", async () => {
  const tenancy = new SingleOperatorTenancyAdapter({
    operatorUserId: "user-op-1",
    listOperatorCreatorIds: () => ["creator-1"]
  });
  const opRole = await tenancy.resolveCreatorRole("user-op-1", "creator-1");
  assert.equal(opRole, "owner");

  const outsiderRole = await tenancy.resolveCreatorRole("buyer-user-id", "creator-1");
  assert.equal(outsiderRole, null);
});

test("contributor and organization management are disabled", () => {
  const tenancy = new SingleOperatorTenancyAdapter();
  assert.equal(tenancy.isContributorManagementEnabled(), false);
  assert.equal(tenancy.isOrganizationManagementEnabled(), false);
});

test("contributor mutation guard throws error", () => {
  const tenancy = new SingleOperatorTenancyAdapter();
  assert.throws(
    () => tenancy.assertCanMutateContributors(),
    (err) => {
      assert(err instanceof FeatureDisabledInSingleOperatorModeError);
      assert.equal(err.code, "FEATURE_DISABLED_IN_SINGLE_OPERATOR_MODE");
      assert.equal(err.statusCode, 403);
      return true;
    }
  );
});

test("organization mutation guard throws error", () => {
  const tenancy = new SingleOperatorTenancyAdapter();
  assert.throws(
    () => tenancy.assertCanMutateOrganizations(),
    (err) => {
      assert(err instanceof FeatureDisabledInSingleOperatorModeError);
      assert.equal(err.code, "FEATURE_DISABLED_IN_SINGLE_OPERATOR_MODE");
      assert.equal(err.statusCode, 403);
      return true;
    }
  );
});
