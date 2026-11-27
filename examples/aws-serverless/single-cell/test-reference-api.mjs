import {publishReferenceWhenReady} from './reference-publication-retry.mjs';
import {readReferenceOperator,releaseCreatedReferenceOperator} from './owned-reference-operator.mjs';
/** Opt-in AWS example flow: Cognito bearer auth -> API Gateway -> direct S3 -> SQS worker -> publication -> delivery. */
import { createHash, randomUUID } from "node:crypto";
import { CognitoIdentityProviderClient, GetUserCommand } from "@aws-sdk/client-cognito-identity-provider";
import { DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { DeleteCommand, GetCommand, DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";

const required = ["UBEEQ_AWS_API_URL", "UBEEQ_AWS_REGION", "UBEEQ_AWS_RECORDS_TABLE", "UBEEQ_AWS_OBJECT_BUCKET", "UBEEQ_AWS_TEST_USERNAME", "UBEEQ_AWS_TEST_PASSWORD"];
const missing = required.filter((name) => !process.env[name]);
if (missing.length) {
  console.error(`AWS reference API test requires: ${missing.join(", ")}`);
  process.exitCode = 2;
} else {
  const region = process.env.UBEEQ_AWS_REGION;
  const webOrigin = process.env.UBEEQ_AWS_WEB_ORIGIN
    ? new URL(process.env.UBEEQ_AWS_WEB_ORIGIN).origin
    : undefined;
  const apiUrl = webOrigin ? `${webOrigin}/api` : process.env.UBEEQ_AWS_API_URL.replace(/\/$/, "");
  const marker = `aws-api-e2e-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
  const s3 = new S3Client({ region });
  const created = new Set(); let object, operatorFixture;
  const instanceId=process.env.UBEEQ_AWS_INSTANCE_ID ?? "aws-reference";
  const call = async (path, { method = "GET", token, body, headers = {} } = {}) => {
    const response = await fetch(`${apiUrl}${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = response.status === 204 ? undefined : await response.json();
    return { response, value };
  };
  try {
    const auth = await call("/v1/auth/sign-in", { method: "POST", body: {
      email: process.env.UBEEQ_AWS_TEST_USERNAME, password: process.env.UBEEQ_AWS_TEST_PASSWORD,
    } });
    const token = auth.value?.token;
    if (auth.response.status !== 200 || typeof token !== "string" || !token) {
      throw new Error(`The reference API sign-in failed (${auth.response.status}).`);
    }
    const actualUser=await new CognitoIdentityProviderClient({region}).send(new GetUserCommand({AccessToken:token}));
    const beforeOperator=await readReferenceOperator(dynamo,process.env.UBEEQ_AWS_RECORDS_TABLE,instanceId);
    const creator = await call("/v1/creators", { method: "POST", token, body: { handle: marker, displayName: "AWS API E2E" } });
    if (creator.response.status !== 201) throw new Error(`Creator creation failed: ${JSON.stringify(creator.value)}`);
    created.add(creator.value.creator.id);
    if(creator.value.creator.instanceId!==instanceId)throw Error("The reference test instance ID does not match the configured API.");
    const actorId=creator.value.creator.subjectId;
    if(!actorId||![actualUser.Username,actualUser.UserAttributes?.find(attribute=>attribute.Name==="sub")?.Value].includes(actorId))throw Error("The created fixture does not belong to the authenticated Cognito user.");
    operatorFixture={tableName:process.env.UBEEQ_AWS_RECORDS_TABLE,instanceId,actorId,creatorId:creator.value.creator.id,before:beforeOperator,created:await readReferenceOperator(dynamo,process.env.UBEEQ_AWS_RECORDS_TABLE,instanceId)};
    const work = await call("/v1/works", { method: "POST", token, body: { title: marker } });
    if (work.response.status !== 201) throw new Error(`Work creation failed: ${JSON.stringify(work.value)}`);
    created.add(work.value.work.id);
    const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64");
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const upload = await call("/v1/uploads", { method: "POST", token, body: { workId: work.value.work.id, mimeType: "image/png", byteLength: bytes.byteLength, checksum } });
    if (upload.response.status !== 201 || !upload.value.upload.parts?.[0]?.url) throw new Error(`Upload initiation did not issue a direct S3 URL: ${JSON.stringify(upload.value)}`);
    const part = upload.value.upload.parts[0];
    if (webOrigin) {
      const preflight = await fetch(part.url, { method: "OPTIONS", headers: {
        origin: webOrigin,
        "access-control-request-method": "PUT",
        "access-control-request-headers": Object.keys(part.headers).join(","),
      } });
      if (!preflight.ok || preflight.headers.get("access-control-allow-origin") !== webOrigin) {
        throw new Error(`S3 rejected the workspace upload preflight (${preflight.status}).`);
      }
    }
    const put = await fetch(part.url, { method: "PUT", headers: { ...part.headers, ...(webOrigin ? { origin: webOrigin } : {}) }, body: bytes });
    if (webOrigin && put.headers.get("access-control-allow-origin") !== webOrigin) {
      throw new Error(`S3 did not allow the workspace to read the upload response (${put.status}).`);
    }
    if (!put.ok) {
      // Provider XML may contain signed requests and temporary access tokens.
      const code = /<Code>([A-Za-z0-9]+)<\/Code>/.exec(await put.text())?.[1] ?? "UnknownProviderError";
      throw new Error(`Direct S3 upload failed: ${put.status} ${code}`);
    }
    const completed = await call(`/v1/uploads/${upload.value.upload.uploadId}/complete`, { method: "POST", token, body: { workId: work.value.work.id, checksum, byteLength: bytes.byteLength } });
    if (completed.response.status !== 202) throw new Error(`Upload completion failed: ${JSON.stringify(completed.value)}`);
    created.add(completed.value.asset.id); created.add(completed.value.job.id); object = completed.value.asset.storage;
    const published=await publishReferenceWhenReady((path,options)=>call(path,{...options,token}),{workId:work.value.work.id,idempotencyKey:marker+'-publication'});
    created.add(published.intent.id);created.add(published.publication.id);
    const replay = await publishReferenceWhenReady((path, options) => call(path, { ...options, token }), {
      workId: work.value.work.id, idempotencyKey: marker + '-publication', attempts: 1,
    });
    if (!replay.idempotent || replay.intent.id !== published.intent.id || replay.publication.id !== published.publication.id) {
      throw new Error("Publication replay did not return the original receipt.");
    }
    const publicWork = await call(`/v1/public/works/${work.value.work.id}`);
    if (publicWork.response.status !== 200 || !publicWork.value.assets?.[0]?.delivery?.url) throw new Error(`Public work or delivery grant failed: ${JSON.stringify(publicWork.value)}`);
    const delivery = await fetch(publicWork.value.assets[0].delivery.url);
    if (!delivery.ok || !Buffer.from(await delivery.arrayBuffer()).equals(bytes)) throw new Error("Delivered object differs from the uploaded source version.");
    console.log("AWS reference sign-in, upload, processing, publication, and delivery flow passed.");
  } finally {
    if (object?.key) await s3.send(new DeleteObjectCommand({ Bucket: process.env.UBEEQ_AWS_OBJECT_BUCKET, Key: object.key, VersionId: object.versionId })).catch(() => undefined);
    let cursor;
    do {
      const scanned = await dynamo.send(new ScanCommand({ TableName: process.env.UBEEQ_AWS_RECORDS_TABLE, ExclusiveStartKey: cursor })).catch(() => ({ Items: [] }));
      for (const item of scanned.Items ?? []) {
        const serialized = JSON.stringify(item);
        if (serialized.includes(marker) || [...created].some((id) => serialized.includes(id))) await dynamo.send(new DeleteCommand({ TableName: process.env.UBEEQ_AWS_RECORDS_TABLE, Key: { pk: item.pk, sk: item.sk } })).catch(() => undefined);
      }
      cursor = scanned.LastEvaluatedKey;
    } while (cursor);
    if(operatorFixture){
      const remaining=await dynamo.send(new GetCommand({TableName:operatorFixture.tableName,Key:{pk:`creators#${operatorFixture.creatorId}`,sk:"record"},ConsistentRead:true}));
      if(remaining.Item)throw Error("Owned Creator fixture cleanup failed; its operator claim was retained.");
      const released=await releaseCreatedReferenceOperator(dynamo,operatorFixture);
      if(!released&&operatorFixture.before===undefined)throw Error("The owned operator fixture changed during teardown; its claim was retained.");
    }
  }
}
