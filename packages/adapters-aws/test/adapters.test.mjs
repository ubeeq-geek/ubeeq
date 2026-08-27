import assert from "node:assert/strict";
import test from "node:test";
import { SecretsManagerCredentialVault } from "../dist/index.js";

test("Secrets Manager vault exposes only opaque references and reads binary credentials", async () => {
  const calls = [];
  const vault = new SecretsManagerCredentialVault({ send: async (command) => { calls.push(command.constructor.name); return command.constructor.name === "GetSecretValueCommand" ? { SecretBinary: Buffer.from("credential") } : {}; } }, "ubeeq/credentials");
  const stored = await vault.write({ ownerId: "creator", value: Buffer.from("credential") });
  assert.match(stored.reference, /^aws-secrets:ubeeq\/credentials\/creator\//);
  assert.equal(Buffer.from(await vault.read({ reference: stored.reference })).toString(), "credential");
  await vault.revoke({ reference: stored.reference });
  assert.deepEqual(calls, ["PutSecretValueCommand", "GetSecretValueCommand", "UpdateSecretCommand"]);
});
