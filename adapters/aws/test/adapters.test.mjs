import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { CognitoIdentity, DynamoRevisionedRepository, AwsJobQueue, S3DirectUploadAdapter, S3MigrationObjectTransfer, S3ObjectStorage, SecretsManagerCredentialVault, createDynamoRoutingControlPlane } from "../dist/index.js";
import { advanceMigration, createMigrationCheckpoint, cutoverCellRoute, RoutingDirectoryConflictError } from "@ubeeq/deployment-platform";
import { CellScopedRepository, verifyCellScopedRepositoryContract, verifyRevisionedRepositoryContract } from "@ubeeq/persistence";
import { verifyJobQueueContract } from "@ubeeq/jobs";
import { verifyObjectStorageContract } from "@ubeeq/storage";
import { verifyIdentityAdapterContract } from "@ubeeq/auth";

class MemoryDynamo {
  values = new Map();
  async send(command) {
    const input = command.input;
    if (command.constructor.name === "GetCommand") return { Item: this.values.get(`${input.Key.pk}|${input.Key.sk}`) };
    if (command.constructor.name === "QueryCommand") {
      const partition = input.ExpressionAttributeValues[":pk"];
      const repository = input.ExpressionAttributeValues[":repository"];
      const all = [...this.values.values()].filter((value) => partition ? value.pk === partition : value.repository === repository).sort((left, right) => String(left.sk ?? left.id).localeCompare(String(right.sk ?? right.id)));
      const start = input.ExclusiveStartKey ? all.findIndex((value) => value.pk === input.ExclusiveStartKey.pk && value.sk === input.ExclusiveStartKey.sk) + 1 : 0; const items = all.slice(start, start + input.Limit); const last = items.at(-1);
      return { Items: items, ...(last && start + items.length < all.length ? { LastEvaluatedKey: { pk: last.pk, sk: last.sk } } : {}) };
    }
    if (command.constructor.name === "PutCommand") {
      const key = `${input.Item.pk}|${input.Item.sk}`;
      const current = this.values.get(key);
      if (input.ConditionExpression === "attribute_not_exists(pk)" && current) { const error = new Error("ConditionalCheckFailedException"); error.name = "ConditionalCheckFailedException"; throw error; }
      if (input.ConditionExpression?.includes("#revision") && (!current || current.revision !== input.ExpressionAttributeValues[":revision"])) { const error = new Error("ConditionalCheckFailedException"); error.name = "ConditionalCheckFailedException"; throw error; }
      if (input.ConditionExpression?.includes("#routingRevision") && (!current || current.routingRevision !== input.ExpressionAttributeValues[":expected"])) { const error = new Error("ConditionalCheckFailedException"); error.name = "ConditionalCheckFailedException"; throw error; }
      if (input.ConditionExpression?.includes("#updatedAt") && (!current || current.updatedAt !== input.ExpressionAttributeValues[":expected"])) { const error = new Error("ConditionalCheckFailedException"); error.name = "ConditionalCheckFailedException"; throw error; }
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
  const stored = await vault.write({ cellId: "cell-a", ownerId: "creator", value: Buffer.from("credential") });
  assert.match(stored.reference, /^aws-secrets:ubeeq\/credentials\/cell-a\/creator\//);
  assert.equal(Buffer.from(await vault.read({ cellId: "cell-a", reference: stored.reference })).toString(), "credential");
  assert.equal(await vault.read({ cellId: "cell-b", reference: stored.reference }), undefined);
  await vault.revoke({ cellId: "cell-a", reference: stored.reference });
  assert.deepEqual(calls, ["CreateSecretCommand", "GetSecretValueCommand", "UpdateSecretCommand"]);
});

test("DynamoDB revisioned repository obeys the shared persistence contract", async () => {
  const repository = new DynamoRevisionedRepository(new MemoryDynamo(), { tableName: "records" }, "creators");
  await verifyRevisionedRepositoryContract({ repository, createRecord: (id) => ({ id, instanceId: "local", handle: id, displayName: "Contract" }), change: () => ({ displayName: "Updated" }) });
});

test("DynamoDB canonical repositories enforce the shared cell boundary", async () => {
  const base = new DynamoRevisionedRepository(new MemoryDynamo(), { tableName: "records", cellId: "cell-a" }, "cell-contract");
  await verifyCellScopedRepositoryContract({ repository: new CellScopedRepository(base, "cell-a"), unscopedRepository: base, cellId: "cell-a" });
});

test("DynamoDB routing control-plane is separate and guards cutover/checkpoint concurrency", async () => {
  const control = createDynamoRoutingControlPlane(new MemoryDynamo(), "routing-control");
  const timestamp = "2026-08-27T00:00:00.000Z";
  const source = { creatorId: "creator-1", homeCellId: "cell-a", homeRegion: "us-east-2", endpoint: "https://cell-a.example/", routingRevision: 1, state: "active", updatedAt: timestamp };
  await control.routingDirectory.create(source);
  await assert.rejects(() => control.routingDirectory.create(source), RoutingDirectoryConflictError);
  let checkpoint = createMigrationCheckpoint({ id: "move-1", creatorId: source.creatorId, source, destination: { cellId: "cell-b", region: "eu-central-1", endpoint: "https://cell-b.example/" }, now: timestamp });
  await control.migrationCheckpoints.create(checkpoint);
  checkpoint = advanceMigration(checkpoint, "source_hold", { now: "2026-08-27T00:01:00.000Z" });
  await control.migrationCheckpoints.compareAndSwap({ checkpoint, expectedUpdatedAt: timestamp });
  checkpoint = advanceMigration(checkpoint, "exported", { now: "2026-08-27T00:02:00.000Z", manifestChecksum: "a".repeat(64) });
  checkpoint = advanceMigration(checkpoint, "transferred", { now: "2026-08-27T00:03:00.000Z" });
  checkpoint = advanceMigration(checkpoint, "verified", { now: "2026-08-27T00:04:00.000Z", objectCount: 1, verifiedObjectCount: 1 });
  const destination = cutoverCellRoute(source, checkpoint, "2026-08-27T00:05:00.000Z");
  await control.routingDirectory.compareAndSwap({ route: destination, expectedRoutingRevision: 1 });
  await assert.rejects(() => control.routingDirectory.compareAndSwap({ route: { ...destination, routingRevision: 3, updatedAt: "2026-08-27T00:06:00.000Z" }, expectedRoutingRevision: 1 }), RoutingDirectoryConflictError);
  assert.equal((await control.routingDirectory.get(source.creatorId))?.endpoint, "https://cell-b.example/");
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

test("cell-configured S3 adapters reject objects from another regional cell", async () => {
  const storage = new S3ObjectStorage({ send: async () => ({}) }, "objects", "cell-a");
  await assert.rejects(() => storage.put({ object: { bucket: "objects", key: "cells/cell-b/creators/creator-b/originals/file", contentType: "image/png", byteLength: 0, scope: "private" }, body: new Uint8Array() }), /cell-a/);
  const upload = new S3DirectUploadAdapter({ config: {}, middlewareStack: { add: () => {}, addRelativeTo: () => {}, clone: () => ({}) } }, "objects", "cell-a");
  await assert.rejects(() => upload.initiate({ object: { bucket: "objects", key: "cells/cell-b/creators/creator-b/uploads/file", contentType: "image/png", byteLength: 1, checksum: "a".repeat(64), scope: "private" }, checksumAlgorithm: "sha256", expiresAt: new Date(Date.now() + 60_000).toISOString() }), /cell-a/);
});

test("S3 migration transfer copies only declared cross-cell objects and verifies checksums", async () => {
  const sourceObjects = new Map(), destinationObjects = new Map();
  const source = { send: async (command) => {
    const input = command.input; const object = sourceObjects.get(`${input.Bucket}/${input.Key}`);
    if (command.constructor.name === "GetObjectCommand" && object) return { ContentType: object.contentType, Body: { transformToByteArray: async () => object.body } };
    throw new Error("Source object was not found");
  } };
  const destination = { send: async (command) => {
    const input = command.input; const key = `${input.Bucket}/${input.Key}`;
    if (command.constructor.name === "PutObjectCommand") { destinationObjects.set(key, { body: input.Body, metadata: input.Metadata }); return {}; }
    if (command.constructor.name === "HeadObjectCommand") { const object = destinationObjects.get(key); if (!object) throw new Error("Destination object was not found"); return { ContentLength: object.body.byteLength, Metadata: object.metadata }; }
    throw new Error(`Unexpected ${command.constructor.name}`);
  } };
  const body = Buffer.from("migration-object"), checksum = createHash("sha256").update(body).digest("hex");
  sourceObjects.set("source/cells/cell-a/creators/creator-1/originals/a", { body, contentType: "image/png" });
  const checkpoint = { id: "move-1", creatorId: "creator-1", source: { homeCellId: "cell-a", homeRegion: "us-east-2", endpoint: "https://a.example/", routingRevision: 1 }, destination: { cellId: "cell-b", region: "eu-central-1", endpoint: "https://b.example/" }, state: "exported", manifestChecksum: "a".repeat(64), objectCount: 1, createdAt: "2026-08-28T00:00:00.000Z", updatedAt: "2026-08-28T00:00:00.000Z" };
  const inventory = [{ id: "asset-a", source: { bucket: "source", key: "cells/cell-a/creators/creator-1/originals/a" }, destination: { bucket: "destination", key: "cells/cell-b/creators/creator-1/originals/a" }, checksum, byteLength: body.byteLength }];
  const transfer = new S3MigrationObjectTransfer(source, destination);
  await transfer.transfer(checkpoint, inventory);
  assert.deepEqual(await transfer.verify(checkpoint, inventory), { objectCount: 1, verifiedObjectCount: 1 });
  await assert.rejects(() => transfer.transfer(checkpoint, [{ ...inventory[0], destination: { bucket: "destination", key: "cells/cell-c/creators/creator-1/originals/a" } }]), /undeclared cell/);
});

test("S3 direct upload binds a checksum and returns the immutable object version", async () => {
  const checksum = "a".repeat(64); const upload = new S3DirectUploadAdapter({ config: {}, middlewareStack: { add: () => {}, addRelativeTo: () => {}, clone: () => ({}) } }, "objects");
  // Replace the network boundary only for the completion assertion; initiation is covered by its signed-command shape below.
  upload.s3 = { send: async (command) => command.constructor.name === "HeadObjectCommand" ? { VersionId: "v1", ContentLength: 4, ContentType: "image/png", ChecksumSHA256: Buffer.from(checksum, "hex").toString("base64"), Metadata: { checksum, scope: "private" } } : {} };
  const uploadId = Buffer.from(JSON.stringify({ bucket: "objects", key: "cells/cell-a/creators/creator-a/uploads/a", contentType: "image/png", byteLength: 4, checksum, scope: "private" })).toString("base64url");
  const completed = await upload.complete({ uploadId, cellId: "cell-a", creatorId: "creator-a", checksum, byteLength: 4 });
  assert.equal(completed.versionId, "v1"); assert.equal(completed.checksum, checksum);
  await assert.rejects(() => upload.complete({ uploadId, cellId: "cell-a", creatorId: "creator-b", checksum, byteLength: 4 }), /not scoped/);
});

test("Cognito identity verifies opaque sessions and maps access scopes", async () => {
  let revoked = false;
  const identity = new CognitoIdentity({ send: async (command) => { if (command.constructor.name === "GlobalSignOutCommand") { revoked = true; return {}; } if (revoked) throw new Error("revoked"); return { Username: "subject-1", UserAttributes: [{ Name: "scope", Value: "works:write exports:read" }] }; } }, "pool", "client");
  const session = await identity.verifySession({ credential: "opaque-access-token" });
  assert.equal(session?.subject.id, "subject-1");
  assert.deepEqual(session?.subject.scopes, ["works:write", "exports:read"]);
  await verifyIdentityAdapterContract(identity, { credential: "opaque-access-token", subjectId: "subject-1" });
});
