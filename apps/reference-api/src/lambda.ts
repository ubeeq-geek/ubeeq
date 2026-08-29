import { Readable } from "node:stream";
import { AwsMigrationControlWorker, createAwsAdapterSet, createAwsMigrationCommandQueue, createAwsRoutingControlPlane } from "@ubeeq/adapter-aws";
import { createReferenceApi, type ReferenceAdapterSet } from "./server.js";
import { createMigrationCellEndpoint } from "./migration-cell.js";

type FunctionUrlEvent = {
  rawPath?: string;
  rawQueryString?: string;
  headers?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
  requestContext?: { http?: { method?: string }; authorizer?: { iam?: { userArn?: string } } };
};
type FunctionUrlResult = { statusCode: number; headers: Record<string, string>; body: string; isBase64Encoded?: boolean };
type SqsEvent = { Records?: readonly { messageId: string }[] };
type MigrationSqsEvent = { Records?: readonly { messageId: string; body: string }[] };
const required = (name: string): string => { const value = process.env[name]; if (!value) throw new Error(`${name} is not configured`); return value; };

/**
 * Small Function URL bridge. It intentionally adapts Lambda events at the edge, so
 * the reference API keeps its usual HTTP transport and receives only neutral ports.
 */
const toRequest = (event: FunctionUrlEvent): import("node:http").IncomingMessage => {
  const body = event.body ? Buffer.from(event.body, event.isBase64Encoded ? "base64" : "utf8") : Buffer.alloc(0);
  const request = Readable.from(body.length ? [body] : []) as import("node:http").IncomingMessage;
  Object.assign(request, {
    method: event.requestContext?.http?.method ?? "GET",
    url: `${event.rawPath ?? "/"}${event.rawQueryString ? `?${event.rawQueryString}` : ""}`,
    headers: Object.fromEntries(Object.entries(event.headers ?? {}).filter(([, value]) => value !== undefined)),
  });
  return request;
};

const invokeApi = async (event: FunctionUrlEvent): Promise<FunctionUrlResult> => {
  const responseHeaders: Record<string, string> = { "cache-control": "no-store" };
  let statusCode = 200;
  let responseBody = Buffer.alloc(0);
  const response = {
    setHeader(name: string, value: number | string | readonly string[]) { responseHeaders[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value); },
    end(value?: string | Uint8Array) { responseBody = value === undefined ? Buffer.alloc(0) : Buffer.from(value); },
    get statusCode() { return statusCode; },
    set statusCode(value: number) { statusCode = value; },
  } as unknown as import("node:http").ServerResponse;
  const api = referenceApi();
  await api.handle(toRequest(event), response);
  const contentType = responseHeaders["content-type"] ?? "";
  const binary = !contentType.includes("json") && !contentType.startsWith("text/");
  return { statusCode, headers: responseHeaders, body: responseBody.toString(binary ? "base64" : "utf8"), ...(binary ? { isBase64Encoded: true } : {}) };
};

const invokeWeb = async (event: FunctionUrlEvent): Promise<FunctionUrlResult> => {
  const responseHeaders: Record<string, string> = { "cache-control": "no-store" };
  let statusCode = 200;
  let responseBody = Buffer.alloc(0);
  const response = {
    setHeader(name: string, value: number | string | readonly string[]) { responseHeaders[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value); },
    writeHead(status: number, headers?: Record<string, string>) { statusCode = status; for (const [name, value] of Object.entries(headers ?? {})) responseHeaders[name.toLowerCase()] = value; },
    end(value?: string | Uint8Array) { responseBody = value === undefined ? Buffer.alloc(0) : Buffer.from(value); },
    get statusCode() { return statusCode; },
    set statusCode(value: number) { statusCode = value; },
  } as unknown as import("node:http").ServerResponse;
  const modulePath = process.env.UBEEQ_REFERENCE_WEB_MODULE_PATH ?? "./web-reference/server.mjs";
  const web = await import(modulePath) as { createReferenceHandler(input: { referenceApiUrl: string }): (request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse) => Promise<void> };
  await web.createReferenceHandler({ referenceApiUrl: required("UBEEQ_REFERENCE_WEB_API_URL") })(toRequest(event), response);
  const contentType = responseHeaders["content-type"] ?? "";
  const binary = !contentType.includes("json") && !contentType.startsWith("text/");
  return { statusCode, headers: responseHeaders, body: responseBody.toString(binary ? "base64" : "utf8"), ...(binary ? { isBase64Encoded: true } : {}) };
};

let application: ReturnType<typeof createReferenceApi> | undefined;
const referenceApi = (): ReturnType<typeof createReferenceApi> => application ??= createReferenceApi({
  instanceId: process.env.UBEEQ_INSTANCE_ID ?? "aws-reference",
  cellId: process.env.UBEEQ_CELL_ID ?? process.env.AWS_REGION ?? "aws-reference-cell",
  region: process.env.UBEEQ_CELL_REGION ?? process.env.AWS_REGION ?? "unknown",
  operator: process.env.UBEEQ_CELL_OPERATOR ?? "self-hosted",
  publicBaseUrl: required("UBEEQ_PUBLIC_BASE_URL"),
  adapters: createAwsAdapterSet({
    region: process.env.AWS_REGION,
    cellId: process.env.UBEEQ_CELL_ID ?? process.env.AWS_REGION ?? "aws-reference-cell",
    tableName: required("UBEEQ_RECORDS_TABLE"),
    objectBucket: required("UBEEQ_SOURCE_BUCKET"),
    queueUrl: required("UBEEQ_JOBS_QUEUE_URL"),
    userPoolId: required("UBEEQ_USER_POOL_ID"),
    userPoolClientId: required("UBEEQ_USER_POOL_CLIENT_ID"),
    credentialSecretPrefix: required("UBEEQ_CREDENTIAL_SECRET_PREFIX"),
  }) as ReferenceAdapterSet,
  ...(process.env.UBEEQ_ROUTING_DIRECTORY_TABLE_NAME ? { regionalControlPlane: createAwsRoutingControlPlane({ tableName: process.env.UBEEQ_ROUTING_DIRECTORY_TABLE_NAME, region: required("UBEEQ_ROUTING_DIRECTORY_REGION") }) } : {}),
});

const awsCellAdapters = () => createAwsAdapterSet({
  region: process.env.AWS_REGION,
  cellId: process.env.UBEEQ_CELL_ID ?? process.env.AWS_REGION ?? "aws-reference-cell",
  tableName: required("UBEEQ_RECORDS_TABLE"), objectBucket: required("UBEEQ_SOURCE_BUCKET"), queueUrl: required("UBEEQ_JOBS_QUEUE_URL"),
  userPoolId: required("UBEEQ_USER_POOL_ID"), userPoolClientId: required("UBEEQ_USER_POOL_CLIENT_ID"), credentialSecretPrefix: required("UBEEQ_CREDENTIAL_SECRET_PREFIX"),
});

export const handler = async (event: FunctionUrlEvent): Promise<FunctionUrlResult> => {
  try { return await invokeApi(event); }
  catch (error) {
    return { statusCode: 503, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }, body: JSON.stringify({ error: { code: "runtime_unavailable", message: error instanceof Error ? error.message : "Reference API runtime is unavailable" } }) };
  }
};

/** Private Lambda-invocation endpoint used only by the registered migration worker. */
export const migrationCell = async (command: import("@ubeeq/deployment-platform").MigrationCellCommand): Promise<{ result?: import("@ubeeq/deployment-platform").MigrationCellCommandResult; error?: { message: string } }> => {
  try {
    const adapters = awsCellAdapters();
    const result = await createMigrationCellEndpoint({ cellId: required("UBEEQ_CELL_ID"), region: required("UBEEQ_CELL_REGION"), instanceId: process.env.UBEEQ_INSTANCE_ID ?? "aws-reference", repositories: adapters.repositories, storage: adapters.storage }).execute(command);
    return { result };
  } catch (error) { return { error: { message: error instanceof Error ? error.message : "Migration cell command failed" } }; }
};

/** SQS entry point for the same durable job service used by the local reference worker. */
export const worker = async (event: SqsEvent): Promise<{ batchItemFailures: Array<{ itemIdentifier: string }> }> => {
  const failures: Array<{ itemIdentifier: string }> = [];
  for (const record of event.Records ?? []) {
    try { await referenceApi().runNextJob(`aws-worker:${record.messageId}`); }
    catch { failures.push({ itemIdentifier: record.messageId }); }
  }
  return { batchItemFailures: failures };
};

/**
 * Operator-control-plane SQS entry point. This is deliberately separate from
 * a cell's normal durable-job worker: it reads route/checkpoint/cell metadata
 * only and invokes registered private migration endpoints.
 */
export const migrationControlWorker = async (event: MigrationSqsEvent): Promise<{ batchItemFailures: Array<{ itemIdentifier: string }> }> => {
  const failures: Array<{ itemIdentifier: string }> = [];
  const tableName = required("UBEEQ_ROUTING_DIRECTORY_TABLE_NAME");
  const control = createAwsRoutingControlPlane({ tableName, region: required("UBEEQ_ROUTING_DIRECTORY_REGION") });
  const worker = new AwsMigrationControlWorker({ routingDirectory: control.routingDirectory, checkpoints: control.migrationCheckpoints, cells: control.migrationCells });
  for (const record of event.Records ?? []) {
    try {
      const command = JSON.parse(record.body) as { migrationId?: string; operation?: "resume" | "rollback" | "retire"; rollbackWindowSeconds?: number };
      if (!command.migrationId || !command.operation) throw new Error("Migration queue message is invalid.");
      const checkpoint = await worker.execute({ migrationId: command.migrationId, operation: command.operation, rollbackWindowSeconds: command.rollbackWindowSeconds });
      // Structured, non-secret operational evidence. A Logs metric filter in
      // the optional AWS control plane uses this to chart migration transfer
      // volume; it never emits object keys, credentials, or creator data.
      console.log(JSON.stringify({
        event: "ubeeq.migration.command.completed",
        migrationId: checkpoint.id,
        operation: command.operation,
        state: checkpoint.state,
        sourceCellId: checkpoint.source.homeCellId,
        destinationCellId: checkpoint.destination.cellId,
        transferBytes: checkpoint.objectInventory?.reduce((total, object) => total + object.byteLength, 0) ?? 0,
      }));
    } catch (error) {
      console.error("Ubeeq migration control command failed", { messageId: record.messageId, error: error instanceof Error ? error.message : String(error) });
      failures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures: failures };
};

/** IAM Function URL identity is checked again here before any operator action. */
const requireMigrationOperator = (event: FunctionUrlEvent): void => {
  const expected = required("UBEEQ_MIGRATION_OPERATOR_PRINCIPAL_ARN");
  const actual = event.requestContext?.authorizer?.iam?.userArn;
  // Function URLs report a direct IAM principal for some callers and an STS
  // assumed-role ARN for SSO/session callers. Match the configured role ARN,
  // never an account-wide prefix or an arbitrary assumed role.
  const role = expected.match(/^arn:aws(?:-us-gov|-cn)?:iam::(\d{12}):role\/(?:.*\/)?([^/]+)$/);
  const assumed = actual?.match(/^arn:aws(?:-us-gov|-cn)?:sts::(\d{12}):assumed-role\/([^/]+)\/[^/]+$/);
  if (actual !== expected && !(role && assumed && role[1] === assumed[1] && role[2] === assumed[2])) throw new Error("Operator authorization is required.");
};

/**
 * IAM-protected operator API for the separate migration control plane. It
 * exposes metadata/listing and enqueues opaque checkpoint commands; it never
 * proxies a creator write or returns a cell's bucket/function identifiers.
 */
export const migrationControlApi = async (event: FunctionUrlEvent): Promise<FunctionUrlResult> => {
  try {
    requireMigrationOperator(event);
    const path = event.rawPath ?? "/", method = event.requestContext?.http?.method ?? "GET", query = new URLSearchParams(event.rawQueryString ?? "");
    const tableName = required("UBEEQ_ROUTING_DIRECTORY_TABLE_NAME"), region = required("UBEEQ_ROUTING_DIRECTORY_REGION"), queueUrl = required("UBEEQ_MIGRATION_COMMANDS_QUEUE_URL");
    const control = createAwsRoutingControlPlane({ tableName, region }), limit = Math.max(1, Math.min(100, Number(query.get("limit") ?? 50)));
    if (method === "GET" && path === "/v1/operations/regional/routes") return { statusCode: 200, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }, body: JSON.stringify(await control.routingDirectory.list({ limit, cursor: query.get("cursor") ?? undefined })) };
    if (method === "GET" && path === "/v1/operations/regional/migrations") return { statusCode: 200, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }, body: JSON.stringify(await control.migrationCheckpoints.list({ limit, cursor: query.get("cursor") ?? undefined })) };
    if (method === "GET" && path === "/v1/operations/regional/cells") {
      const cells = await control.migrationCells.list({ limit, cursor: query.get("cursor") ?? undefined });
      return { statusCode: 200, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }, body: JSON.stringify({ items: cells.items.map(({ migrationEndpoint: _migrationEndpoint, objectBucket: _objectBucket, ...cell }) => cell), nextCursor: cells.nextCursor }) };
    }
    const command = path.match(/^\/v1\/operations\/regional\/migrations\/([^/]+)\/(resume|rollback|retire)$/);
    if (method === "POST" && command) {
      const body = event.body ? JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body) as { rollbackWindowSeconds?: number } : {};
      await createAwsMigrationCommandQueue({ queueUrl, region }).enqueue({ migrationId: command[1], operation: command[2] as "resume" | "rollback" | "retire", rollbackWindowSeconds: body.rollbackWindowSeconds });
      return { statusCode: 202, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }, body: JSON.stringify({ migrationId: command[1], operation: command[2], state: "queued" }) };
    }
    return { statusCode: 404, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }, body: JSON.stringify({ error: { code: "not_found", message: "Operator control-plane route was not found" } }) };
  } catch (error) {
    const unauthorized = error instanceof Error && error.message === "Operator authorization is required.";
    return { statusCode: unauthorized ? 403 : 500, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }, body: JSON.stringify({ error: { code: unauthorized ? "operator_authorization_denied" : "control_plane_error", message: error instanceof Error ? error.message : "Control plane failed" } }) };
  }
};

/** Reference web edge entry point. It proxies same-origin /api calls to the configured reference API. */
export const web = async (event: FunctionUrlEvent): Promise<FunctionUrlResult> => {
  try { return await invokeWeb(event); }
  catch (error) { return { statusCode: 503, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }, body: JSON.stringify({ error: { code: "reference_web_unavailable", message: error instanceof Error ? error.message : "Reference web is unavailable" } }) }; }
};
