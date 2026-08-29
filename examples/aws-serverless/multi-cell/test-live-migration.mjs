/**
 * Opt-in real AWS migration proof. It creates only marker-tagged disposable
 * data, proves cutover and rollback, then removes every tracked record/object.
 */
import { createHash, randomUUID } from "node:crypto";
import { AdminCreateUserCommand, AdminDeleteUserCommand, AdminSetUserPasswordCommand, CognitoIdentityProviderClient, InitiateAuthCommand } from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { DeleteObjectCommand, HeadObjectCommand, ListObjectVersionsCommand, S3Client } from "@aws-sdk/client-s3";
import { createAwsMigrationCommandQueue, createAwsRoutingControlPlane } from "@ubeeq/adapter-aws";
import { MigrationOrchestrator } from "@ubeeq/deployment-platform";

const required = [
  "UBEEQ_AWS_SOURCE_API_URL", "UBEEQ_AWS_SOURCE_REGION", "UBEEQ_AWS_SOURCE_RECORDS_TABLE", "UBEEQ_AWS_SOURCE_BUCKET", "UBEEQ_AWS_SOURCE_USER_POOL_ID", "UBEEQ_AWS_SOURCE_USER_POOL_CLIENT_ID", "UBEEQ_AWS_SOURCE_CELL_ID",
  "UBEEQ_AWS_DESTINATION_API_URL", "UBEEQ_AWS_DESTINATION_REGION", "UBEEQ_AWS_DESTINATION_RECORDS_TABLE", "UBEEQ_AWS_DESTINATION_BUCKET", "UBEEQ_AWS_DESTINATION_CELL_ID",
  "UBEEQ_AWS_ROUTING_TABLE", "UBEEQ_AWS_ROUTING_REGION", "UBEEQ_AWS_MIGRATION_QUEUE_URL",
];
const missing = required.filter((name) => !process.env[name]);
if (missing.length) {
  console.error(`AWS live migration test requires: ${missing.join(", ")}`);
  process.exitCode = 2;
} else {
  const source = {
    api: process.env.UBEEQ_AWS_SOURCE_API_URL.replace(/\/$/, ""), region: process.env.UBEEQ_AWS_SOURCE_REGION, table: process.env.UBEEQ_AWS_SOURCE_RECORDS_TABLE,
    bucket: process.env.UBEEQ_AWS_SOURCE_BUCKET, pool: process.env.UBEEQ_AWS_SOURCE_USER_POOL_ID, client: process.env.UBEEQ_AWS_SOURCE_USER_POOL_CLIENT_ID, cellId: process.env.UBEEQ_AWS_SOURCE_CELL_ID,
  };
  const destination = {
    api: process.env.UBEEQ_AWS_DESTINATION_API_URL.replace(/\/$/, ""), region: process.env.UBEEQ_AWS_DESTINATION_REGION, table: process.env.UBEEQ_AWS_DESTINATION_RECORDS_TABLE,
    bucket: process.env.UBEEQ_AWS_DESTINATION_BUCKET, cellId: process.env.UBEEQ_AWS_DESTINATION_CELL_ID,
  };
  const marker = `aws-live-migration-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const migrationId = `migration-${marker}`;
  const sourceDynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: source.region }));
  const destinationDynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: destination.region }));
  const controlDynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.UBEEQ_AWS_ROUTING_REGION }));
  const sourceS3 = new S3Client({ region: source.region });
  const destinationS3 = new S3Client({ region: destination.region });
  const control = createAwsRoutingControlPlane({ tableName: process.env.UBEEQ_AWS_ROUTING_TABLE, region: process.env.UBEEQ_AWS_ROUTING_REGION });
  const commands = createAwsMigrationCommandQueue({ queueUrl: process.env.UBEEQ_AWS_MIGRATION_QUEUE_URL, region: process.env.UBEEQ_AWS_ROUTING_REGION });
  const createdIds = new Set(); let username; let creatorId; let checkpoint;
  const call = async (path, { method = "GET", token, body } = {}) => {
    const response = await fetch(`${source.api}${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = response.status === 204 ? undefined : await response.json();
    return { response, value };
  };
  const waitFor = async (condition, description) => {
    for (let attempt = 0; attempt < 45; attempt += 1) {
      const value = await condition();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    throw new Error(`Timed out waiting for ${description}.`);
  };
  const removeMarkerRecords = async (dynamo, table) => {
    let cursor;
    do {
      const page = await dynamo.send(new ScanCommand({ TableName: table, ExclusiveStartKey: cursor }));
      for (const item of page.Items ?? []) {
        const text = JSON.stringify(item);
        if (text.includes(marker) || [...createdIds].some((id) => text.includes(id))) await dynamo.send(new DeleteCommand({ TableName: table, Key: { pk: item.pk, sk: item.sk } })).catch(() => undefined);
      }
      cursor = page.LastEvaluatedKey;
    } while (cursor);
  };
  const removeInventory = async (inventory, location, s3) => {
    for (const item of inventory ?? []) {
      const object = item[location];
      if (!object?.key) continue;
      const bucket = location === "source" ? source.bucket : destination.bucket;
      // The destination version is assigned by S3 during the copy and is not
      // part of the source inventory. Remove every version/delete marker for
      // this disposable key so the live proof does not leave noncurrent data.
      let keyMarker;
      let versionIdMarker;
      do {
        const page = await s3.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: object.key, KeyMarker: keyMarker, VersionIdMarker: versionIdMarker })).catch(() => undefined);
        for (const version of [...(page?.Versions ?? []), ...(page?.DeleteMarkers ?? [])]) {
          if (version.Key === object.key && version.VersionId) await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: object.key, VersionId: version.VersionId })).catch(() => undefined);
        }
        keyMarker = page?.NextKeyMarker;
        versionIdMarker = page?.NextVersionIdMarker;
      } while (keyMarker);
    }
  };
  try {
    username = `${marker}@example.invalid`;
    const password = `UbeeqMigration${Date.now()}Aa!`;
    const cognito = new CognitoIdentityProviderClient({ region: source.region });
    await cognito.send(new AdminCreateUserCommand({ UserPoolId: source.pool, Username: username, UserAttributes: [{ Name: "email", Value: username }, { Name: "email_verified", Value: "true" }], MessageAction: "SUPPRESS" }));
    await cognito.send(new AdminSetUserPasswordCommand({ UserPoolId: source.pool, Username: username, Password: password, Permanent: true }));
    const auth = await cognito.send(new InitiateAuthCommand({ AuthFlow: "USER_PASSWORD_AUTH", ClientId: source.client, AuthParameters: { USERNAME: username, PASSWORD: password } }));
    const token = auth.AuthenticationResult?.AccessToken;
    if (!token) throw new Error("Disposable migration user did not receive an access token.");
    const creator = await call("/v1/creators", { method: "POST", token, body: { handle: marker, displayName: "AWS live migration" } });
    if (creator.response.status !== 201) throw new Error(`Creator creation failed: ${JSON.stringify(creator.value)}`);
    creatorId = creator.value.creator.id; createdIds.add(creatorId);
    const work = await call("/v1/works", { method: "POST", token, body: { title: marker } });
    if (work.response.status !== 201) throw new Error(`Work creation failed: ${JSON.stringify(work.value)}`);
    createdIds.add(work.value.work.id);
    const bytes = Buffer.from("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89", "binary");
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const upload = await call("/v1/uploads", { method: "POST", token, body: { workId: work.value.work.id, mimeType: "image/png", byteLength: bytes.byteLength, checksum } });
    if (upload.response.status !== 201) throw new Error(`Upload initiation failed: ${JSON.stringify(upload.value)}`);
    const put = await fetch(upload.value.upload.parts[0].url, { method: "PUT", headers: { "content-type": "image/png", "x-amz-checksum-sha256": Buffer.from(checksum, "hex").toString("base64"), "x-amz-meta-checksum": checksum, "x-amz-meta-scope": "private", "x-amz-meta-bytelength": String(bytes.byteLength) }, body: bytes });
    if (!put.ok) throw new Error(`Source direct upload failed: ${put.status}`);
    const completed = await call(`/v1/uploads/${upload.value.upload.uploadId}/complete`, { method: "POST", token, body: { workId: work.value.work.id, checksum, byteLength: bytes.byteLength } });
    if (completed.response.status !== 202) throw new Error(`Upload completion failed: ${JSON.stringify(completed.value)}`);
    createdIds.add(completed.value.asset.id); createdIds.add(completed.value.job.id);
    let published;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const result = await call(`/v1/works/${work.value.work.id}/publications`, { method: "POST", token, body: { destination: "reference" } });
      if (result.response.status === 201) { published = result.value; createdIds.add(published.intent.id); createdIds.add(published.publication.id); break; }
      if (result.value?.error?.code !== "processing_incomplete") throw new Error(`Publication failed: ${JSON.stringify(result.value)}`);
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    if (!published) throw new Error("Source worker did not process the migration asset.");
    const sourceRoute = { creatorId, homeCellId: source.cellId, homeRegion: source.region, endpoint: `${source.api}/`, routingRevision: 1, state: "active", updatedAt: new Date().toISOString() };
    await control.routingDirectory.create(sourceRoute);
    const requestOnly = new MigrationOrchestrator(control.routingDirectory, control.migrationCheckpoints, {});
    await requestOnly.request({ id: migrationId, creatorId, destination: { cellId: destination.cellId, region: destination.region, endpoint: `${destination.api}/` } });
    await commands.enqueue({ migrationId, operation: "resume", rollbackWindowSeconds: 300 });
    checkpoint = await waitFor(async () => { const value = await control.migrationCheckpoints.get(migrationId); return value?.state === "cutover" ? value : undefined; }, "migration cutover");
    if (checkpoint.objectCount !== checkpoint.verifiedObjectCount || checkpoint.objectCount !== 3) throw new Error(`Migration inventory verification failed: ${JSON.stringify(checkpoint)}`);
    const cutoverRoute = await control.routingDirectory.get(creatorId);
    if (cutoverRoute?.homeCellId !== destination.cellId || cutoverRoute.routingRevision !== 2) throw new Error("Migration route did not cut over atomically.");
    const held = await call("/v1/works", { method: "POST", token, body: { title: `${marker}-held` } });
    if (held.response.status !== 409 || held.value?.error?.code !== "migration_source_held") throw new Error(`Source write was not held: ${JSON.stringify(held.value)}`);
    const importedCreator = await destinationDynamo.send(new GetCommand({ TableName: destination.table, Key: { pk: `creators#${creatorId}`, sk: "record" } }));
    const importedAsset = await destinationDynamo.send(new GetCommand({ TableName: destination.table, Key: { pk: `assets#${completed.value.asset.id}`, sk: "record" } }));
    if (importedCreator.Item?.value?.homeCellId !== destination.cellId || importedAsset.Item?.value?.originalStorage?.key === undefined) throw new Error("Destination import did not retain the creator data-home and original object.");
    for (const item of checkpoint.objectInventory ?? []) {
      const head = await destinationS3.send(new HeadObjectCommand({ Bucket: destination.bucket, Key: item.destination.key }));
      if (head.ContentLength !== item.byteLength || head.Metadata?.checksum !== item.checksum) throw new Error(`Destination object ${item.id} failed checksum/count verification.`);
    }
    await commands.enqueue({ migrationId, operation: "rollback" });
    checkpoint = await waitFor(async () => { const value = await control.migrationCheckpoints.get(migrationId); return value?.state === "rolled_back" ? value : undefined; }, "migration rollback");
    const rollbackRoute = await control.routingDirectory.get(creatorId);
    if (rollbackRoute?.homeCellId !== source.cellId || rollbackRoute.routingRevision !== 3) throw new Error("Migration route did not roll back atomically.");
    const writable = await call("/v1/works", { method: "POST", token, body: { title: `${marker}-restored` } });
    if (writable.response.status !== 201) throw new Error(`Source hold was not released after rollback: ${JSON.stringify(writable.value)}`);
    createdIds.add(writable.value.work.id);
    console.log("AWS cross-cell migration cutover, checksum verification, rollback, and source-hold release passed.");
  } finally {
    await removeInventory(checkpoint?.objectInventory, "source", sourceS3);
    await removeInventory(checkpoint?.objectInventory, "destination", destinationS3);
    await removeMarkerRecords(sourceDynamo, source.table);
    await removeMarkerRecords(destinationDynamo, destination.table);
    if (creatorId) await controlDynamo.send(new DeleteCommand({ TableName: process.env.UBEEQ_AWS_ROUTING_TABLE, Key: { pk: "route", sk: creatorId } })).catch(() => undefined);
    await controlDynamo.send(new DeleteCommand({ TableName: process.env.UBEEQ_AWS_ROUTING_TABLE, Key: { pk: "migration", sk: migrationId } })).catch(() => undefined);
    if (username) await new CognitoIdentityProviderClient({ region: source.region }).send(new AdminDeleteUserCommand({ UserPoolId: source.pool, Username: username })).catch(() => undefined);
  }
}
