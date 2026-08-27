/** Optional AWS adapter composition. AWS SDK imports are intentionally isolated to this package. */
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand, DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { GetSecretValueCommand, PutSecretValueCommand, UpdateSecretCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { GetUserCommand, GlobalSignOutCommand, InitiateAuthCommand, CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { getSignedUrl as getCloudFrontSignedUrl } from "@aws-sdk/cloudfront-signer";
import { randomUUID } from "node:crypto";
import { OptimisticConcurrencyError, type Page, type PageRequest, type RevisionedRecord, type RevisionedRepository, type UbeeqRepositories } from "@ubeeq/persistence";
import type { ObjectStorage, StoredObject } from "@ubeeq/storage";
import type { AuthenticatedSession, IdentityAccount, IdentityAdapter } from "@ubeeq/auth";
import type { CredentialVault } from "@ubeeq/integrations";

export const AWS_ADAPTERS_API_VERSION = "1" as const;
export interface AwsRepositoryConfiguration { tableName: string; }
type Dynamo = Pick<DynamoDBDocumentClient, "send">;
const now = () => new Date().toISOString();
const pk = (repository: string, id: string) => `${repository}#${id}`;

export class DynamoRevisionedRepository<T extends RevisionedRecord> implements RevisionedRepository<T> {
  constructor(private readonly dynamo: Dynamo, private readonly configuration: AwsRepositoryConfiguration, private readonly repository: string) {}
  async create(record: Omit<T, "revision" | "createdAt" | "updatedAt">): Promise<T> { const timestamp = now(); const value = { ...record, revision: 1, createdAt: timestamp, updatedAt: timestamp } as T; await this.dynamo.send(new PutCommand({ TableName: this.configuration.tableName, Item: { pk: pk(this.repository, value.id), sk: "record", repository: this.repository, id: value.id, value }, ConditionExpression: "attribute_not_exists(pk)" })); return value; }
  async get(id: string): Promise<T | undefined> { const response = await this.dynamo.send(new GetCommand({ TableName: this.configuration.tableName, Key: { pk: pk(this.repository, id), sk: "record" } })); return response.Item?.value as T | undefined; }
  async list(request: PageRequest): Promise<Page<T>> { const response = await this.dynamo.send(new QueryCommand({ TableName: this.configuration.tableName, KeyConditionExpression: "begins_with(pk, :prefix)", ExpressionAttributeValues: { ":prefix": `${this.repository}#` }, Limit: request.limit, ExclusiveStartKey: request.cursor ? JSON.parse(Buffer.from(request.cursor, "base64url").toString("utf8")) : undefined })); return { items: (response.Items ?? []).map((item) => item.value as T), nextCursor: response.LastEvaluatedKey ? Buffer.from(JSON.stringify(response.LastEvaluatedKey)).toString("base64url") : undefined }; }
  async update(id: string, expectedRevision: number, change: Partial<Omit<T, "id" | "revision" | "createdAt" | "updatedAt">>): Promise<T> { const current = await this.get(id); if (!current) throw new OptimisticConcurrencyError(id, expectedRevision); const value = { ...current, ...change, revision: expectedRevision + 1, updatedAt: now() } as T; try { await this.dynamo.send(new PutCommand({ TableName: this.configuration.tableName, Item: { pk: pk(this.repository, id), sk: "record", repository: this.repository, id, value }, ConditionExpression: "attribute_exists(pk) AND #value.#revision = :revision", ExpressionAttributeNames: { "#value": "value", "#revision": "revision" }, ExpressionAttributeValues: { ":revision": expectedRevision } })); return value; } catch { throw new OptimisticConcurrencyError(id, expectedRevision); } }
  async remove(id: string, expectedRevision: number): Promise<void> { try { await this.dynamo.send(new DeleteCommand({ TableName: this.configuration.tableName, Key: { pk: pk(this.repository, id), sk: "record" }, ConditionExpression: "#value.#revision = :revision", ExpressionAttributeNames: { "#value": "value", "#revision": "revision" }, ExpressionAttributeValues: { ":revision": expectedRevision } })); } catch { throw new OptimisticConcurrencyError(id, expectedRevision); } }
}

const repository = <T extends RevisionedRecord>(dynamo: Dynamo, config: AwsRepositoryConfiguration, name: string) => new DynamoRevisionedRepository<T>(dynamo, config, name);
export const createDynamoRepositories = (dynamo: Dynamo, config: AwsRepositoryConfiguration): UbeeqRepositories => ({ transaction: async (work) => work({ id: randomUUID() }), creators: repository(dynamo, config, "creators"), works: repository(dynamo, config, "works"), assets: repository(dynamo, config, "assets"), collections: repository(dynamo, config, "collections"), workMemberships: repository(dynamo, config, "workMemberships"), publicationIntents: repository(dynamo, config, "publicationIntents"), publications: repository(dynamo, config, "publications"), reconciliationSnapshots: repository(dynamo, config, "reconciliationSnapshots"), moderationEvidence: repository(dynamo, config, "moderationEvidence"), moderationHolds: repository(dynamo, config, "moderationHolds"), reviewCases: repository(dynamo, config, "reviewCases"), auditEvents: repository(dynamo, config, "auditEvents"), usageEvents: repository(dynamo, config, "usageEvents"), creditLots: repository(dynamo, config, "creditLots"), creditReservations: repository(dynamo, config, "creditReservations"), balances: repository(dynamo, config, "balances"), integrationAccounts: repository(dynamo, config, "integrationAccounts"), syncCursors: repository(dynamo, config, "syncCursors"), integrationJobs: repository(dynamo, config, "integrationJobs"), exportManifests: repository(dynamo, config, "exportManifests"), importCheckpoints: repository(dynamo, config, "importCheckpoints"), federationActors: repository(dynamo, config, "federationActors"), remotePublicationReferences: repository(dynamo, config, "remotePublicationReferences") });

export class S3ObjectStorage implements ObjectStorage {
  constructor(private readonly s3: Pick<S3Client, "send">, private readonly bucket: string) {}
  async put(input: { object: StoredObject; body: Uint8Array }): Promise<void> { await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: input.object.key, Body: input.body, ContentType: input.object.contentType, Metadata: { scope: input.object.scope, checksum: input.object.checksum ?? "", byteLength: String(input.object.byteLength) } })); }
  async get(input: Pick<StoredObject, "bucket" | "key" | "versionId">): Promise<{ object: StoredObject; body: Uint8Array }> { const response = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: input.key, VersionId: input.versionId })); const body = new Uint8Array(await response.Body!.transformToByteArray()); return { object: { bucket: this.bucket, key: input.key, versionId: response.VersionId, contentType: response.ContentType ?? "application/octet-stream", byteLength: body.byteLength, checksum: response.Metadata?.checksum, scope: (response.Metadata?.scope as StoredObject["scope"]) ?? "private" }, body }; }
  async remove(input: Pick<StoredObject, "bucket" | "key" | "versionId">): Promise<void> { await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: input.key, VersionId: input.versionId })); }
}
export const issueS3Download = async (s3: S3Client, object: Pick<StoredObject, "key" | "versionId">, expiresInSeconds = 300) => getSignedUrl(s3, new GetObjectCommand({ Bucket: "", Key: object.key, VersionId: object.versionId }), { expiresIn: expiresInSeconds });

export class SecretsManagerCredentialVault implements CredentialVault {
  constructor(private readonly secrets: Pick<SecretsManagerClient, "send">, private readonly prefix: string) {}
  async write(input: { ownerId: string; value: Uint8Array; expiresAt?: string }): Promise<{ reference: string }> { const id = `${this.prefix}/${input.ownerId}/${randomUUID()}`; await this.secrets.send(new PutSecretValueCommand({ SecretId: id, SecretBinary: input.value })); return { reference: `aws-secrets:${id}` }; }
  async read(input: { reference: string }): Promise<Uint8Array | undefined> { if (!input.reference.startsWith("aws-secrets:")) return undefined; try { const result = await this.secrets.send(new GetSecretValueCommand({ SecretId: input.reference.slice("aws-secrets:".length) })); return result.SecretBinary ? new Uint8Array(result.SecretBinary) : result.SecretString ? new TextEncoder().encode(result.SecretString) : undefined; } catch { return undefined; } }
  async revoke(input: { reference: string }): Promise<void> { if (input.reference.startsWith("aws-secrets:")) await this.secrets.send(new UpdateSecretCommand({ SecretId: input.reference.slice("aws-secrets:".length), SecretString: "revoked" })); }
}

export class CognitoIdentity implements IdentityAdapter {
  constructor(private readonly cognito: Pick<CognitoIdentityProviderClient, "send">, private readonly userPoolId: string, private readonly clientId: string) {}
  async verifySession(input: { credential: string }): Promise<AuthenticatedSession | undefined> { try { const user = await this.cognito.send(new GetUserCommand({ AccessToken: input.credential })); const id = user.Username; if (!id) return undefined; return { id: input.credential.slice(-24), subject: { id, roles: [], scopes: user.UserAttributes?.filter((item) => item.Name === "scope").flatMap((item) => item.Value?.split(" ") ?? []) }, issuedAt: "", expiresAt: "", authenticationMethod: "oidc" }; } catch { return undefined; } }
  async getAccount(subjectId: string): Promise<IdentityAccount | undefined> { return { id: subjectId, subjectId, status: "active", createdAt: "", updatedAt: "" }; }
  async listDelegations(): Promise<readonly []> { return []; }
  async revokeSession(input: { sessionId: string }): Promise<void> { await this.cognito.send(new GlobalSignOutCommand({ AccessToken: input.sessionId })); }
  async authenticate(input: { username: string; password: string }): Promise<{ token: string }> { const result = await this.cognito.send(new InitiateAuthCommand({ AuthFlow: "USER_PASSWORD_AUTH", ClientId: this.clientId, AuthParameters: { USERNAME: input.username, PASSWORD: input.password } })); if (!result.AuthenticationResult?.AccessToken) throw new Error("Cognito authentication did not return an access token."); return { token: result.AuthenticationResult.AccessToken }; }
}

export const issueCloudFrontDelivery = (input: { url: string; privateKey: string; keyPairId: string; expiresAt: string }): string => getCloudFrontSignedUrl({ url: input.url, privateKey: input.privateKey, keyPairId: input.keyPairId, dateLessThan: input.expiresAt });
