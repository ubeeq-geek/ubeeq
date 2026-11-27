import {readReferenceOperator,releaseCreatedReferenceOperator} from '../single-cell/owned-reference-operator.mjs';
import {publishReferenceWhenReady} from '../single-cell/reference-publication-retry.mjs';
/**
 * Opt-in real AWS migration proof. It creates only marker-tagged disposable
 * data, proves cutover and rollback, then removes every tracked record/object.
 */
import { createHash, randomUUID, randomBytes } from "node:crypto";
import { AdminCreateUserCommand, AdminDeleteUserCommand, AdminSetUserPasswordCommand, CognitoIdentityProviderClient, InitiateAuthCommand, GetUserCommand } from "@aws-sdk/client-cognito-identity-provider";
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
  const createdIds = new Set(); let username; let creatorId; let checkpoint; let operatorFixture;
  const instanceId=process.env.UBEEQ_AWS_INSTANCE_ID ?? "aws-reference";
  const call = async (path, { method = "GET", token, body, headers = {} } = {}) => {
    const response = await fetch(`${source.api}${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
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
  const findRegionalFixture = async (resource, token, match, filters = {}) => {
    const path = `/v1/operations/regional/${resource}`;
    if ((await call(path)).response.status !== 401) {
      throw new Error(`Regional ${resource} must require a bearer session.`);
    }
    const query = new URLSearchParams({ limit: "1", ...filters });
    const cursors = new Set();
    for (let page = 0; page < 100; page += 1) {
      const { response, value } = await call(`${path}?${query}`, { token });
      const rows = value?.[resource];
      if (response.status !== 200 || !Array.isArray(rows) || rows.length > 1) {
        throw new Error(`Regional ${resource} returned an invalid page (${response.status}).`);
      }
      if (filters.creatorId && rows.some((row) => row.creatorId !== filters.creatorId)) {
        throw new Error("Regional migrations returned a checkpoint for another Creator.");
      }
      const fixture = rows.find(match);
      if (fixture) return fixture;
      const cursor = value.nextCursor;
      if (!cursor) break;
      if (typeof cursor !== "string" || cursors.has(cursor)) {
        throw new Error(`Regional ${resource} returned an invalid cursor.`);
      }
      cursors.add(cursor);
      query.set("cursor", cursor);
    }
    return undefined;
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
    const password = randomBytes(32).toString("hex")+"Aa1!";
    const cognito = new CognitoIdentityProviderClient({ region: source.region });
    await cognito.send(new AdminCreateUserCommand({ UserPoolId: source.pool, Username: username, UserAttributes: [{ Name: "email", Value: username }, { Name: "email_verified", Value: "true" }], MessageAction: "SUPPRESS" }));
    await cognito.send(new AdminSetUserPasswordCommand({ UserPoolId: source.pool, Username: username, Password: password, Permanent: true }));
    const auth = await cognito.send(new InitiateAuthCommand({ AuthFlow: "USER_PASSWORD_AUTH", ClientId: source.client, AuthParameters: { USERNAME: username, PASSWORD: password } }));
    const token = auth.AuthenticationResult?.AccessToken;
    if (!token) throw new Error("Disposable migration user did not receive an access token.");
    const actualUser=await cognito.send(new GetUserCommand({AccessToken:token}));
    const beforeOperator=await readReferenceOperator(sourceDynamo,source.table,instanceId);
    const creator = await call("/v1/creators", { method: "POST", token, body: { handle: marker, displayName: "AWS live migration" } });
    if (creator.response.status !== 201) throw new Error(`Creator creation failed: ${JSON.stringify(creator.value)}`);
    creatorId = creator.value.creator.id; createdIds.add(creatorId);
    const actorId=creator.value.creator.subjectId;
    if(creator.value.creator.instanceId!==instanceId||!actorId||![actualUser.Username,actualUser.UserAttributes?.find(attribute=>attribute.Name==="sub")?.Value].includes(actorId))throw Error("The migration Creator fixture does not match the configured instance and authenticated actor.");
    operatorFixture={tableName:source.table,instanceId,actorId,before:beforeOperator,created:await readReferenceOperator(sourceDynamo,source.table,instanceId)};
    const work = await call("/v1/works", { method: "POST", token, body: { title: marker } });
    if (work.response.status !== 201) throw new Error(`Work creation failed: ${JSON.stringify(work.value)}`);
    createdIds.add(work.value.work.id);
    const bytes = Buffer.from("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89", "binary");
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const upload = await call("/v1/uploads", { method: "POST", token, body: { workId: work.value.work.id, mimeType: "image/png", byteLength: bytes.byteLength, checksum } });
    if (upload.response.status !== 201) throw new Error(`Upload initiation failed: ${JSON.stringify(upload.value)}`);
    const put = await fetch(upload.value.upload.parts[0].url, { method: "PUT", headers: upload.value.upload.parts[0].headers, body: bytes });
    if (!put.ok) throw new Error(`Source direct upload failed: ${put.status}`);
    const completed = await call(`/v1/uploads/${upload.value.upload.uploadId}/complete`, { method: "POST", token, body: { workId: work.value.work.id, checksum, byteLength: bytes.byteLength } });
    if (completed.response.status !== 202) throw new Error(`Upload completion failed: ${JSON.stringify(completed.value)}`);
    createdIds.add(completed.value.asset.id); createdIds.add(completed.value.job.id);
    const published=await publishReferenceWhenReady((path,options)=>call(path,{...options,token}),{workId:work.value.work.id,idempotencyKey:marker+'-publication'});
    createdIds.add(published.intent.id);createdIds.add(published.publication.id);
    const sourceRoute = { creatorId, homeCellId: source.cellId, homeRegion: source.region, endpoint: `${source.api}/`, routingRevision: 1, state: "active", updatedAt: new Date().toISOString() };
    await control.routingDirectory.create(sourceRoute);
    const requestOnly = new MigrationOrchestrator(control.routingDirectory, control.migrationCheckpoints, {});
    await requestOnly.request({ id: migrationId, creatorId, destination: { cellId: destination.cellId, region: destination.region, endpoint: `${destination.api}/` } });
    if (process.env.UBEEQ_AWS_VERIFY_REGIONAL_OPERATOR_READS === "true") {
      const path = `/v1/operations/regional/migrations/${encodeURIComponent(migrationId)}/resume`;
      if ((await call(path, { method: "POST" })).response.status !== 401) {
        throw new Error("Reference migration commands must require an operator session.");
      }
      const unavailable = await call(path, { method: "POST", token });
      if (unavailable.response.status !== 503 || unavailable.value?.error?.code !== "migration_worker_unavailable") {
        throw new Error("The reference API did not report a read-only migration control plane.");
      }
    }
    await commands.enqueue({ migrationId, operation: "resume", rollbackWindowSeconds: 300 });
    checkpoint = await waitFor(async () => { const value = await control.migrationCheckpoints.get(migrationId); return value?.state === "cutover" ? value : undefined; }, "migration cutover");
    if (checkpoint.objectCount !== checkpoint.verifiedObjectCount || checkpoint.objectCount !== 3) throw new Error(`Migration inventory verification failed: ${JSON.stringify(checkpoint)}`);
    const cutoverRoute = await control.routingDirectory.get(creatorId);
    if (cutoverRoute?.homeCellId !== destination.cellId || cutoverRoute.routingRevision !== 2) throw new Error("Migration route did not cut over atomically.");
    if (process.env.UBEEQ_AWS_VERIFY_REGIONAL_OPERATOR_READS === "true") {
      await waitFor(async () => {
        const route = await findRegionalFixture("routes", token, (row) => row.creatorId === creatorId);
        const migration = await findRegionalFixture(
          "migrations", token, (row) => row.id === migrationId, { creatorId },
        );
        return route?.homeCellId === destination.cellId && route.routingRevision === 2
          && migration?.state === "cutover" && migration.destination?.cellId === destination.cellId;
      }, "operator visibility of cutover");
    }
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
    try{
      if(operatorFixture){
        for(const [client,table] of [[sourceDynamo,source.table],[destinationDynamo,destination.table]])if((await client.send(new GetCommand({TableName:table,Key:{pk:`creators#${creatorId}`,sk:'record'},ConsistentRead:true}))).Item)throw Error('Migration Creator cleanup is incomplete; its operator claim was retained.');
        const released=await releaseCreatedReferenceOperator(sourceDynamo,operatorFixture);
        if(!released&&operatorFixture.before===undefined)throw Error('The migration operator fixture changed during teardown; its claim was retained.');
      }
    }finally{
      if (username) await new CognitoIdentityProviderClient({ region: source.region }).send(new AdminDeleteUserCommand({ UserPoolId: source.pool, Username: username })).catch(() => undefined);
    }
  }
}
