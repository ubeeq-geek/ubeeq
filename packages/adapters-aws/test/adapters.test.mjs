import assert from "node:assert/strict";
import test from "node:test";
import { CognitoIdentity, DynamoRevisionedRepository, AwsJobQueue, S3ObjectStorage, SecretsManagerCredentialVault } from "../dist/index.js";
import { verifyRevisionedRepositoryContract } from "@ubeeq/persistence";
import { verifyJobQueueContract } from "@ubeeq/jobs";
import { verifyObjectStorageContract } from "@ubeeq/storage";
import { verifyIdentityAdapterContract } from "@ubeeq/auth";

class MemoryDynamo {
  values = new Map();
  async send(command) {
    const input = command.input;
    if (command.constructor.name === "GetCommand") return { Item: this.values.get(`${input.Key.pk}|${input.Key.sk}`) };
    if (command.constructor.name === "QueryCommand") {
      const repository = input.ExpressionAttributeValues[":repository"];
      const items = [...this.values.values()].filter((value) => value.repository === repository).slice(0, input.Limit);
      return { Items: items };
    }
    if (command.constructor.name === "PutCommand") {
      const key = `${input.Item.pk}|${input.Item.sk}`;
      const current = this.values.get(key);
      if (input.ConditionExpression === "attribute_not_exists(pk)" && current) { const error = new Error("ConditionalCheckFailedException"); error.name = "ConditionalCheckFailedException"; throw error; }
      if (input.ConditionExpression?.includes("#revision") && (!current || current.revision !== input.ExpressionAttributeValues[":revision"])) { const error = new Error("ConditionalCheckFailedException"); error.name = "ConditionalCheckFailedException"; throw error; }
      this.values.set(key, input.Item); return {};
    }
    if (command.constructor.name === "DeleteCommand") {
      const key = `${input.Key.pk}|${input.Key.sk}`; const current = this.values.get(key);
      if (!current || current.revision !== input.ExpressionAttributeValues[":revision"]) { const error = new Error("ConditionalCheckFailedException"); error.name = "ConditionalCheckFailedException"; throw error; }
      this.values.delete(key); return {};
    }
    throw new Error(`Unsupported command ${command.constructor.name}`);
  }
}

test("Secrets Manager vault exposes only opaque references and reads binary credentials", async () => {
  const calls = [];
  const vault = new SecretsManagerCredentialVault({ send: async (command) => { calls.push(command.constructor.name); return command.constructor.name === "GetSecretValueCommand" ? { SecretBinary: Buffer.from("credential") } : {}; } }, "ubeeq/credentials");
  const stored = await vault.write({ ownerId: "creator", value: Buffer.from("credential") });
  assert.match(stored.reference, /^aws-secrets:ubeeq\/credentials\/creator\//);
  assert.equal(Buffer.from(await vault.read({ reference: stored.reference })).toString(), "credential");
  await vault.revoke({ reference: stored.reference });
  assert.deepEqual(calls, ["CreateSecretCommand", "GetSecretValueCommand", "UpdateSecretCommand"]);
});

test("DynamoDB revisioned repository obeys the shared persistence contract", async () => {
  const repository = new DynamoRevisionedRepository(new MemoryDynamo(), { tableName: "records" }, "creators");
  await verifyRevisionedRepositoryContract({ repository, createRecord: (id) => ({ id, instanceId: "local", handle: id, displayName: "Contract" }), change: () => ({ displayName: "Updated" }) });
});

test("SQS-notified DynamoDB queue obeys the shared durable job contract", async () => {
  const notices = [];
  const events = [];
  const queue = new AwsJobQueue(new MemoryDynamo(), { tableName: "records" }, { send: async (command) => { notices.push(command.input); return {}; } }, "https://sqs.example/jobs", { client: { send: async (command) => { events.push(command.input); return {}; } }, eventBusName: "ubeeq" });
  await verifyJobQueueContract(queue);
  assert.ok(notices.length >= 2);
  assert.equal(JSON.parse(notices[0].MessageBody).type, "contract");
  assert.equal(events[0].Entries[0].DetailType, "job.available");
});

test("S3 adapter obeys the shared storage contract without prescribing a delivery provider", async () => {
  const values = new Map(); let put;
  const storage = new S3ObjectStorage({ send: async (command) => {
    if (command.constructor.name === "PutObjectCommand") { put = command.input; values.set(command.input.Key, command.input); return {}; }
    if (command.constructor.name === "GetObjectCommand") { const value = values.get(command.input.Key); if (!value) throw new Error("NoSuchKey"); return { VersionId: "v1", ContentType: value.ContentType, Metadata: value.Metadata, Body: { transformToByteArray: async () => value.Body } }; }
    if (command.constructor.name === "DeleteObjectCommand") { values.delete(command.input.Key); return {}; }
    return {};
  } }, "objects");
  await verifyObjectStorageContract(storage);
  await storage.put({ object: { bucket: "ignored", key: "source/a", contentType: "image/png", byteLength: 5, checksum: "abc", scope: "private" }, body: Buffer.from("image") });
  const loaded = await storage.get({ bucket: "ignored", key: "source/a" });
  assert.equal(put.Bucket, "objects");
  assert.equal(loaded.object.checksum, "abc");
  assert.equal(Buffer.from(loaded.body).toString(), "image");
});

test("Cognito identity verifies opaque sessions and maps access scopes", async () => {
  let revoked = false;
  const identity = new CognitoIdentity({ send: async (command) => { if (command.constructor.name === "GlobalSignOutCommand") { revoked = true; return {}; } if (revoked) throw new Error("revoked"); return { Username: "subject-1", UserAttributes: [{ Name: "scope", Value: "works:write exports:read" }] }; } }, "pool", "client");
  const session = await identity.verifySession({ credential: "opaque-access-token" });
  assert.equal(session?.subject.id, "subject-1");
  assert.deepEqual(session?.subject.scopes, ["works:write", "exports:read"]);
  await verifyIdentityAdapterContract(identity, { credential: "opaque-access-token", subjectId: "subject-1" });
});
