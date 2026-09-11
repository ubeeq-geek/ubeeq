import { randomUUID } from 'node:crypto';
import { TransactGetCommand, TransactWriteCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

export interface PublicDerivativePublication {
  id: string;
  recordType: 'PUBLIC_DERIVATIVE_PUBLICATION';
  product: string;
  environment: string;
  dataHomeRegion: string;
  assetId: string;
  mediaVersionId: string;
  scanGroupId: string;
  sourceBucket: string;
  sourceObjectKey: string;
  destinationBucket: string;
  destinationObjectKey: string;
  contentHash: string;
  contentType: string;
  state: 'PUBLISHING' | 'PUBLISHED' | 'FAILED';
  createdAt: string;
  publishedAt?: string;
}

export interface PublicDerivativeRepository {
  /** Read-only receipt recovery; not admission or permission to deliver bytes. */
  completedReceipt(publication: PublicDerivativePublication): Promise<{ createdAt: string; publishedAt: string } | undefined>;
  /** Must conditionally create the publication and reject an existing id. */
  begin(publication: PublicDerivativePublication): Promise<void>;
  /** Must atomically mark the Asset PUBLISHED and append its regional audit event. */
  complete(publication: PublicDerivativePublication): Promise<void>;
  /** Records a failed attempt while leaving the Asset non-public. */
  fail(publication: PublicDerivativePublication, reason: string): Promise<void>;
}

export const publicDerivativePublicationKey = (publicationId: string): string => `PUBLICATION#${publicationId}`;
export const publicDerivativeAssetKey = (assetId: string): string => `ASSET#${assetId}`;

/**
 * Stores the publication, Asset delivery state, and audit records in one cell.
 * All state transitions are conditional, so a stale policy result or replay
 * cannot publish a different Asset version.
 */
export const createDynamoPublicDerivativeRepository = (input: {
  client: DynamoDBDocumentClient;
  metadataTableName: string;
  auditTableName: string;
}): PublicDerivativeRepository => ({
  completedReceipt: async publication => {
    const result = await input.client.send(new TransactGetCommand({ TransactItems: [
      { Get: { TableName: input.auditTableName, Key: { PK: publicDerivativePublicationKey(publication.id) } } },
      { Get: { TableName: input.metadataTableName, Key: { PK: publicDerivativeAssetKey(publication.assetId) } } }
    ] }));
    const receipt = result.Responses?.[0]?.Item, asset = result.Responses?.[1]?.Item;
    if (!receipt || !asset || receipt.state !== 'PUBLISHED' ||
      typeof receipt.createdAt !== 'string' || !receipt.createdAt || typeof receipt.publishedAt !== 'string' || !receipt.publishedAt) return undefined;
    for (const [field, expected] of Object.entries(publication)) {
      if (!['state', 'createdAt', 'publishedAt'].includes(field) && receipt[field] !== expected) return undefined;
    }
    if (asset.product !== publication.product || asset.environment !== publication.environment ||
      asset.dataHomeRegion !== publication.dataHomeRegion || asset.canonicalRegion !== publication.dataHomeRegion ||
      asset.currentMediaVersionId !== publication.mediaVersionId || asset.currentScanGroupId !== publication.scanGroupId ||
      asset.publicDeliveryState !== 'PUBLISHED' || asset.publicDerivativeKey !== publication.destinationObjectKey ||
      asset.processingBillingState !== 'CONSUMED') return undefined;
    return { createdAt: receipt.createdAt, publishedAt: receipt.publishedAt };
  },
  begin: async (publication) => {
    await input.client.send(new TransactWriteCommand({ TransactItems: [
      {
        ConditionCheck: {
          TableName: input.metadataTableName,
          Key: { PK: publicDerivativeAssetKey(publication.assetId) },
          ConditionExpression: '#product = :product AND #environment = :environment AND dataHomeRegion = :region AND canonicalRegion = :region AND processingBillingState = :consumed AND publicDeliveryState = :eligible AND currentScanGroupId = :scanGroupId AND currentMediaVersionId = :mediaVersionId',
          ExpressionAttributeNames: { '#product': 'product', '#environment': 'environment' },
          ExpressionAttributeValues: { ':product': publication.product, ':environment': publication.environment, ':region': publication.dataHomeRegion, ':consumed': 'CONSUMED', ':eligible': 'ELIGIBLE', ':scanGroupId': publication.scanGroupId, ':mediaVersionId': publication.mediaVersionId }
        }
      },
      {
        Put: {
          TableName: input.auditTableName,
          Item: { ...publication, PK: publicDerivativePublicationKey(publication.id) },
          ConditionExpression: 'attribute_not_exists(PK)'
        }
      }
    ] }));
  },
  complete: async (publication) => {
    if (publication.state !== 'PUBLISHED' || !publication.publishedAt) throw new Error('Only a completed publication can be committed');
    await input.client.send(new TransactWriteCommand({ TransactItems: [
      {
        Update: {
          TableName: input.auditTableName,
          Key: { PK: publicDerivativePublicationKey(publication.id) },
          UpdateExpression: 'SET #state = :published, publishedAt = :publishedAt',
          ConditionExpression: '#state = :publishing AND scanGroupId = :scanGroupId AND contentHash = :contentHash',
          ExpressionAttributeNames: { '#state': 'state' },
          ExpressionAttributeValues: { ':published': 'PUBLISHED', ':publishing': 'PUBLISHING', ':publishedAt': publication.publishedAt, ':scanGroupId': publication.scanGroupId, ':contentHash': publication.contentHash }
        }
      },
      {
        Update: {
          TableName: input.metadataTableName,
          Key: { PK: publicDerivativeAssetKey(publication.assetId) },
          UpdateExpression: 'SET publicDeliveryState = :published, publicDerivativeKey = :key, publicDeliveryPublishedAt = :publishedAt',
          ConditionExpression: '#product = :product AND #environment = :environment AND dataHomeRegion = :region AND canonicalRegion = :region AND processingBillingState = :consumed AND publicDeliveryState = :eligible AND currentScanGroupId = :scanGroupId AND currentMediaVersionId = :mediaVersionId',
          ExpressionAttributeNames: { '#product': 'product', '#environment': 'environment' },
          ExpressionAttributeValues: { ':product': publication.product, ':environment': publication.environment, ':region': publication.dataHomeRegion, ':consumed': 'CONSUMED', ':eligible': 'ELIGIBLE', ':published': 'PUBLISHED', ':key': publication.destinationObjectKey, ':publishedAt': publication.publishedAt, ':scanGroupId': publication.scanGroupId, ':mediaVersionId': publication.mediaVersionId }
        }
      },
      {
        Put: {
          TableName: input.auditTableName,
          Item: {
            PK: `AUDIT#${randomUUID()}`, recordType: 'REGIONAL_PUBLICATION_AUDIT',
            product: publication.product, environment: publication.environment,
            dataHomeRegion: publication.dataHomeRegion, assetId: publication.assetId,
            mediaVersionId: publication.mediaVersionId, scanGroupId: publication.scanGroupId,
            action: 'regional_asset.published', publicationId: publication.id,
            createdAt: publication.publishedAt
          }
        }
      }
    ] }));
  },
  fail: async (publication, reason) => {
    await input.client.send(new UpdateCommand({
      TableName: input.auditTableName,
      Key: { PK: publicDerivativePublicationKey(publication.id) },
      UpdateExpression: 'SET #state = :failed, failureReason = :reason, failedAt = :failedAt',
      ConditionExpression: '#state = :publishing',
      ExpressionAttributeNames: { '#state': 'state' },
      ExpressionAttributeValues: { ':failed': 'FAILED', ':publishing': 'PUBLISHING', ':reason': reason, ':failedAt': new Date().toISOString() }
    }));
  }
});
