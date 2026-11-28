import {publishReferenceWhenReady} from './reference-publication-retry.mjs';
import {readReferenceOperator,releaseCreatedReferenceOperator} from './owned-reference-operator.mjs';
/** Opt-in AWS example flow: Cognito bearer auth -> API Gateway -> direct S3 -> SQS worker -> publication -> delivery. */
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
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
    if (process.env.UBEEQ_AWS_VERIFY_OPERATOR_READS === "true") {
      const jobsPath = "/v1/operations/jobs?state=completed&limit=250";
      const unauthenticated = await call(jobsPath);
      if (unauthenticated.response.status !== 401) throw new Error("Processing jobs must require authentication.");
      let job;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const result = await call(jobsPath, { token });
        if (result.response.status !== 200 || !Array.isArray(result.value?.jobs)) {
          throw new Error(`Processing job listing failed (${result.response.status}).`);
        }
        job = result.value.jobs.find(({ id }) => id === completed.value.job.id);
        if (job || attempt === 4) break;
        await wait(1000);
      }
      if (job?.state !== "completed" || job?.payload?.assetId !== completed.value.asset.id) {
        throw new Error("The processing job list did not contain the completed upload fixture.");
      }
      if (job.correlationId !== completed.value.job.correlationId || Object.hasOwn(job, "requestCorrelationId")) {
        throw new Error("The processing job list did not preserve the public request trace.");
      }
      const findEvent = async (kind, matches) => {
        const path = `/v1/operations/${kind}-events`;
        if ((await call(path)).response.status !== 401) {
          throw new Error(`Operator ${kind} events must require authentication.`);
        }
        for (let attempt = 0; attempt < 5; attempt += 1) {
          let cursor;
          for (let page = 0; page < 25; page += 1) {
            const query = new URLSearchParams({ limit: "100" });
            if (cursor) query.set("cursor", cursor);
            const result = await call(`${path}?${query}`, { token });
            if (result.response.status !== 200 || !Array.isArray(result.value?.events)) {
              throw new Error(`Operator ${kind} event listing failed (${result.response.status}).`);
            }
            const event = result.value.events.find(matches);
            if (event) return event;
            cursor = result.value.nextCursor;
            if (!cursor) break;
          }
          if (attempt < 4) await wait(1000);
        }
        throw new Error(`The operator ${kind} event listing did not return the fixture.`);
      };
      const audit = await findEvent("audit", event =>
        event.action === "work.published" && event.subjectId === work.value.work.id
        && event.payload?.publicationId === published.publication.id);
      const usage = await findEvent("usage", event =>
        event.accountId === creator.value.creator.id && event.meter === "processing_units"
        && event.idempotencyKey === `asset-processing:${completed.value.asset.id}:${completed.value.asset.objectVersion}`);
      if (audit.actorId !== actorId || usage.quantity !== 1
        || [audit, usage].some(event => event.instanceId !== instanceId
          || event.homeCellId !== creator.value.creator.homeCellId)) {
        throw new Error("Operator evidence did not match the fixture actor, usage, or cell.");
      }
      const casesPath = "/v1/operations/review-cases";
      const openRequest = {
        method: "POST", token,
        headers: { "idempotency-key": marker + "-review-case" },
        body: { subjectId: work.value.work.id },
      };
      const opened = await call(casesPath, openRequest);
      const reviewCase = opened.value?.reviewCase;
      if (reviewCase?.id && reviewCase.subjectId === work.value.work.id) created.add(reviewCase.id);
      if (opened.response.status !== 201 || !reviewCase?.id || reviewCase.state !== "open"
        || reviewCase.subjectId !== work.value.work.id || reviewCase.homeCellId !== creator.value.creator.homeCellId) {
        throw new Error("The Rust API did not open an in-scope review case.");
      }
      const repeated = await call(casesPath, openRequest);
      if (repeated.response.status !== 200 || repeated.value?.reviewCase?.id !== reviewCase.id
        || repeated.value.reviewCase.revision !== reviewCase.revision) {
        throw new Error("Review case creation replay did not return the original case.");
      }
      const casePath = `${casesPath}/${encodeURIComponent(reviewCase.id)}`;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const assigned = await call(casePath, { method: "POST", token, body: { state: "assigned", assigneeId: actorId } });
        if (assigned.response.status !== 200 || assigned.value?.reviewCase?.state !== "assigned"
          || assigned.value.reviewCase.id !== reviewCase.id || assigned.value.reviewCase.assigneeId !== actorId
          || assigned.value.reviewCase.revision !== reviewCase.revision + 1) {
          throw new Error("Repeating a review case assignment must advance its revision exactly once.");
        }
      }
      const openedAudit = await findEvent("audit", event =>
        event.action === "moderation.review_case_opened" && event.payload?.reviewCaseId === reviewCase.id);
      const assignedAudit = await findEvent("audit", event =>
        event.action === "moderation.review_case_updated" && event.payload?.reviewCaseId === reviewCase.id
        && event.payload?.state === "assigned");
      if ([openedAudit, assignedAudit].some(event => event.actorId !== actorId || event.subjectId !== work.value.work.id)) {
        throw new Error("Review case audit events did not match the fixture actor and Work.");
      }
    }
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
    if (process.env.UBEEQ_AWS_VERIFY_OPERATOR_READS === "true") {
      const holdsPath = "/v1/operations/holds";
      const holdRequest = {
        method: "POST",
        token,
        headers: { "idempotency-key": marker + "-hold" },
        body: { subjectType: "work", subjectId: work.value.work.id, reason: marker },
      };
      const opened = await call(holdsPath, holdRequest);
      const hold = opened.value?.hold;
      if (hold?.id && hold.subjectId === work.value.work.id) created.add(hold.id);
      if (opened.response.status !== 201 || !hold?.id || hold.state !== "active"
        || hold.subjectId !== work.value.work.id || hold.homeCellId !== creator.value.creator.homeCellId) {
        throw new Error("The Rust API did not create the scoped moderation hold.");
      }
      const duplicate = await call(holdsPath, holdRequest);
      if (duplicate.response.status !== 200 || duplicate.value?.hold?.id !== hold.id
        || duplicate.value.hold.revision !== hold.revision) {
        throw new Error("A retried hold creation did not return the original hold.");
      }
      const conflict = await call(holdsPath, { ...holdRequest, body: { ...holdRequest.body, reason: marker + "-different" } });
      if (conflict.response.status !== 409 || conflict.value?.error?.code !== "idempotency_conflict") {
        throw new Error("Reusing a hold creation key with a different reason must conflict.");
      }
      const publicPath = `/v1/public/works/${work.value.work.id}`;
      if ((await call(publicPath)).response.status !== 404) {
        throw new Error("An active Work hold must prevent new public delivery grants.");
      }
      const releasePath = `${holdsPath}/${encodeURIComponent(hold.id)}/release`;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const released = await call(releasePath, { method: "POST", token });
        if (released.response.status !== 200 || released.value?.hold?.state !== "released"
          || released.value.hold.id !== hold.id || released.value.hold.revision !== hold.revision + 1) {
          throw new Error("Hold release must advance its revision exactly once.");
        }
      }
      const restored = await call(publicPath);
      if (restored.response.status !== 200 || !restored.value.assets?.[0]?.delivery?.url) {
        throw new Error("Releasing the hold did not restore eligibility for public delivery.");
      }
    }
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
