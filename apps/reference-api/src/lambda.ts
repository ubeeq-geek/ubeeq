import { Readable } from "node:stream";
import { createAwsAdapterSet } from "@ubeeq/adapters-aws";
import { createReferenceApi, type ReferenceAdapterSet } from "./server.js";

type FunctionUrlEvent = {
  rawPath?: string;
  rawQueryString?: string;
  headers?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
  requestContext?: { http?: { method?: string } };
};
type FunctionUrlResult = { statusCode: number; headers: Record<string, string>; body: string; isBase64Encoded?: boolean };
type SqsEvent = { Records?: readonly { messageId: string }[] };
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
  region: process.env.AWS_REGION ?? "unknown",
  operator: "self-hosted",
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
});

export const handler = async (event: FunctionUrlEvent): Promise<FunctionUrlResult> => {
  try { return await invokeApi(event); }
  catch (error) {
    return { statusCode: 503, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }, body: JSON.stringify({ error: { code: "runtime_unavailable", message: error instanceof Error ? error.message : "Reference API runtime is unavailable" } }) };
  }
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

/** Reference web edge entry point. It proxies same-origin /api calls to the configured reference API. */
export const web = async (event: FunctionUrlEvent): Promise<FunctionUrlResult> => {
  try { return await invokeWeb(event); }
  catch (error) { return { statusCode: 503, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }, body: JSON.stringify({ error: { code: "reference_web_unavailable", message: error instanceof Error ? error.message : "Reference web is unavailable" } }) }; }
};
