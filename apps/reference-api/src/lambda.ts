/**
 * AWS edge entry point for the reference API. It deliberately imports only AWS SDK
 * clients available in the Lambda Node runtime; application services remain behind
 * provider-neutral packages and are composed by the deployment runtime.
 */
import { DescribeTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { GetQueueAttributesCommand, SQSClient } from "@aws-sdk/client-sqs";

type FunctionUrlEvent = { rawPath?: string; requestContext?: { http?: { method?: string } } };
type FunctionUrlResult = { statusCode: number; headers: Record<string, string>; body: string };
const json = (statusCode: number, body: unknown): FunctionUrlResult => ({ statusCode, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }, body: JSON.stringify(body) });

const region = process.env.AWS_REGION;
const dynamo = new DynamoDBClient({ region }); const s3 = new S3Client({ region }); const sqs = new SQSClient({ region });
const required = (name: string): string => { const value = process.env[name]; if (!value) throw new Error(`${name} is not configured`); return value; };

export const handler = async (event: FunctionUrlEvent): Promise<FunctionUrlResult> => {
  const path = event.rawPath ?? "/";
  if (path === "/health") return json(200, { ok: true, service: "ubeeq-reference-api", runtime: "aws-lambda" });
  if (path !== "/ready") return json(404, { error: { code: "not_found", message: "Route was not found" } });
  try {
    await Promise.all([
      dynamo.send(new DescribeTableCommand({ TableName: required("UBEEQ_RECORDS_TABLE") })),
      s3.send(new HeadBucketCommand({ Bucket: required("UBEEQ_SOURCE_BUCKET") })),
      sqs.send(new GetQueueAttributesCommand({ QueueUrl: required("UBEEQ_JOBS_QUEUE_URL"), AttributeNames: ["QueueArn"] }))
    ]);
    return json(200, { ok: true, status: "ok", dependencies: ["dynamodb", "s3", "sqs"] });
  } catch (error) { return json(503, { ok: false, status: "degraded", error: error instanceof Error ? error.message : "Dependency check failed" }); }
};
