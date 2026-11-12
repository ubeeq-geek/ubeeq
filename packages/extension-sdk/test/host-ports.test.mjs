import assert from "node:assert/strict";
import test from "node:test";
import {
  HOST_EXTENSION_PORTS,
  SingleOperatorLimitError,
  FeatureDisabledInSingleOperatorModeError,
  createByoConnectorCredentialsPort,
  createDefaultOpenCorePorts,
  createPassThroughWatermarkPort,
  createSingleOperatorTenancyPort
} from "../dist/index.js";

test("exposes all six host extension ports", () => {
  assert.deepEqual(HOST_EXTENSION_PORTS, [
    "tenancy-and-access",
    "publication-admission",
    "watermark-and-transform",
    "usage-quota",
    "connector-app-credentials",
    "studio-ui-slots"
  ]);
});

test("single-operator tenancy port enforces one creator user while allowing multiple creator identities and customer accounts", async () => {
  const tenancy = createSingleOperatorTenancyPort({
    getOperatorUserId: () => "user-operator-1",
    listOperatorCreatorIds: () => ["creator-main", "creator-alt-persona"]
  });

  assert.equal(tenancy.mode, "single_operator");
  assert.equal(tenancy.isContributorManagementEnabled(), false);
  assert.equal(tenancy.isOrganizationManagementEnabled(), false);

  await assert.doesNotReject(() => tenancy.assertCanCreateCreatorUser({ existingCreatorUserCount: 0 }));
  await assert.rejects(
    () => tenancy.assertCanCreateCreatorUser({ existingCreatorUserCount: 1 }),
    (error) => error instanceof SingleOperatorLimitError && error.code === "SINGLE_OPERATOR_INSTANCE_LIMIT" && error.statusCode === 403
  );

  await assert.doesNotReject(() => tenancy.assertCanCreateCustomerAccount?.({ email: "buyer@example.com" }));
  assert.deepEqual(await tenancy.listAccessibleCreatorIds("user-operator-1"), ["creator-main", "creator-alt-persona"]);
  assert.equal(await tenancy.resolveCreatorRole("user-operator-1", "creator-alt-persona"), "owner");
  assert.deepEqual(await tenancy.listAccessibleCreatorIds("customer-user-99"), []);
});

test("open-core watermark port supports text watermarking and rejects graphic watermarks or pro adjustments", async () => {
  const port = createPassThroughWatermarkPort({
    async renderTextWatermark({ sourceBytes, mimeType, watermark }) {
      return {
        bytes: new Uint8Array([...sourceBytes, watermark.text.length]),
        mimeType
      };
    }
  });

  const base = new Uint8Array([1, 2, 3]);
  const textResult = await port.applyDerivativeTransform({
    sourceBytes: base,
    mimeType: "image/jpeg",
    creatorId: "creator-1",
    textWatermark: { text: "© Studio" }
  });
  assert.equal(textResult.bytes.length, 4);

  await assert.rejects(
    () => port.applyDerivativeTransform({
      sourceBytes: base,
      mimeType: "image/jpeg",
      creatorId: "creator-1",
      graphicWatermarkAssetId: "asset-logo-1"
    }),
    FeatureDisabledInSingleOperatorModeError
  );
});

test("BYO connector credentials port resolves creator secrets before operator env variables", async () => {
  const port = createByoConnectorCredentialsPort({
    env: {
      UBEEQ_YOUTUBE_CLIENT_ID: "env-id",
      UBEEQ_YOUTUBE_CLIENT_SECRET: "env-secret",
      UBEEQ_YOUTUBE_REDIRECT_URI: "https://selfhost.example/oauth/youtube"
    },
    async lookupCreatorSecret(provider, creatorId) {
      if (provider === "patreon" && creatorId === "creator-1") {
        return {
          clientId: "creator-patreon-id",
          clientSecret: "creator-patreon-secret",
          redirectUri: "https://selfhost.example/oauth/patreon"
        };
      }
      return null;
    }
  });

  const envCreds = await port.resolveOAuthClient("youtube", "creator-1");
  assert.equal(envCreds?.credentialSource, "operator_env");
  assert.equal(envCreds?.clientId, "env-id");

  const secretCreds = await port.resolveOAuthClient("patreon", "creator-1");
  assert.equal(secretCreds?.credentialSource, "creator_secret");
  assert.equal(secretCreds?.clientId, "creator-patreon-id");

  const defaults = createDefaultOpenCorePorts();
  assert.equal((await defaults.publicationAdmission.evaluatePublication({
    workId: "w1",
    creatorId: "c1",
    destination: "native",
    visibility: "public"
  })).allowed, true);
  assert.equal((await defaults.usageQuota.checkAndReserveQuota({
    creatorId: "c1",
    operation: "upload"
  })).allowed, true);
});
