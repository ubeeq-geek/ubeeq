/** Optional AWS adapter composition. AWS SDK imports are intentionally isolated to this package. */
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand, DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DescribeTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetQueueAttributesCommand, SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { CreateSecretCommand, GetSecretValueCommand, UpdateSecretCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { GetUserCommand, GlobalSignOutCommand, InitiateAuthCommand, CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { getSignedUrl as getCloudFrontSignedUrl } from "@aws-sdk/cloudfront-signer";
import { createHash, randomUUID } from "node:crypto";
import { CellScopedRepository, OptimisticConcurrencyError, type CellOwnedRecord, type Page, type PageRequest, type RevisionedRecord, type RevisionedRepository, type UbeeqRepositories } from "@ubeeq/persistence";
import { requireCreatorScopedObject, type DeliveryAdapter, type ObjectStorage, type StoredObject, type UploadAdapter, type UploadCompletion, type UploadInitiation } from "@ubeeq/storage";
import type { AuthenticatedSession, IdentityAccount, IdentityAdapter } from "@ubeeq/auth";
import type { CredentialVault } from "@ubeeq/integrations";
import type { DurableJob, JobLease, JobQueue, JobState } from "@ubeeq/jobs";

export const AWS_ADAPTERS_API_VERSION = "1" as const;
export type AwsFunctionUrlEvent = { rawPath?: string; requestContext?: { http?: { method?: string } } };
export type AwsFunctionUrlResult = { statusCode: number; headers: Record<string, string>; body: string };
export const createAwsReferenceHealthHandler = (input: { region?: string; recordsTable(): string; sourceBucket(): string; jobsQueueUrl(): string }) => {
  const dynamo = new DynamoDBClient({ region: input.region }), s3 = new S3Client({ region: input.region }), sqs = new SQSClient({ region: input.region }); const jsonResponse = (statusCode: number, body: unknown): AwsFunctionUrlResult => ({ statusCode, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }, body: JSON.stringify(body) });
  return async (event: AwsFunctionUrlEvent): Promise<AwsFunctionUrlResult> => { const path = event.rawPath ?? "/"; if (path === "/health") return jsonResponse(200, { ok: true, service: "ubeeq-reference-api", runtime: "aws-lambda" }); if (path !== "/ready") return jsonResponse(404, { error: { code: "not_found", message: "Route was not found" } }); try { await Promise.all([dynamo.send(new DescribeTableCommand({ TableName: input.recordsTable() })), s3.send(new HeadBucketCommand({ Bucket: input.sourceBucket() })), sqs.send(new GetQueueAttributesCommand({ QueueUrl: input.jobsQueueUrl(), AttributeNames: ["QueueArn"] }))]); return jsonResponse(200, { ok: true, status: "ok", dependencies: ["dynamodb", "s3", "sqs"] }); } catch (error) { return jsonResponse(503, { ok: false, status: "degraded", error: error instanceof Error ? error.message : "Dependency check failed" }); } };
};
export interface AwsRepositoryConfiguration { tableName: string; cellId: string; repositoryIndexName?: string; }
type Dynamo = Pick<DynamoDBDocumentClient, "send">;
const now = () => new Date().toISOString();
const pk = (repository: string, id: string) => `${repository}#${id}`;
/** AWS's standard document client rejects undefined attributes; absence is the portable representation. */
const withoutUndefined = <T>(value: T): T => {
  if (Array.isArray(value)) return value.map(withoutUndefined) as T;
  if (value && typeof value === "object" && !(value instanceof Uint8Array) && !(value instanceof Date)) return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).map(([key, item]) => [key, withoutUndefined(item)])) as T;
  return value;
};

export class DynamoRevisionedRepository<T extends RevisionedRecord> implements RevisionedRepository<T> {
  constructor(private readonly dynamo: Dynamo, private readonly configuration: AwsRepositoryConfiguration, private readonly repository: string) {}
  async create(record: Omit<T, "revision" | "createdAt" | "updatedAt">, options?: { idempotencyKey?: string }): Promise<T> { const timestamp = now(); const value = { ...record, revision: 1, createdAt: timestamp, updatedAt: timestamp } as T; try { await this.dynamo.send(new PutCommand({ TableName: this.configuration.tableName, Item: { pk: pk(this.repository, value.id), sk: "record", repository: this.repository, id: value.id, revision: value.revision, value: withoutUndefined(value) }, ConditionExpression: "attribute_not_exists(pk)" })); return value; } catch (error) { const existing = options?.idempotencyKey ? await this.get(value.id) : undefined; if (existing) return existing; throw error; } }
  async get(id: string): Promise<T | undefined> { const response = await this.dynamo.send(new GetCommand({ TableName: this.configuration.tableName, Key: { pk: pk(this.repository, id), sk: "record" } })); return response.Item?.value as T | undefined; }
  /** Records are queried through the explicit repository/id index, never a filtered scan. */
  async list(request: PageRequest): Promise<Page<T>> { const response = await this.dynamo.send(new QueryCommand({ TableName: this.configuration.tableName, IndexName: this.configuration.repositoryIndexName ?? "repository-id-index", KeyConditionExpression: "#repository = :repository", ExpressionAttributeNames: { "#repository": "repository" }, ExpressionAttributeValues: { ":repository": this.repository }, Limit: request.limit, ExclusiveStartKey: request.cursor ? JSON.parse(Buffer.from(request.cursor, "base64url").toString("utf8")) : undefined })); return { items: (response.Items ?? []).map((item) => item.value as T), nextCursor: response.LastEvaluatedKey ? Buffer.from(JSON.stringify(response.LastEvaluatedKey)).toString("base64url") : undefined }; }
  async update(id: string, expectedRevision: number, change: Partial<Omit<T, "id" | "revision" | "createdAt" | "updatedAt">>): Promise<T> { const current = await this.get(id); if (!current) throw new OptimisticConcurrencyError(id, expectedRevision); const value = { ...current, ...change, revision: expectedRevision + 1, updatedAt: now() } as T; try { await this.dynamo.send(new PutCommand({ TableName: this.configuration.tableName, Item: { pk: pk(this.repository, id), sk: "record", repository: this.repository, id, revision: value.revision, value: withoutUndefined(value) }, ConditionExpression: "attribute_exists(pk) AND #revision = :revision", ExpressionAttributeNames: { "#revision": "revision" }, ExpressionAttributeValues: { ":revision": expectedRevision } })); return value; } catch (error) { if ((error as { name?: string }).name === "ConditionalCheckFailedException") throw new OptimisticConcurrencyError(id, expectedRevision); throw error; } }
  async remove(id: string, expectedRevision: number): Promise<void> { try { await this.dynamo.send(new DeleteCommand({ TableName: this.configuration.tableName, Key: { pk: pk(this.repository, id), sk: "record" }, ConditionExpression: "#revision = :revision", ExpressionAttributeNames: { "#revision": "revision" }, ExpressionAttributeValues: { ":revision": expectedRevision } })); } catch (error) { if ((error as { name?: string }).name === "ConditionalCheckFailedException") throw new OptimisticConcurrencyError(id, expectedRevision); throw error; } }
}

const repository = <T extends RevisionedRecord>(dynamo: Dynamo, config: AwsRepositoryConfiguration, name: string) => new DynamoRevisionedRepository<T>(dynamo, config, name);
const cellRepository = <T extends RevisionedRecord & CellOwnedRecord>(dynamo: Dynamo, config: AwsRepositoryConfiguration, name: string): RevisionedRepository<T> => new CellScopedRepository(repository<T>(dynamo, config, name), config.cellId);
export const createDynamoRepositories = (dynamo: Dynamo, config: AwsRepositoryConfiguration): UbeeqRepositories => ({ transaction: async (work) => work({ id: randomUUID() }), creators: cellRepository(dynamo, config, "creators"), works: cellRepository(dynamo, config, "works"), assets: cellRepository(dynamo, config, "assets"), collections: cellRepository(dynamo, config, "collections"), workMemberships: cellRepository(dynamo, config, "workMemberships"), publicationIntents: cellRepository(dynamo, config, "publicationIntents"), publications: cellRepository(dynamo, config, "publications"), reconciliationSnapshots: cellRepository(dynamo, config, "reconciliationSnapshots"), moderationEvidence: cellRepository(dynamo, config, "moderationEvidence"), moderationHolds: cellRepository(dynamo, config, "moderationHolds"), reviewCases: cellRepository(dynamo, config, "reviewCases"), auditEvents: cellRepository(dynamo, config, "auditEvents"), usageEvents: cellRepository(dynamo, config, "usageEvents"), creditLots: cellRepository(dynamo, config, "creditLots"), creditReservations: cellRepository(dynamo, config, "creditReservations"), balances: cellRepository(dynamo, config, "balances"), integrationAccounts: cellRepository(dynamo, config, "integrationAccounts"), syncCursors: cellRepository(dynamo, config, "syncCursors"), integrationJobs: cellRepository(dynamo, config, "integrationJobs"), exportManifests: cellRepository(dynamo, config, "exportManifests"), importCheckpoints: cellRepository(dynamo, config, "importCheckpoints"), federationActors: repository(dynamo, config, "federationActors"), remotePublicationReferences: repository(dynamo, config, "remotePublicationReferences") });

export class S3ObjectStorage implements ObjectStorage {
  constructor(private readonly s3: Pick<S3Client, "send">, private readonly bucket: string) {}
  async put(input: { object: StoredObject; body: Uint8Array }): Promise<void> { await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: input.object.key, Body: input.body, ContentType: input.object.contentType, Metadata: { scope: input.object.scope, ...(input.object.checksum ? { checksum: input.object.checksum } : {}), byteLength: String(input.object.byteLength) } })); }
  async get(input: Pick<StoredObject, "bucket" | "key" | "versionId">): Promise<{ object: StoredObject; body: Uint8Array }> { const response = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: input.key, VersionId: input.versionId })); const body = new Uint8Array(await response.Body!.transformToByteArray()); return { object: { bucket: this.bucket, key: input.key, versionId: response.VersionId, contentType: response.ContentType ?? "application/octet-stream", byteLength: body.byteLength, checksum: response.Metadata?.checksum, scope: (response.Metadata?.scope as StoredObject["scope"]) ?? "private" }, body }; }
  async remove(input: Pick<StoredObject, "bucket" | "key" | "versionId">): Promise<void> { await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: input.key, VersionId: input.versionId })); }
}

const checksumBase64 = (checksum: string): string => /^[a-f0-9]{64}$/i.test(checksum) ? Buffer.from(checksum, "hex").toString("base64") : checksum;
const directUploadId = (object: StoredObject): string => Buffer.from(JSON.stringify(object)).toString("base64url");
const objectForDirectUpload = (uploadId: string): StoredObject => {
  try { const value = JSON.parse(Buffer.from(uploadId, "base64url").toString("utf8")) as StoredObject; if (!value.bucket || !value.key || !value.contentType) throw new Error(); return value; }
  catch { throw new Error("AWS direct upload identifier is invalid."); }
};

/** S3 direct uploads bind the SHA-256 checksum to the presigned write and verify the immutable version at completion. */
export class S3DirectUploadAdapter implements UploadAdapter {
  constructor(private readonly s3: S3Client, private readonly bucket: string) {}
  async initiate(input: { object: StoredObject; checksumAlgorithm: "sha256"; multipart?: boolean; expiresAt: string }): Promise<UploadInitiation> {
    if (input.multipart) throw new Error("Multipart uploads require a dedicated multipart adapter.");
    if (Date.parse(input.expiresAt) <= Date.now()) throw new Error("AWS direct upload expiry must be in the future.");
    const requestedChecksum = input.object.checksum;
    if (!requestedChecksum) throw new Error("AWS direct uploads require a SHA-256 checksum before initiation.");
    const object = { ...input.object, checksum: requestedChecksum, bucket: this.bucket, scope: input.object.scope };
    const expiresIn = Math.max(1, Math.min(900, Math.floor((Date.parse(input.expiresAt) - Date.now()) / 1_000)));
    const checksum = checksumBase64(object.checksum);
    const url = await getSignedUrl(this.s3, new PutObjectCommand({ Bucket: this.bucket, Key: object.key, ContentType: object.contentType, ChecksumSHA256: checksum, Metadata: { checksum: object.checksum, scope: object.scope, byteLength: String(object.byteLength) } }), { expiresIn });
    return { uploadId: directUploadId(object), object, parts: [{ partNumber: 1, url, expiresAt: input.expiresAt }], completeUrl: undefined, expiresAt: input.expiresAt };
  }
  async complete(input: UploadCompletion): Promise<StoredObject> {
    const requested = objectForDirectUpload(input.uploadId);
    requireCreatorScopedObject(requested.key, input);
    const response = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: requested.key }));
    if (!response.VersionId || response.ContentLength !== input.byteLength || response.Metadata?.checksum !== input.checksum || (response.ChecksumSHA256 && response.ChecksumSHA256 !== checksumBase64(input.checksum))) throw new Error("AWS upload completion did not match the signed object checksum, size, or version.");
    return { ...requested, versionId: response.VersionId, contentType: response.ContentType ?? requested.contentType, byteLength: response.ContentLength, checksum: input.checksum, scope: (response.Metadata?.scope as StoredObject["scope"]) ?? requested.scope };
  }
}
export const issueS3Download = async (s3: S3Client, bucket: string, object: Pick<StoredObject, "key" | "versionId">, expiresInSeconds = 300) => getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: object.key, VersionId: object.versionId }), { expiresIn: expiresInSeconds });
export class S3PresignedDelivery implements DeliveryAdapter {
  constructor(private readonly s3: S3Client, private readonly bucket: string) {}
  async issue(request: Parameters<DeliveryAdapter["issue"]>[0]): Promise<{ url: string; expiresAt: string }> {
    const expiresInSeconds = Math.max(1, Math.min(7 * 24 * 60 * 60, Math.floor((Date.parse(request.expiresAt) - Date.now()) / 1_000)));
    return { url: await issueS3Download(this.s3, this.bucket, request.object, expiresInSeconds), expiresAt: request.expiresAt };
  }
}

/**
 * SQS is used as a wake-up signal while the DynamoDB record is the durable source of
 * truth. Workers lease atomically from DynamoDB, so duplicate SQS delivery and lost
 * notifications are harmless: a periodic recovery worker can always re-offer queued work.
 */
interface AwsJobRecord extends DurableJob, RevisionedRecord {}
export class AwsJobQueue implements JobQueue {
  private readonly jobs: DynamoRevisionedRepository<AwsJobRecord>;
  constructor(dynamo: Dynamo, configuration: AwsRepositoryConfiguration, private readonly sqs: Pick<SQSClient, "send">, private readonly queueUrl: string, private readonly eventBridge?: { client: Pick<EventBridgeClient, "send">; eventBusName: string }) {
    this.jobs = new DynamoRevisionedRepository<AwsJobRecord>(dynamo, configuration, "durableJobs");
  }
  async enqueue<TPayload>(input: Omit<DurableJob<TPayload>, "id" | "state" | "attempt" | "availableAt" | "createdAt" | "updatedAt"> & { availableAt?: string }): Promise<DurableJob<TPayload>> {
    const id = `job-${createHash("sha256").update(`${input.cellId}:${input.idempotencyKey}`).digest("hex").slice(0, 32)}`;
    const existing = await this.jobs.get(id) as DurableJob<TPayload> | undefined;
    if (existing) return existing;
    const created = await this.jobs.create({ id, ...input, state: "queued", attempt: 0, availableAt: input.availableAt ?? now() } as Omit<AwsJobRecord, "revision" | "createdAt" | "updatedAt">, { idempotencyKey: input.idempotencyKey }) as DurableJob<TPayload>;
    await this.notify(created.id, created.type, created.cellId);
    return created;
  }
  async lease<TPayload>(input: { cellId: string; types?: readonly string[]; leaseDurationSeconds: number; workerId: string }): Promise<JobLease<TPayload> | undefined> {
    const candidates = await this.jobs.list({ limit: 100 });
    const timestamp = Date.now();
    const candidate = candidates.items.find((job) => job.cellId === input.cellId && (job.state === "queued" || job.state === "retry_scheduled") && Date.parse(job.availableAt) <= timestamp && (!input.types || input.types.includes(job.type)));
    if (!candidate) return undefined;
    const leaseToken = randomUUID();
    try {
      const leased = await this.jobs.update(candidate.id, candidate.revision, { state: "leased", leaseExpiresAt: new Date(timestamp + input.leaseDurationSeconds * 1_000).toISOString(), correlationId: `${input.workerId}:${leaseToken}` });
      return { job: leased as DurableJob<TPayload>, leaseToken };
    } catch { return undefined; }
  }
  async complete(input: { id: string; leaseToken: string }): Promise<void> { await this.transition(input.id, input.leaseToken, { state: "completed", leaseExpiresAt: undefined }); }
  async retry(input: { id: string; leaseToken: string; error: { code: string; message: string }; retryAt: string }): Promise<void> { const job = await this.requiredLease(input.id, input.leaseToken); const nextAttempt = job.attempt + 1; await this.jobs.update(job.id, job.revision, nextAttempt >= job.maxAttempts ? { state: "dead_lettered", attempt: nextAttempt, lastError: input.error, leaseExpiresAt: undefined } : { state: "retry_scheduled", attempt: nextAttempt, lastError: input.error, availableAt: input.retryAt, leaseExpiresAt: undefined }); if (nextAttempt < job.maxAttempts) await this.notify(job.id, job.type, job.cellId); }
  async deadLetter(input: { id: string; leaseToken: string; error: { code: string; message: string } }): Promise<void> { await this.transition(input.id, input.leaseToken, { state: "dead_lettered", lastError: input.error, leaseExpiresAt: undefined }); }
  async cancel(input: { id: string; reason?: string }): Promise<void> { const job = await this.required(input.id); await this.jobs.update(job.id, job.revision, { state: "cancelled", lastError: input.reason ? { code: "cancelled", message: input.reason } : undefined, leaseExpiresAt: undefined }); }
  async recover(input: { id: string; availableAt?: string }): Promise<DurableJob> { const job = await this.required(input.id); const recovered = await this.jobs.update(job.id, job.revision, { state: "queued", availableAt: input.availableAt ?? now(), leaseExpiresAt: undefined }); await this.notify(recovered.id, recovered.type, recovered.cellId); return recovered; }
  async get(id: string): Promise<DurableJob | undefined> { return this.jobs.get(id); }
  async list(input: { cellId: string; states?: readonly JobState[]; limit: number }): Promise<readonly DurableJob[]> { const page = await this.jobs.list({ limit: Math.max(input.limit * 4, input.limit) }); return page.items.filter((job) => job.cellId === input.cellId && (!input.states || input.states.includes(job.state))).slice(0, input.limit); }
  private async required(id: string): Promise<AwsJobRecord> { const job = await this.jobs.get(id); if (!job) throw new Error(`Job ${id} was not found.`); return job; }
  private async requiredLease(id: string, leaseToken: string): Promise<AwsJobRecord> { const job = await this.required(id); if (job.state !== "leased" || job.correlationId?.split(":").at(-1) !== leaseToken) throw new Error(`Job ${id} does not hold this lease.`); return job; }
  private async transition(id: string, leaseToken: string, change: Partial<AwsJobRecord>): Promise<void> { const job = await this.requiredLease(id, leaseToken); await this.jobs.update(job.id, job.revision, change); }
  private async notify(id: string, type: string, cellId: string): Promise<void> {
    const detail = JSON.stringify({ id, type, cellId });
    await this.sqs.send(new SendMessageCommand({ QueueUrl: this.queueUrl, MessageBody: detail }));
    if (this.eventBridge) await this.eventBridge.client.send(new PutEventsCommand({ Entries: [{ EventBusName: this.eventBridge.eventBusName, Source: "ubeeq.jobs", DetailType: "job.available", Detail: detail }] }));
  }
}

export class SecretsManagerCredentialVault implements CredentialVault {
  constructor(private readonly secrets: Pick<SecretsManagerClient, "send">, private readonly prefix: string) {}
  private id(input: { cellId: string; reference: string }): string | undefined { const prefix = `aws-secrets:${this.prefix}/${input.cellId}/`; return input.reference.startsWith(prefix) ? input.reference.slice("aws-secrets:".length) : undefined; }
  async write(input: { cellId: string; ownerId: string; value: Uint8Array; expiresAt?: string }): Promise<{ reference: string }> { const id = `${this.prefix}/${input.cellId}/${input.ownerId}/${randomUUID()}`; await this.secrets.send(new CreateSecretCommand({ Name: id, SecretBinary: input.value, Tags: [{ Key: "ubeeq:cell-id", Value: input.cellId }, { Key: "ubeeq:credential-owner", Value: input.ownerId }, ...(input.expiresAt ? [{ Key: "ubeeq:credential-expires-at", Value: input.expiresAt }] : [])] })); return { reference: `aws-secrets:${id}` }; }
  async read(input: { cellId: string; reference: string }): Promise<Uint8Array | undefined> { const id = this.id(input); if (!id) return undefined; try { const result = await this.secrets.send(new GetSecretValueCommand({ SecretId: id })); return result.SecretBinary ? new Uint8Array(result.SecretBinary) : result.SecretString ? new TextEncoder().encode(result.SecretString) : undefined; } catch { return undefined; } }
  async revoke(input: { cellId: string; reference: string }): Promise<void> { const id = this.id(input); if (id) await this.secrets.send(new UpdateSecretCommand({ SecretId: id, SecretString: "revoked" })); }
}

export class CognitoIdentity implements IdentityAdapter {
  constructor(private readonly cognito: Pick<CognitoIdentityProviderClient, "send">, private readonly userPoolId: string, private readonly clientId: string) {}
  /** Cognito GlobalSignOut requires the original access token; callers must keep this session id internal and never serialize it into audit/export data. */
  async verifySession(input: { credential: string }): Promise<AuthenticatedSession | undefined> { try { const user = await this.cognito.send(new GetUserCommand({ AccessToken: input.credential })); const id = user.Username; if (!id) return undefined; return { id: input.credential, subject: { id, roles: [], scopes: user.UserAttributes?.filter((item) => item.Name === "scope").flatMap((item) => item.Value?.split(" ") ?? []) }, issuedAt: "", expiresAt: "", authenticationMethod: "oidc" }; } catch { return undefined; } }
  async getAccount(subjectId: string): Promise<IdentityAccount | undefined> { return { id: subjectId, subjectId, status: "active", createdAt: "", updatedAt: "" }; }
  async listDelegations(): Promise<readonly []> { return []; }
  async revokeSession(input: { sessionId: string }): Promise<void> { await this.cognito.send(new GlobalSignOutCommand({ AccessToken: input.sessionId })); }
  async authenticate(input: { username: string; password: string }): Promise<{ token: string }> { const result = await this.cognito.send(new InitiateAuthCommand({ AuthFlow: "USER_PASSWORD_AUTH", ClientId: this.clientId, AuthParameters: { USERNAME: input.username, PASSWORD: input.password } })); if (!result.AuthenticationResult?.AccessToken) throw new Error("Cognito authentication did not return an access token."); return { token: result.AuthenticationResult.AccessToken }; }
}

export const issueCloudFrontDelivery = (input: { url: string; privateKey: string; keyPairId: string; expiresAt: string }): string => getCloudFrontSignedUrl({ url: input.url, privateKey: input.privateKey, keyPairId: input.keyPairId, dateLessThan: input.expiresAt });
export class CloudFrontDelivery implements DeliveryAdapter {
  constructor(private readonly configuration: { origin: string; privateKey: string; keyPairId: string }) {}
  async issue(request: Parameters<DeliveryAdapter["issue"]>[0]): Promise<{ url: string; expiresAt: string }> {
    const origin = this.configuration.origin.replace(/\/$/, ""); const key = request.object.key.split("/").map(encodeURIComponent).join("/");
    return { url: issueCloudFrontDelivery({ url: `${origin}/${key}`, privateKey: this.configuration.privateKey, keyPairId: this.configuration.keyPairId, expiresAt: request.expiresAt }), expiresAt: request.expiresAt };
  }
}

/** Explicit AWS composition; core/application code receives only provider-neutral ports. */
export interface AwsAdapterConfiguration extends AwsRepositoryConfiguration { region?: string; objectBucket: string; queueUrl: string; userPoolId: string; userPoolClientId: string; credentialSecretPrefix: string; eventBusName?: string; cloudFront?: { origin: string; privateKey: string; keyPairId: string }; }
export const createAwsAdapterSet = (configuration: AwsAdapterConfiguration) => {
  const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: configuration.region }));
  const s3 = new S3Client({ region: configuration.region }); const sqs = new SQSClient({ region: configuration.region }); const events = new EventBridgeClient({ region: configuration.region });
  const storage = new S3ObjectStorage(s3, configuration.objectBucket);
  return {
    repositories: createDynamoRepositories(dynamo, configuration), storage, uploads: new S3DirectUploadAdapter(s3, configuration.objectBucket),
    delivery: configuration.cloudFront ? new CloudFrontDelivery(configuration.cloudFront) : new S3PresignedDelivery(s3, configuration.objectBucket),
    jobs: new AwsJobQueue(dynamo, configuration, sqs, configuration.queueUrl, configuration.eventBusName ? { client: events, eventBusName: configuration.eventBusName } : undefined),
    identity: new CognitoIdentity(new CognitoIdentityProviderClient({ region: configuration.region }), configuration.userPoolId, configuration.userPoolClientId),
    credentials: new SecretsManagerCredentialVault(new SecretsManagerClient({ region: configuration.region }), configuration.credentialSecretPrefix)
  };
};
