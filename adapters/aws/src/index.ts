import { CognitoJwtVerifier } from 'aws-jwt-verify';
export type { AwsCommandClient } from './client-port.js';
import type { AwsCommandClient } from './client-port.js';
/** Optional AWS adapter composition. AWS SDK imports are intentionally isolated to this package. */
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand, DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DescribeTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetQueueAttributesCommand, SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { CreateSecretCommand, GetSecretValueCommand, UpdateSecretCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { AdminGetUserCommand, GetUserCommand, GlobalSignOutCommand, InitiateAuthCommand, CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { getSignedUrl as getCloudFrontSignedUrl } from "@aws-sdk/cloudfront-signer";
import { createHash, randomUUID } from "node:crypto";
import { CellScopedRepository, OptimisticConcurrencyError, repositoryItems, type CellOwnedRecord, type Page, type PageRequest, type RevisionedRecord, type RevisionedRepository, type UbeeqRepositories } from "@ubeeq/persistence";
import type { PublicationCommandRepositories } from '@ubeeq/persistence';
import { assertManagedPublicationWrite, assertPublicationDeliveryWrite } from '@ubeeq/persistence';
import { requireCellScopedObject, requireCreatorScopedObject, type DeliveryAdapter, type ObjectStorage, type StoredObject, type UploadAdapter, type UploadCompletion, type UploadInitiation } from "@ubeeq/storage";
import { PasswordAuthenticationError, type AuthenticatedSession, type IdentityAccount, type IdentityAdapter } from "@ubeeq/auth";
import type { CredentialVault } from "@ubeeq/integrations";
import type { DurableJob, JobLease, JobQueue, JobState } from "@ubeeq/jobs";
import { requireRecoverableJob } from "@ubeeq/jobs";
import { MigrationOrchestrator, RemoteMigrationExecutor, RoutingDirectoryConflictError, validateCellRoute, validateMigrationCellRegistration, validateMigrationCheckpoint, type CellRoute, type MigrationCellCommand, type MigrationCellCommandResult, type MigrationCellEndpoint, type MigrationCellRegistration, type MigrationCellRegistry, type MigrationCheckpoint, type MigrationCheckpointStore, type MigrationObjectInventoryEntry, type MigrationObjectTransfer, type RoutingDirectory } from "@ubeeq/deployment-platform";

export const AWS_ADAPTERS_API_VERSION = "1" as const;
import { createTransactionalDynamo } from './transactions.js';
export type AwsFunctionUrlEvent = { rawPath?: string; requestContext?: { http?: { method?: string } } };
export type AwsFunctionUrlResult = { statusCode: number; headers: Record<string, string>; body: string };
export const createAwsReferenceHealthHandler = (input: { region?: string; recordsTable(): string; sourceBucket(): string; jobsQueueUrl(): string }) => {
  const dynamo = new DynamoDBClient({ region: input.region }), s3 = new S3Client({ region: input.region }), sqs = new SQSClient({ region: input.region }); const jsonResponse = (statusCode: number, body: unknown): AwsFunctionUrlResult => ({ statusCode, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }, body: JSON.stringify(body) });
  return async (event: AwsFunctionUrlEvent): Promise<AwsFunctionUrlResult> => { const path = event.rawPath ?? "/"; if (path === "/health") return jsonResponse(200, { ok: true, service: "ubeeq-reference-api", runtime: "aws-lambda" }); if (path !== "/ready") return jsonResponse(404, { error: { code: "not_found", message: "Route was not found" } }); try { await Promise.all([dynamo.send(new DescribeTableCommand({ TableName: input.recordsTable() })), s3.send(new HeadBucketCommand({ Bucket: input.sourceBucket() })), sqs.send(new GetQueueAttributesCommand({ QueueUrl: input.jobsQueueUrl(), AttributeNames: ["QueueArn"] }))]); return jsonResponse(200, { ok: true, status: "ok", dependencies: ["dynamodb", "s3", "sqs"] }); } catch (error) { return jsonResponse(503, { ok: false, status: "degraded", error: error instanceof Error ? error.message : "Dependency check failed" }); } };
};
export interface AwsRepositoryConfiguration { tableName: string; cellId: string; repositoryIndexName?: string; }
type Dynamo = AwsCommandClient & { assertTransaction?: (transaction: { id: string }) => void; failTransaction?: () => void;
  checkRevision?: (table: string, key: Record<string, string>, expectedRevision: number) => void };
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
  private guard(previous: T | undefined, next: T) {
    try {
      if (this.repository === 'publications') assertManagedPublicationWrite(previous as unknown as import('@ubeeq/persistence').ManagedPublicationRecord, next as unknown as import('@ubeeq/persistence').ManagedPublicationRecord);
      if (this.repository === 'publicationOperations') assertPublicationDeliveryWrite(previous as unknown as import('@ubeeq/persistence').PublicationDeliveryRecord, next as unknown as import('@ubeeq/persistence').PublicationDeliveryRecord);
    } catch (error) { this.dynamo.failTransaction?.(); throw error; }
  }
  private assertTransaction(options?: { transaction?: { id: string } }): void {
    if (!options?.transaction) return;
    if (!this.dynamo.assertTransaction) throw new Error('This repository has no transaction coordinator.');
    this.dynamo.assertTransaction(options.transaction);
  }
  async checkRevision(id: string, expectedRevision: number, options: { transaction: { id: string } }): Promise<void> {
    this.assertTransaction(options);
    if (!this.dynamo.checkRevision) throw new Error('Repository does not support commit-time revision guards.');
    this.dynamo.checkRevision(this.configuration.tableName, { pk: pk(this.repository, id), sk: 'record' }, expectedRevision);
  }
  async create(record: Omit<T, 'revision' | 'createdAt' | 'updatedAt'>, options?: { idempotencyKey?: string; transaction?: { id: string } }): Promise<T> {
    this.assertTransaction(options);
    const timestamp = now(), value = { ...record, revision: 1, createdAt: timestamp, updatedAt: timestamp } as T;
    this.guard(undefined, value);
    try {
      await this.dynamo.send(new PutCommand({ TableName: this.configuration.tableName,
        Item: { pk: pk(this.repository, value.id), sk: 'record', repository: this.repository, id: value.id, revision: value.revision, value: withoutUndefined(value) },
        ConditionExpression: 'attribute_not_exists(pk)' }));
      return value;
    } catch (error) {
      const existing = options?.idempotencyKey && (error as { name?: string }).name === 'ConditionalCheckFailedException' ? await this.get(value.id) : undefined;
      if (existing) return existing;
      throw error;
    }
  }
  async get(id: string, options?: { transaction?: { id: string } }): Promise<T | undefined> { this.assertTransaction(options); const response = await this.dynamo.send(new GetCommand({ TableName: this.configuration.tableName, Key: { pk: pk(this.repository, id), sk: "record" }, ConsistentRead: true })); return response.Item?.value as T | undefined; }
  /** Records are queried through the explicit repository/id index, never a filtered scan. */
  async list(request: PageRequest, options?: { transaction?: { id: string } }): Promise<Page<T>> { this.assertTransaction(options); const response = await this.dynamo.send(new QueryCommand({ TableName: this.configuration.tableName, IndexName: this.configuration.repositoryIndexName ?? "repository-id-index", KeyConditionExpression: "#repository = :repository", ExpressionAttributeNames: { "#repository": "repository" }, ExpressionAttributeValues: { ":repository": this.repository }, Limit: request.limit, ExclusiveStartKey: request.cursor ? JSON.parse(Buffer.from(request.cursor, "base64url").toString("utf8")) : undefined })); return { items: ((response.Items ?? []) as Record<string, unknown>[]).map((item) => item.value as T), nextCursor: response.LastEvaluatedKey ? Buffer.from(JSON.stringify(response.LastEvaluatedKey)).toString("base64url") : undefined }; }
  async update(id: string, expectedRevision: number, change: Partial<Omit<T, 'id' | 'revision' | 'createdAt' | 'updatedAt'>>, options?: { transaction?: { id: string } }): Promise<T> {
    this.assertTransaction(options);
    const current = await this.get(id);
    if (!current || current.revision !== expectedRevision) { this.dynamo.failTransaction?.(); throw new OptimisticConcurrencyError(id, expectedRevision); }
    const value = { ...current, ...change, revision: expectedRevision + 1, updatedAt: now() } as T;
    this.guard(current, value);
    try {
      await this.dynamo.send(new PutCommand({ TableName: this.configuration.tableName,
        Item: { pk: pk(this.repository, id), sk: 'record', repository: this.repository, id, revision: value.revision, value: withoutUndefined(value) },
        ConditionExpression: 'attribute_exists(pk) AND #revision = :revision', ExpressionAttributeNames: { '#revision': 'revision' }, ExpressionAttributeValues: { ':revision': expectedRevision } }));
      return value;
    } catch (error) {
      if ((error as { name?: string }).name === 'ConditionalCheckFailedException') throw new OptimisticConcurrencyError(id, expectedRevision);
      throw error;
    }
  }
  async remove(id: string, expectedRevision: number, options?: { transaction?: { id: string } }): Promise<void> { this.assertTransaction(options); try { await this.dynamo.send(new DeleteCommand({ TableName: this.configuration.tableName, Key: { pk: pk(this.repository, id), sk: "record" }, ConditionExpression: "#revision = :revision", ExpressionAttributeNames: { "#revision": "revision" }, ExpressionAttributeValues: { ":revision": expectedRevision } })); } catch (error) { if ((error as { name?: string }).name === "ConditionalCheckFailedException") throw new OptimisticConcurrencyError(id, expectedRevision); throw error; } }
}

const repository = <T extends RevisionedRecord>(dynamo: Dynamo, config: AwsRepositoryConfiguration, name: string) => new DynamoRevisionedRepository<T>(dynamo, config, name);
const cellRepository = <T extends RevisionedRecord & CellOwnedRecord>(dynamo: Dynamo, config: AwsRepositoryConfiguration, name: string): RevisionedRepository<T> => new CellScopedRepository(repository<T>(dynamo, config, name), config.cellId);
export const createDynamoPublicationCommandRepositories = (base: Dynamo, config: AwsRepositoryConfiguration): PublicationCommandRepositories & UbeeqRepositories => {
  const { client: dynamo, transaction } = createTransactionalDynamo(base);
  return { ...dynamoRepositories(dynamo, transaction, config), publications: cellRepository(dynamo, config, 'publications'),
    claims: cellRepository(dynamo, config, 'publicationClaims'), operations: cellRepository(dynamo, config, 'publicationOperations'),
    outbox: cellRepository(dynamo, config, 'publicationOutbox'), auditEvents: cellRepository(dynamo, config, 'auditEvents') };
};
const dynamoRepositories = (dynamo: Dynamo, transaction: UbeeqRepositories['transaction'], config: AwsRepositoryConfiguration): UbeeqRepositories => ({ transaction,
  hostRecords: cellRepository(dynamo, config, 'hostRecords'),
  creators: cellRepository(dynamo, config, 'creators'), works: cellRepository(dynamo, config, 'works'), assets: cellRepository(dynamo, config, 'assets'),
  collections: cellRepository(dynamo, config, 'collections'), workMemberships: cellRepository(dynamo, config, 'workMemberships'),
  publicationIntents: cellRepository(dynamo, config, 'publicationIntents'), publications: cellRepository(dynamo, config, 'publications'),
  reconciliationSnapshots: cellRepository(dynamo, config, 'reconciliationSnapshots'), moderationEvidence: cellRepository(dynamo, config, 'moderationEvidence'),
  moderationHolds: cellRepository(dynamo, config, 'moderationHolds'), reviewCases: cellRepository(dynamo, config, 'reviewCases'),
  auditEvents: cellRepository(dynamo, config, 'auditEvents'), usageEvents: cellRepository(dynamo, config, 'usageEvents'),
  creditLots: cellRepository(dynamo, config, 'creditLots'), creditReservations: cellRepository(dynamo, config, 'creditReservations'), balances: cellRepository(dynamo, config, 'balances'),
  integrationAccounts: cellRepository(dynamo, config, 'integrationAccounts'), syncCursors: cellRepository(dynamo, config, 'syncCursors'),
  integrationJobs: cellRepository(dynamo, config, 'integrationJobs'), exportManifests: cellRepository(dynamo, config, 'exportManifests'),
  importCheckpoints: cellRepository(dynamo, config, 'importCheckpoints'), instanceOperators: repository(dynamo, config, 'instanceOperators'), federationActors: repository(dynamo, config, 'federationActors'),
  remotePublicationReferences: repository(dynamo, config, 'remotePublicationReferences')
});
export const createDynamoRepositories = (base: Dynamo, config: AwsRepositoryConfiguration): UbeeqRepositories => {
  const { client, transaction } = createTransactionalDynamo(base);
  return dynamoRepositories(client, transaction, config);
};

/**
 * Optional managed-edge control plane.  Its table is deliberately distinct
 * from every regional records table, and contains routing/checkpoint metadata
 * only.  It is safe to place this table in one declared operator control
 * region; it does not make creator data globally mutable.
 */
class DynamoControlPlane {
  constructor(readonly dynamo: Dynamo, readonly tableName: string) {}
  conflict(error: unknown, message: string): Error { if ((error as { name?: string }).name === "ConditionalCheckFailedException") return new RoutingDirectoryConflictError(message); return error instanceof Error ? error : new Error(message); }
}

export class DynamoRoutingDirectory implements RoutingDirectory {
  private readonly control: DynamoControlPlane;
  constructor(dynamo: Dynamo, tableName: string) { this.control = new DynamoControlPlane(dynamo, tableName); }
  async get(creatorId: string): Promise<CellRoute | undefined> {
    const response = await this.control.dynamo.send(new GetCommand({ TableName: this.control.tableName, Key: { pk: "route", sk: creatorId } }));
    return response.Item?.route ? validateCellRoute(response.Item.route as CellRoute) : undefined;
  }
  async create(route: CellRoute): Promise<CellRoute> {
    validateCellRoute(route);
    try { await this.control.dynamo.send(new PutCommand({ TableName: this.control.tableName, Item: { pk: "route", sk: route.creatorId, route: withoutUndefined(route), routingRevision: route.routingRevision }, ConditionExpression: "attribute_not_exists(pk)" })); return route; }
    catch (error) { throw this.control.conflict(error, `A route already exists for creator ${route.creatorId}.`); }
  }
  async compareAndSwap(input: { route: CellRoute; expectedRoutingRevision: number }): Promise<CellRoute> {
    validateCellRoute(input.route);
    if (input.route.routingRevision !== input.expectedRoutingRevision + 1) throw new RoutingDirectoryConflictError("The replacement route must advance routingRevision by exactly one.");
    try { await this.control.dynamo.send(new PutCommand({ TableName: this.control.tableName, Item: { pk: "route", sk: input.route.creatorId, route: withoutUndefined(input.route), routingRevision: input.route.routingRevision }, ConditionExpression: "attribute_exists(pk) AND #routingRevision = :expected", ExpressionAttributeNames: { "#routingRevision": "routingRevision" }, ExpressionAttributeValues: { ":expected": input.expectedRoutingRevision } })); return input.route; }
    catch (error) { throw this.control.conflict(error, `Route revision ${input.expectedRoutingRevision} is no longer current for creator ${input.route.creatorId}.`); }
  }
  async list(input: { limit: number; cursor?: string }): Promise<{ items: readonly CellRoute[]; nextCursor?: string }> {
    const response = await this.control.dynamo.send(new QueryCommand({ TableName: this.control.tableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": "route" }, Limit: Math.max(1, Math.min(100, input.limit)), ExclusiveStartKey: input.cursor ? JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")) : undefined }));
    return { items: ((response.Items ?? []) as Record<string, unknown>[]).map((item) => validateCellRoute(item.route as CellRoute)), nextCursor: response.LastEvaluatedKey ? Buffer.from(JSON.stringify(response.LastEvaluatedKey)).toString("base64url") : undefined };
  }
}

export class DynamoMigrationCheckpoints implements MigrationCheckpointStore {
  private readonly control: DynamoControlPlane;
  constructor(dynamo: Dynamo, tableName: string) { this.control = new DynamoControlPlane(dynamo, tableName); }
  async get(id: string): Promise<MigrationCheckpoint | undefined> {
    const response = await this.control.dynamo.send(new GetCommand({ TableName: this.control.tableName, Key: { pk: "migration", sk: id } }));
    return response.Item?.checkpoint ? validateMigrationCheckpoint(response.Item.checkpoint as MigrationCheckpoint) : undefined;
  }
  async create(checkpoint: MigrationCheckpoint): Promise<MigrationCheckpoint> {
    validateMigrationCheckpoint(checkpoint);
    try { await this.control.dynamo.send(new PutCommand({ TableName: this.control.tableName, Item: { pk: "migration", sk: checkpoint.id, checkpoint: withoutUndefined(checkpoint), creatorId: checkpoint.creatorId, updatedAt: checkpoint.updatedAt }, ConditionExpression: "attribute_not_exists(pk)" })); return checkpoint; }
    catch (error) { throw this.control.conflict(error, `Migration checkpoint ${checkpoint.id} already exists.`); }
  }
  async compareAndSwap(input: { checkpoint: MigrationCheckpoint; expectedUpdatedAt: string }): Promise<MigrationCheckpoint> {
    validateMigrationCheckpoint(input.checkpoint);
    if (input.checkpoint.updatedAt === input.expectedUpdatedAt) throw new RoutingDirectoryConflictError("A migration update must advance updatedAt.");
    try { await this.control.dynamo.send(new PutCommand({ TableName: this.control.tableName, Item: { pk: "migration", sk: input.checkpoint.id, checkpoint: withoutUndefined(input.checkpoint), creatorId: input.checkpoint.creatorId, updatedAt: input.checkpoint.updatedAt }, ConditionExpression: "attribute_exists(pk) AND #updatedAt = :expected", ExpressionAttributeNames: { "#updatedAt": "updatedAt" }, ExpressionAttributeValues: { ":expected": input.expectedUpdatedAt } })); return input.checkpoint; }
    catch (error) { throw this.control.conflict(error, `Migration checkpoint ${input.checkpoint.id} has changed.`); }
  }
  async list(input: { creatorId?: string; limit: number; cursor?: string }): Promise<{ items: readonly MigrationCheckpoint[]; nextCursor?: string }> {
    // The partition remains intentionally small metadata. Querying the dedicated
    // control-plane table avoids scans across any regional creator records.
    const response = await this.control.dynamo.send(new QueryCommand({ TableName: this.control.tableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": "migration" }, Limit: Math.max(1, Math.min(100, input.limit)), ExclusiveStartKey: input.cursor ? JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")) : undefined }));
    const items = ((response.Items ?? []) as Record<string, unknown>[]).map((item) => validateMigrationCheckpoint(item.checkpoint as MigrationCheckpoint)).filter((checkpoint) => !input.creatorId || checkpoint.creatorId === input.creatorId);
    return { items, nextCursor: response.LastEvaluatedKey ? Buffer.from(JSON.stringify(response.LastEvaluatedKey)).toString("base64url") : undefined };
  }
}

/**
 * Private operator registry for explicitly admitted cell migration endpoints.
 * It lives beside (but is distinct from) route/checkpoint metadata and does
 * not add resource locations to the viewer-facing routing directory.
 */
export class DynamoMigrationCellRegistry implements MigrationCellRegistry {
  private readonly control: DynamoControlPlane;
  constructor(dynamo: Dynamo, tableName: string) { this.control = new DynamoControlPlane(dynamo, tableName); }
  async get(cellId: string): Promise<MigrationCellRegistration | undefined> {
    const response = await this.control.dynamo.send(new GetCommand({ TableName: this.control.tableName, Key: { pk: "cell", sk: cellId } }));
    return response.Item?.cell ? validateMigrationCellRegistration(response.Item.cell as MigrationCellRegistration) : undefined;
  }
  async register(cell: MigrationCellRegistration): Promise<MigrationCellRegistration> {
    validateMigrationCellRegistration(cell);
    const current = await this.get(cell.cellId);
    if (current && cell.updatedAt <= current.updatedAt) throw new RoutingDirectoryConflictError(`Migration cell registration ${cell.cellId} has changed.`);
    try {
      await this.control.dynamo.send(new PutCommand({ TableName: this.control.tableName, Item: { pk: "cell", sk: cell.cellId, cell: withoutUndefined(cell), updatedAt: cell.updatedAt }, ...(current ? { ConditionExpression: "attribute_exists(pk) AND #updatedAt = :expected", ExpressionAttributeNames: { "#updatedAt": "updatedAt" }, ExpressionAttributeValues: { ":expected": current.updatedAt } } : { ConditionExpression: "attribute_not_exists(pk)" }) }));
      return cell;
    } catch (error) { throw this.control.conflict(error, `Migration cell registration ${cell.cellId} has changed.`); }
  }
  async list(input: { limit: number; cursor?: string }): Promise<{ items: readonly MigrationCellRegistration[]; nextCursor?: string }> {
    const response = await this.control.dynamo.send(new QueryCommand({ TableName: this.control.tableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": "cell" }, Limit: Math.max(1, Math.min(100, input.limit)), ExclusiveStartKey: input.cursor ? JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")) : undefined }));
    return { items: ((response.Items ?? []) as Record<string, unknown>[]).map((item) => validateMigrationCellRegistration(item.cell as MigrationCellRegistration)), nextCursor: response.LastEvaluatedKey ? Buffer.from(JSON.stringify(response.LastEvaluatedKey)).toString("base64url") : undefined };
  }
}

export const createDynamoRoutingControlPlane = (dynamo: Dynamo, tableName: string) => {
  return { routingDirectory: new DynamoRoutingDirectory(dynamo, tableName), migrationCheckpoints: new DynamoMigrationCheckpoints(dynamo, tableName), migrationCells: new DynamoMigrationCellRegistry(dynamo, tableName) };
};

/** Creates only managed-edge ports; it never shares a cell's DynamoDB client/table. */
export const createAwsRoutingControlPlane = (configuration: { tableName: string; region?: string }) =>
  createDynamoRoutingControlPlane(DynamoDBDocumentClient.from(new DynamoDBClient({ region: configuration.region })), configuration.tableName);

/** Private synchronous invocation client for a cell registered by an operator. */
export class LambdaMigrationCellEndpoint implements MigrationCellEndpoint {
  constructor(private readonly lambda: AwsCommandClient, private readonly functionName: string) {}
  async execute(command: MigrationCellCommand): Promise<MigrationCellCommandResult> {
    const response = await this.lambda.send(new InvokeCommand({ FunctionName: this.functionName, InvocationType: "RequestResponse", Payload: Buffer.from(JSON.stringify(command)) }));
    const payload = response.Payload ? JSON.parse(Buffer.from(response.Payload).toString("utf8")) as { error?: { message?: string }; result?: MigrationCellCommandResult } : {};
    if (response.FunctionError || payload.error) throw new Error(payload.error?.message ?? `Migration cell ${this.functionName} rejected ${command.operation}.`);
    return payload.result ?? {};
  }
}

export type AwsMigrationOperation = "resume" | "rollback" | "retire";
/** Message body for the dedicated operator migration queue. It contains no creator data. */
export interface AwsMigrationCommand { migrationId: string; operation: AwsMigrationOperation; rollbackWindowSeconds?: number; }

/** Small operator-only queue adapter; commands contain checkpoint IDs only. */
export class SqsMigrationCommandQueue {
  constructor(private readonly sqs: Pick<SQSClient, "send">, private readonly queueUrl: string) {}
  async enqueue(command: AwsMigrationCommand): Promise<void> {
    if (!command.migrationId.trim() || !["resume", "rollback", "retire"].includes(command.operation) || (command.rollbackWindowSeconds !== undefined && (!Number.isSafeInteger(command.rollbackWindowSeconds) || command.rollbackWindowSeconds < 1))) throw new Error("Migration command is invalid.");
    await this.sqs.send(new SendMessageCommand({ QueueUrl: this.queueUrl, MessageBody: JSON.stringify(command) }));
  }
}
export const createAwsMigrationCommandQueue = (configuration: { queueUrl: string; region?: string }) => new SqsMigrationCommandQueue(new SQSClient({ region: configuration.region }), configuration.queueUrl);

/**
 * Dedicated control-plane worker. It resolves only pre-registered cell
 * endpoints, streams objects through the migration-only transfer adapter, and
 * advances the shared compare-and-swap checkpoint. It never accesses a cell's
 * record table or participates in normal creator request handling.
 */
export class AwsMigrationControlWorker {
  constructor(private readonly input: { routingDirectory: RoutingDirectory; checkpoints: MigrationCheckpointStore; cells: MigrationCellRegistry; lambda?: AwsCommandClient; lambdaForRegion?: (region: string) => AwsCommandClient; s3ForRegion?: (region: string) => AwsCommandClient; clock?: () => string }) {}
  async execute(command: AwsMigrationCommand): Promise<MigrationCheckpoint> {
    if (!command.migrationId.trim() || !["resume", "rollback", "retire"].includes(command.operation)) throw new Error("Migration command is invalid.");
    const checkpoint = await this.input.checkpoints.get(command.migrationId);
    if (!checkpoint) throw new Error(`Migration checkpoint ${command.migrationId} was not found.`);
    const [source, destination] = await Promise.all([this.requiredCell(checkpoint.source.homeCellId), this.requiredCell(checkpoint.destination.cellId)]);
    const lambdaForRegion = this.input.lambdaForRegion ?? ((region: string) => this.input.lambda ?? new LambdaClient({ region }));
    const s3ForRegion = this.input.s3ForRegion ?? ((region: string) => new S3Client({ region }));
    const executor = new RemoteMigrationExecutor(new LambdaMigrationCellEndpoint(lambdaForRegion(source.region), source.migrationEndpoint), new LambdaMigrationCellEndpoint(lambdaForRegion(destination.region), destination.migrationEndpoint), new S3MigrationObjectTransfer(s3ForRegion(source.region), s3ForRegion(destination.region)), destination.objectBucket);
    const orchestrator = new MigrationOrchestrator(this.input.routingDirectory, this.input.checkpoints, executor, this.input.clock);
    if (command.operation === "rollback") return orchestrator.rollback(command.migrationId);
    if (command.operation === "retire") return orchestrator.retire(command.migrationId);
    return orchestrator.resume(command.migrationId, command.rollbackWindowSeconds);
  }
  private async requiredCell(cellId: string): Promise<MigrationCellRegistration> {
    const cell = await this.input.cells.get(cellId);
    if (!cell || cell.state !== "active") throw new Error(`Migration cell ${cellId} is not active in the operator registry.`);
    return cell;
  }
}

export class S3ObjectStorage implements ObjectStorage {
  constructor(private readonly s3: AwsCommandClient, private readonly bucket: string, private readonly cellId?: string, private readonly keyPrefix?: string) {}
  private objectKey(key: string): string { return this.keyPrefix && !key.startsWith(`${this.keyPrefix}/`) ? `${this.keyPrefix}/${key}` : key; }
  private requireLocalKey(key: string): void { if (this.cellId) requireCellScopedObject(key, this.cellId); }
  async put(input: { object: StoredObject; body: Uint8Array }): Promise<void> {
    input.object.key = this.objectKey(input.object.key);
    this.requireLocalKey(input.object.key);
    const response = await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: input.object.key, Body: input.body, ContentType: input.object.contentType, Metadata: { scope: input.object.scope, ...(input.object.checksum ? { checksum: input.object.checksum } : {}), byteLength: String(input.object.byteLength) } }));
    // S3 assigns an immutable object version. Preserve it on the supplied
    // object so the application records and later delivery grants address the
    // exact rendition that was written, rather than a local placeholder.
    if (response.VersionId) input.object.versionId = response.VersionId;
  }
  async get(input: Pick<StoredObject, "bucket" | "key" | "versionId">): Promise<{ object: StoredObject; body: Uint8Array }> { const key = this.objectKey(input.key); this.requireLocalKey(key); const response = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key, VersionId: input.versionId })); const body = new Uint8Array(await response.Body!.transformToByteArray()); return { object: { bucket: this.bucket, key, versionId: response.VersionId, contentType: response.ContentType ?? "application/octet-stream", byteLength: body.byteLength, checksum: response.Metadata?.checksum, scope: (response.Metadata?.scope as StoredObject["scope"]) ?? "private" }, body }; }
  async remove(input: Pick<StoredObject, "bucket" | "key" | "versionId">): Promise<void> { const key = this.objectKey(input.key); this.requireLocalKey(key); await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key, VersionId: input.versionId })); }
}

/**
 * Explicit cross-cell transfer path for an authorized migration worker. It
 * streams source bytes, verifies the exported SHA-256 inventory, writes only
 * the declared destination key, and verifies the durable destination object.
 * Normal Ubeeq uploads never instantiate or call this adapter.
 */
export class S3MigrationObjectTransfer implements MigrationObjectTransfer {
  constructor(private readonly source: AwsCommandClient, private readonly destination: AwsCommandClient) {}
  private validate(checkpoint: MigrationCheckpoint, object: MigrationObjectInventoryEntry): void {
    if (!object.source.key.startsWith(`cells/${checkpoint.source.homeCellId}/`) || !object.destination.key.startsWith(`cells/${checkpoint.destination.cellId}/`)) throw new Error("Migration object inventory crosses an undeclared cell boundary.");
  }
  async transfer(checkpoint: MigrationCheckpoint, objects: readonly MigrationObjectInventoryEntry[]): Promise<void> {
    for (const object of objects) {
      this.validate(checkpoint, object);
      const source = await this.source.send(new GetObjectCommand({ Bucket: object.source.bucket, Key: object.source.key, VersionId: object.source.versionId }));
      const body = new Uint8Array(await source.Body!.transformToByteArray());
      const checksum = createHash("sha256").update(body).digest("hex");
      if (body.byteLength !== object.byteLength || checksum !== object.checksum) throw new Error(`Migration source object ${object.id} does not match its exported inventory.`);
      await this.destination.send(new PutObjectCommand({ Bucket: object.destination.bucket, Key: object.destination.key, Body: body, ContentType: source.ContentType, Metadata: { checksum: object.checksum, byteLength: String(object.byteLength), migrationId: checkpoint.id } }));
    }
  }
  async verify(checkpoint: MigrationCheckpoint, objects: readonly MigrationObjectInventoryEntry[]): Promise<{ objectCount: number; verifiedObjectCount: number }> {
    let verifiedObjectCount = 0;
    for (const object of objects) {
      this.validate(checkpoint, object);
      const destination = await this.destination.send(new HeadObjectCommand({ Bucket: object.destination.bucket, Key: object.destination.key }));
      if (destination.ContentLength === object.byteLength && destination.Metadata?.checksum === object.checksum) verifiedObjectCount += 1;
    }
    return { objectCount: objects.length, verifiedObjectCount };
  }
}

const checksumBase64 = (checksum: string): string => /^[a-f0-9]{64}$/i.test(checksum) ? Buffer.from(checksum, "hex").toString("base64") : checksum;
const directUploadId = (object: StoredObject): string => Buffer.from(JSON.stringify(object)).toString("base64url");
const objectForDirectUpload = (uploadId: string): StoredObject => {
  try { const value = JSON.parse(Buffer.from(uploadId, "base64url").toString("utf8")) as StoredObject; if (!value.bucket || !value.key || !value.contentType) throw new Error(); return value; }
  catch { throw new Error("AWS direct upload identifier is invalid."); }
};

/** S3 direct uploads bind the SHA-256 checksum to the presigned write and verify the immutable version at completion. */
export class S3DirectUploadAdapter implements UploadAdapter {
  constructor(private readonly s3: S3Client, private readonly bucket: string, private readonly cellId?: string) {}
  async initiate(input: { object: StoredObject; checksumAlgorithm: "sha256"; multipart?: boolean; expiresAt: string }): Promise<UploadInitiation> {
    if (input.multipart) throw new Error("Multipart uploads require a dedicated multipart adapter.");
    if (Date.parse(input.expiresAt) <= Date.now()) throw new Error("AWS direct upload expiry must be in the future.");
    if (this.cellId) requireCellScopedObject(input.object.key, this.cellId);
    const requestedChecksum = input.object.checksum;
    if (!requestedChecksum) throw new Error("AWS direct uploads require a SHA-256 checksum before initiation.");
    const object = { ...input.object, checksum: requestedChecksum, bucket: this.bucket, scope: input.object.scope };
    const expiresIn = Math.max(1, Math.min(900, Math.floor((Date.parse(input.expiresAt) - Date.now()) / 1_000)));
    const checksum = checksumBase64(object.checksum);
    const url = await getSignedUrl(this.s3, new PutObjectCommand({ Bucket: this.bucket, Key: object.key, ContentType: object.contentType, ChecksumSHA256: checksum, Metadata: { checksum: object.checksum, scope: object.scope, byteLength: String(object.byteLength) } }), {
      expiresIn,
      // The browser must send these headers with the object. Keeping them in the
      // canonical request prevents clients from changing integrity or access metadata.
      unhoistableHeaders: new Set(["x-amz-checksum-sha256", "x-amz-meta-checksum", "x-amz-meta-scope", "x-amz-meta-bytelength"]),
    });
    return { uploadId: directUploadId(object), object, parts: [{ partNumber: 1, url, expiresAt: input.expiresAt }], completeUrl: undefined, expiresAt: input.expiresAt };
  }
  async complete(input: UploadCompletion): Promise<StoredObject> {
    const requested = objectForDirectUpload(input.uploadId);
    requireCreatorScopedObject(requested.key, input); if (this.cellId) requireCellScopedObject(requested.key, this.cellId);
    const response = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: requested.key }));
    if (!response.VersionId || response.ContentLength !== input.byteLength || response.Metadata?.checksum !== input.checksum || (response.ChecksumSHA256 && response.ChecksumSHA256 !== checksumBase64(input.checksum))) throw new Error("AWS upload completion did not match the signed object checksum, size, or version.");
    return { ...requested, versionId: response.VersionId, contentType: response.ContentType ?? requested.contentType, byteLength: response.ContentLength, checksum: input.checksum, scope: (response.Metadata?.scope as StoredObject["scope"]) ?? requested.scope };
  }
}
export const issueS3Download = async (s3: S3Client, bucket: string, object: Pick<StoredObject, "key" | "versionId">, expiresInSeconds = 300) => getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: object.key, VersionId: object.versionId }), { expiresIn: expiresInSeconds });
export class S3PresignedDelivery implements DeliveryAdapter {
  constructor(private readonly s3: S3Client, private readonly bucket: string, private readonly cellId?: string) {}
  async issue(request: Parameters<DeliveryAdapter["issue"]>[0]): Promise<{ url: string; expiresAt: string }> {
    if (this.cellId) requireCellScopedObject(request.object.key, this.cellId);
    const expiresInSeconds = Math.max(1, Math.min(7 * 24 * 60 * 60, Math.floor((Date.parse(request.expiresAt) - Date.now()) / 1_000)));
    return { url: await issueS3Download(this.s3, this.bucket, request.object, expiresInSeconds), expiresAt: request.expiresAt };
  }
}

/**
 * SQS is used as a wake-up signal while the DynamoDB record is the durable source of
 * truth. Workers lease atomically from DynamoDB, so duplicate SQS delivery and lost
 * notifications are harmless: a periodic recovery worker can always re-offer queued work.
 */
interface AwsJobRecord extends DurableJob, RevisionedRecord {
  /** Separate request trace from the existing correlationId lease fence. Null means no retained trace. */
  requestCorrelationId?: string | null;
}
export class AwsJobQueue implements JobQueue {
  private readonly jobs: DynamoRevisionedRepository<AwsJobRecord>;
  constructor(private readonly dynamo: Dynamo, private readonly configuration: AwsRepositoryConfiguration, private readonly sqs: Pick<SQSClient, "send">, private readonly queueUrl: string, private readonly eventBridge?: { client: Pick<EventBridgeClient, "send">; eventBusName: string }) {
    this.jobs = new DynamoRevisionedRepository<AwsJobRecord>(dynamo, configuration, "durableJobs");
  }
  async enqueue<TPayload>(input: Omit<DurableJob<TPayload>, "id" | "state" | "attempt" | "availableAt" | "createdAt" | "updatedAt"> & { availableAt?: string }): Promise<DurableJob<TPayload>> {
    const id = `job-${createHash("sha256").update(`${input.cellId}:${input.idempotencyKey}`).digest("hex").slice(0, 32)}`;
    const existing = await this.jobs.get(id);
    if (existing) return this.publicJob(existing) as DurableJob<TPayload>;
    const created = await this.jobs.create({ id, ...input, requestCorrelationId: input.correlationId ?? null, state: "queued", attempt: 0, availableAt: input.availableAt ?? now() } as Omit<AwsJobRecord, "revision" | "createdAt" | "updatedAt">, { idempotencyKey: input.idempotencyKey });
    await this.notify(created.id, created.type, created.cellId);
    return this.publicJob(created) as DurableJob<TPayload>;
  }
  async lease<TPayload>(input: { cellId: string; types?: readonly string[]; leaseDurationSeconds: number; workerId: string }): Promise<JobLease<TPayload> | undefined> {
    if (!input.cellId.trim() || !Number.isSafeInteger(input.leaseDurationSeconds) || input.leaseDurationSeconds <= 0) throw new Error("A cell and positive integer lease duration are required.");
    for await (const candidate of repositoryItems(request => this.jobs.list(request))) {
      const timestamp = Date.now();
      if (candidate.cellId !== input.cellId || (input.types?.length && !input.types.includes(candidate.type))) continue;
      const expired = candidate.state === 'leased' && Boolean(candidate.leaseExpiresAt) && Date.parse(candidate.leaseExpiresAt!) <= timestamp;
      const available = ['queued', 'retry_scheduled'].includes(candidate.state) && Date.parse(candidate.availableAt) <= timestamp;
      if (!expired && !available) continue;
      const leaseToken = randomUUID();
      try {
        if (expired && candidate.attempt >= candidate.maxAttempts) {
          await this.claimOrExpire(candidate, timestamp, true, { state: 'dead_lettered', leaseExpiresAt: undefined, lastError: { code: 'lease_attempts_exhausted', message: 'Worker leases expired through the configured attempt budget.' } });
          continue;
        }
        const leased = await this.claimOrExpire(candidate, timestamp, expired, { state: 'leased', attempt: candidate.attempt + 1, leaseExpiresAt: new Date(timestamp + input.leaseDurationSeconds * 1_000).toISOString(), correlationId: `${input.workerId}:${leaseToken}` });
        return { job: this.publicJob(leased) as DurableJob<TPayload>, leaseToken };
      } catch (error) { if (!(error instanceof OptimisticConcurrencyError)) throw error; }
    }
    return undefined;
  }
  private async claimOrExpire(job: AwsJobRecord, timestamp: number, expired: boolean, change: Partial<AwsJobRecord>): Promise<AwsJobRecord> {
    const currentTime = new Date(timestamp).toISOString();
    // Keep the raw ownership marker for both old and new workers. Historical jobs
    // already leased by an older writer have lost their original trace; never
    // mistake the old worker/token for a request ID.
    const requestCorrelationId = job.requestCorrelationId === undefined ? (job.attempt === 0 ? job.correlationId ?? null : null) : job.requestCorrelationId;
    const value = { ...job, ...change, requestCorrelationId, revision: job.revision + 1, updatedAt: currentTime };
    try {
      await this.dynamo.send(new PutCommand({ TableName: this.configuration.tableName,
        Item: { pk: pk('durableJobs', job.id), sk: 'record', repository: 'durableJobs', id: job.id, revision: value.revision, value: withoutUndefined(value) },
        ConditionExpression: `attribute_exists(pk) AND #revision = :revision AND #value.#cell = :cell AND #value.#state = :state AND #value.#due <= :now`,
        ExpressionAttributeNames: { '#revision': 'revision', '#value': 'value', '#cell': 'cellId', '#state': 'state', '#due': expired ? 'leaseExpiresAt' : 'availableAt' },
        ExpressionAttributeValues: { ':revision': job.revision, ':cell': job.cellId, ':state': job.state, ':now': currentTime }
      }));
      return value;
    } catch (error) {
      if ((error as { name?: string }).name === 'ConditionalCheckFailedException') throw new OptimisticConcurrencyError(job.id, job.revision);
      throw error;
    }
  }
  async complete(input: { id: string; leaseToken: string }): Promise<void> { await this.transition(input.id, input.leaseToken, { state: "completed", leaseExpiresAt: undefined }); }
  async retry(input: { id: string; leaseToken: string; error: { code: string; message: string }; retryAt: string }): Promise<void> { const job = await this.requiredLease(input.id, input.leaseToken); await this.updateLeased(job, job.attempt >= job.maxAttempts ? { state: "dead_lettered", lastError: input.error, leaseExpiresAt: undefined } : { state: "retry_scheduled", lastError: input.error, availableAt: input.retryAt, leaseExpiresAt: undefined }); if (job.attempt < job.maxAttempts) await this.notify(job.id, job.type, job.cellId); }
  async deadLetter(input: { id: string; leaseToken: string; error: { code: string; message: string } }): Promise<void> { await this.transition(input.id, input.leaseToken, { state: "dead_lettered", lastError: input.error, leaseExpiresAt: undefined }); }
  async cancel(input: { id: string; reason?: string }): Promise<void> { const job = await this.required(input.id); await this.jobs.update(job.id, job.revision, { state: "cancelled", lastError: input.reason ? { code: "cancelled", message: input.reason } : undefined, leaseExpiresAt: undefined }); }
  async recover(input: { id: string; availableAt?: string }): Promise<DurableJob> { const job = await this.required(input.id); requireRecoverableJob(job.state); const recovered = await this.jobs.update(job.id, job.revision, { state: "queued", availableAt: input.availableAt ?? now(), leaseExpiresAt: undefined }); await this.notify(recovered.id, recovered.type, recovered.cellId); return this.publicJob(recovered); }
  async get(id: string): Promise<DurableJob | undefined> { const job = await this.jobs.get(id); return job && this.publicJob(job); }
  async list(input: { cellId: string; states?: readonly JobState[]; limit: number }): Promise<readonly DurableJob[]> {
    if (!input.cellId.trim() || !Number.isSafeInteger(input.limit) || input.limit < 1) throw new Error('A cell and positive integer job limit are required.');
    const found: DurableJob[] = [];
    for await (const job of repositoryItems(request => this.jobs.list(request))) {
      if (job.cellId !== input.cellId || input.states?.length && !input.states.includes(job.state)) continue;
      found.push(this.publicJob(job));
      if (found.length >= input.limit) break;
    }
    return found;
  }
  private publicJob(record: AwsJobRecord): DurableJob {
    const { requestCorrelationId, ...job } = record;
    const trace = requestCorrelationId === undefined && record.attempt === 0 ? record.correlationId : requestCorrelationId;
    if (typeof trace === 'string') job.correlationId = trace;
    else delete job.correlationId;
    return job;
  }
  private async required(id: string): Promise<AwsJobRecord> { const job = await this.jobs.get(id); if (!job) throw new Error(`Job ${id} was not found.`); return job; }
  private async requiredLease(id: string, leaseToken: string): Promise<AwsJobRecord> { const job = await this.required(id); if (job.state !== "leased" || !leaseToken || job.correlationId?.split(":").at(-1) !== leaseToken || !job.leaseExpiresAt || !(Date.parse(job.leaseExpiresAt) > Date.now())) throw new Error(`Job ${id} does not hold this lease.`); return job; }
  private async transition(id: string, leaseToken: string, change: Partial<AwsJobRecord>): Promise<void> { const job = await this.requiredLease(id, leaseToken); await this.updateLeased(job, change); }
  private async updateLeased(job: AwsJobRecord, change: Partial<AwsJobRecord>): Promise<void> {
    const timestamp = now();
    const value = { ...job, ...change, revision: job.revision + 1, updatedAt: timestamp };
    try {
      await this.dynamo.send(new PutCommand({ TableName: this.configuration.tableName,
        Item: { pk: pk('durableJobs', job.id), sk: 'record', repository: 'durableJobs', id: job.id, revision: value.revision, value: withoutUndefined(value) },
        ConditionExpression: 'attribute_exists(pk) AND #revision = :revision AND #value.#state = :leased AND #value.#owner = :owner AND #value.#expiry > :now',
        ExpressionAttributeNames: { '#revision': 'revision', '#value': 'value', '#state': 'state', '#owner': 'correlationId', '#expiry': 'leaseExpiresAt' },
        ExpressionAttributeValues: { ':revision': job.revision, ':leased': 'leased', ':owner': job.correlationId, ':now': timestamp }
      }));
    } catch (error) {
      if ((error as { name?: string }).name === 'ConditionalCheckFailedException') throw new OptimisticConcurrencyError(job.id, job.revision);
      throw error;
    }
  }
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

export interface VerifiedCognitoAccessClaims {
  sub: string; username?: string; iat: number; exp: number; scope?: string; 'cognito:groups'?: string[];
}
export class CognitoIdentity implements IdentityAdapter {
  private verifier?: { verify(token: string): Promise<VerifiedCognitoAccessClaims> };
  constructor(private readonly cognito: AwsCommandClient, private readonly userPoolId: string, private readonly clientId: string,
    options: { verifier?: { verify(token: string): Promise<VerifiedCognitoAccessClaims> } } = {}) { this.verifier = options.verifier; }
  /** Cognito GlobalSignOut requires the original access token; callers must keep this session id internal and never serialize it into audit/export data. */
  async verifySession(input: { credential: string }): Promise<AuthenticatedSession | undefined> {
    try {
      // Verify the signature, issuer, client_id, access-token use and time claims before GetUser.
      this.verifier ??= CognitoJwtVerifier.create({ userPoolId: this.userPoolId, clientId: this.clientId, tokenUse: 'access' });
      const payload = await this.verifier.verify(input.credential);
      if (!payload.sub || !Number.isFinite(payload.exp) || payload.exp * 1000 <= Date.now()) return undefined;
      const user = await this.cognito.send(new GetUserCommand({ AccessToken: input.credential }));
      const id = user.Username;
      const attributes = (user.UserAttributes ?? []) as Array<{ Name?: string; Value?: string }>;
      if (typeof id !== 'string' || !id || (payload.username && id !== payload.username) || attributes.find(item => item.Name === 'sub')?.Value !== payload.sub) return undefined;
      const customer = attributes.find(item => item.Name === 'custom:account_scope')?.Value === 'customer_account';
      return { id: input.credential, subject: { id, email: attributes.find(item => item.Name === 'email')?.Value, emailVerified: attributes.find(item => item.Name === 'email_verified')?.Value === 'true', roles: Array.isArray(payload['cognito:groups']) ? payload['cognito:groups'].filter(role => typeof role === 'string') : [], accountScope: customer ? 'customer_account' : 'creator_operator', scopes: payload.scope?.split(' ') ?? [] },
        issuedAt: new Date(payload.iat * 1000).toISOString(), expiresAt: new Date(payload.exp * 1000).toISOString(), authenticationMethod: 'oidc' };
    } catch { return undefined; }
  }
  async getAccount(subjectId: string): Promise<IdentityAccount | undefined> {
    if (typeof subjectId !== 'string' || !subjectId || subjectId.length > 128 || /[\s\u0000-\u001f\u007f]/u.test(subjectId)) return undefined;
    let user;
    try { user = await this.cognito.send(new AdminGetUserCommand({ UserPoolId: this.userPoolId, Username: subjectId })); }
    catch (error) {
      if ((error as { name?: string })?.name === 'UserNotFoundException') return undefined;
      // Never substitute an active account when the provider is unavailable or the host lacks permission.
      throw new Error('Cognito account status is unavailable.');
    }
    const status = user.UserStatus;
    if (user.Username !== subjectId || typeof user.Enabled !== 'boolean' || !['UNCONFIRMED', 'CONFIRMED', 'ARCHIVED', 'COMPROMISED', 'RESET_REQUIRED', 'FORCE_CHANGE_PASSWORD', 'EXTERNAL_PROVIDER'].includes(status)) throw new Error('Cognito account evidence is unavailable.');
    const timestamp = (value: unknown) => {
      if (value === undefined) return '';
      if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error('Cognito account timestamp is invalid.');
      return value.toISOString();
    };
    return { id: subjectId, subjectId, status: status === 'ARCHIVED' ? 'closed' : !user.Enabled || status === 'COMPROMISED' ? 'suspended' : ['CONFIRMED', 'EXTERNAL_PROVIDER'].includes(status) ? 'active' : 'pending_verification', createdAt: timestamp(user.UserCreateDate), updatedAt: timestamp(user.UserLastModifiedDate) };
  }
  async listDelegations(): Promise<readonly []> { return []; }
  async revokeSession(input: { sessionId: string }): Promise<void> { await this.cognito.send(new GlobalSignOutCommand({ AccessToken: input.sessionId })); }
  async authenticate(input: { username: string; password: string }): Promise<{ token: string }> {
    let result;
    try { result = await this.cognito.send(new InitiateAuthCommand({ AuthFlow: "USER_PASSWORD_AUTH", ClientId: this.clientId, AuthParameters: { USERNAME: input.username, PASSWORD: input.password } })); }
    catch (error) {
      const name = (error as { name?: string })?.name;
      throw new PasswordAuthenticationError(['NotAuthorizedException','UserNotFoundException'].includes(name ?? '') ? 'invalid_credentials' : ['UserNotConfirmedException','PasswordResetRequiredException'].includes(name ?? '') ? 'authentication_challenge_required' : 'identity_provider_unavailable');
    }
    if (result?.ChallengeName) throw new PasswordAuthenticationError('authentication_challenge_required');
    const token = result?.AuthenticationResult?.AccessToken;
    if (typeof token !== 'string' || !token || token.trim() !== token) throw new PasswordAuthenticationError('identity_provider_unavailable');
    return { token };
  }
  async authenticateSession(input: { email: string; password: string }): Promise<{ token: string; session: AuthenticatedSession }> {
    const { token } = await this.authenticate({ username: input.email, password: input.password });
    const session = await this.verifySession({ credential: token });
    if (!session) throw new PasswordAuthenticationError('identity_provider_unavailable');
    let account;
    try { account = await this.getAccount(session.subject.id); }
    catch { throw new PasswordAuthenticationError('identity_provider_unavailable'); }
    if (!account || account.status !== 'active') throw new PasswordAuthenticationError('invalid_credentials');
    return { token, session };
  }
}

export const issueCloudFrontDelivery = (input: { url: string; privateKey: string; keyPairId: string; expiresAt: string }): string => getCloudFrontSignedUrl({ url: input.url, privateKey: input.privateKey, keyPairId: input.keyPairId, dateLessThan: input.expiresAt });
export class CloudFrontDelivery implements DeliveryAdapter {
  constructor(private readonly configuration: { origin: string; privateKey: string; keyPairId: string; cellId?: string }) {}
  async issue(request: Parameters<DeliveryAdapter["issue"]>[0]): Promise<{ url: string; expiresAt: string }> {
    if (this.configuration.cellId) requireCellScopedObject(request.object.key, this.configuration.cellId);
    const origin = this.configuration.origin.replace(/\/$/, ""); const key = request.object.key.split("/").map(encodeURIComponent).join("/");
    return { url: issueCloudFrontDelivery({ url: `${origin}/${key}`, privateKey: this.configuration.privateKey, keyPairId: this.configuration.keyPairId, expiresAt: request.expiresAt }), expiresAt: request.expiresAt };
  }
}

/** Explicit AWS composition; core/application code receives only provider-neutral ports. */
export interface AwsAdapterConfiguration extends AwsRepositoryConfiguration { region?: string; objectBucket: string; queueUrl: string; userPoolId: string; userPoolClientId: string; passwordAuthenticationEnabled?: boolean; credentialSecretPrefix: string; eventBusName?: string; cloudFront?: { origin: string; privateKey: string; keyPairId: string }; }
export const createAwsAdapterSet = (configuration: AwsAdapterConfiguration) => {
  const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: configuration.region }));
  const s3 = new S3Client({ region: configuration.region }); const sqs = new SQSClient({ region: configuration.region }); const events = new EventBridgeClient({ region: configuration.region });
  const storage = new S3ObjectStorage(s3, configuration.objectBucket, configuration.cellId);
  const identity = new CognitoIdentity(new CognitoIdentityProviderClient({ region: configuration.region }), configuration.userPoolId, configuration.userPoolClientId);
  return {
    repositories: createDynamoRepositories(dynamo, configuration), storage, uploads: new S3DirectUploadAdapter(s3, configuration.objectBucket, configuration.cellId),
    delivery: configuration.cloudFront ? new CloudFrontDelivery({ ...configuration.cloudFront, cellId: configuration.cellId }) : new S3PresignedDelivery(s3, configuration.objectBucket, configuration.cellId),
    jobs: new AwsJobQueue(dynamo, configuration, sqs, configuration.queueUrl, configuration.eventBusName ? { client: events, eventBusName: configuration.eventBusName } : undefined),
    identity,
    ...(configuration.passwordAuthenticationEnabled ? { passwordAuthentication: { authenticate: (input: { email: string; password: string }) => identity.authenticateSession(input) } } : {}),
    credentials: new SecretsManagerCredentialVault(new SecretsManagerClient({ region: configuration.region }), configuration.credentialSecretPrefix)
  };
};
export { DynamoSmugMugRepository } from './smugmug-repository.js';
export { createS3PublicDerivativeStore, type PublicDerivativeStore } from './public-derivative-storage.js';
export { createDynamoPublicDerivativeRepository, publicDerivativePublicationKey, publicDerivativeAssetKey,
  type PublicDerivativePublication, type PublicDerivativeRepository } from './public-derivative-repository.js';
export * from './website-hosting.js';

export {DynamoCommerceStore} from './commerce.js';
