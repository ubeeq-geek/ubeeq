import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { isSmugMugOAuthClaimable, validateSmugMugItemPage, validateInventoryCompletion, validateConnectionCheckpoint, validateInventoryPageWrite, SmugMugError } from '@ubeeq/integrations';
import type { SmugMugConnection, SmugMugMigration, SmugMugMigrationItem, SmugMugRemoteCollection, SmugMugRemoteImage, SmugMugRepository } from '@ubeeq/integrations';

/** DynamoDB persistence for resumable migrations in a caller-supplied uppercase PK/SK table. */
export class DynamoSmugMugRepository implements SmugMugRepository {
  constructor(private readonly client: DynamoDBDocumentClient, private readonly tableName: string) {}

  async mergeInventoryPage(expected: SmugMugConnection, collections: SmugMugRemoteCollection[], images: SmugMugRemoteImage[]) {
    validateInventoryPageWrite(expected, collections, images);
    const records = new Map<string, { entityType: string; value: SmugMugRemoteCollection | SmugMugRemoteImage }>([
      ...collections.map(value => [`COLLECTION#${value.remoteId}`, { entityType: 'SMUGMUG_EXTERNAL_COLLECTION', value }] as const),
      ...images.map(value => [`IMAGE#${value.remoteId}`, { entityType: 'SMUGMUG_REMOTE_IMAGE', value }] as const)
    ]);
    const rows = [...records.entries()];
    // Reserve one transaction operation for the connection fence. Retrying a
    // partial page repeats upserts only while the same checkpoint is current.
    for (let offset = 0; offset < Math.max(1, rows.length); offset += 24) {
      try {
        await this.client.send(new TransactWriteCommand({ TransactItems: [
          { ConditionCheck: { TableName: this.tableName, Key: { PK: `SMUGMUG_CONNECTION#${expected.id}`, SK: 'PROFILE' },
            ConditionExpression: '#value = :expected', ExpressionAttributeNames: { '#value': 'value' }, ExpressionAttributeValues: { ':expected': expected } } },
          ...rows.slice(offset, offset + 24).map(([SK, record]) => ({ Put: { TableName: this.tableName, Item: { PK: `SMUGMUG_CONNECTION#${expected.inventoryScopeId}`, SK, ...record } } }))
        ] }));
      } catch (error) {
        const failure = error as { name?: string; CancellationReasons?: Array<{ Code?: string }> };
        if (failure.name === 'TransactionCanceledException' && failure.CancellationReasons?.some(reason => reason.Code === 'ConditionalCheckFailed')
          && failure.CancellationReasons.every(reason => !reason.Code || ['None', 'ConditionalCheckFailed'].includes(reason.Code))) throw new SmugMugError('INVENTORY_WRITE_CONFLICT', 409);
        throw error;
      }
    }
  }

  async putConnectionIfUnchanged(value: SmugMugConnection, expected: SmugMugConnection) {
    validateConnectionCheckpoint(value, expected);
    try {
      await this.client.send(new PutCommand({ TableName: this.tableName,
        Item: { PK: `SMUGMUG_CONNECTION#${value.id}`, SK: 'PROFILE', entityType: 'SMUGMUG_CONNECTION', value },
        ConditionExpression: '#value = :expected', ExpressionAttributeNames: { '#value': 'value' }, ExpressionAttributeValues: { ':expected': expected }
      }));
      return true;
    } catch (error) {
      if ((error as { name?: string }).name === 'ConditionalCheckFailedException') return false;
      throw error;
    }
  }

  async completeInventory(connection: SmugMugConnection, expected: SmugMugConnection, migration: SmugMugMigration) {
    validateInventoryCompletion(connection, expected, migration);
    try {
      await this.client.send(new TransactWriteCommand({ TransactItems: [
        { Put: { TableName: this.tableName, Item: { PK: `SMUGMUG_CONNECTION#${connection.id}`, SK: 'PROFILE', entityType: 'SMUGMUG_CONNECTION', value: connection },
          ConditionExpression: '#value = :expected', ExpressionAttributeNames: { '#value': 'value' }, ExpressionAttributeValues: { ':expected': expected } } },
        { Put: { TableName: this.tableName, Item: { PK: `SMUGMUG_MIGRATION#${migration.id}`, SK: 'PROFILE', entityType: 'SMUGMUG_MIGRATION', value: migration }, ConditionExpression: 'attribute_not_exists(PK)' } },
        { Put: { TableName: this.tableName, Item: { PK: `SMUGMUG_MIGRATIONS#${connection.id}`, SK: `MIGRATION#${migration.id}`, entityType: 'SMUGMUG_MIGRATION_INDEX', value: { migrationId: migration.id } }, ConditionExpression: 'attribute_not_exists(PK)' } }
      ] }));
      return true;
    } catch (error) {
      const failure = error as { name?: string; CancellationReasons?: Array<{ Code?: string }> };
      if (failure.name === 'TransactionCanceledException' && failure.CancellationReasons?.some(reason => reason.Code === 'ConditionalCheckFailed')
        && failure.CancellationReasons.every(reason => !reason.Code || ['None', 'ConditionalCheckFailed'].includes(reason.Code))) return false;
      throw error;
    }
  }

  private async put(PK: string, SK: string, entityType: string, value: unknown) {
    await this.client.send(new PutCommand({ TableName: this.tableName, Item: { PK, SK, entityType, value } }));
  }
  async putMigrationIfUnchanged(value: SmugMugMigration, expected: SmugMugMigration) {
    if (value.id !== expected.id) throw new Error('Migration identity mismatch.');
    try {
      await this.client.send(new PutCommand({ TableName: this.tableName,
        Item: { PK: `SMUGMUG_MIGRATION#${value.id}`, SK: 'PROFILE', entityType: 'SMUGMUG_MIGRATION', value },
        ConditionExpression: '#value = :expected', ExpressionAttributeNames: { '#value': 'value' }, ExpressionAttributeValues: { ':expected': expected }
      }));
      return true;
    } catch (error) {
      if ((error as { name?: string }).name === 'ConditionalCheckFailedException') return false;
      throw error;
    }
  }
  async putItemIfAbsent(id: string, value: SmugMugMigrationItem) {
    if (value.migrationId !== id) throw new Error('Migration item identity mismatch.');
    const PK = `SMUGMUG_MIGRATION#${id}`, SK = `ITEM#${value.remoteId}`;
    try {
      await this.client.send(new PutCommand({ TableName: this.tableName, Item: { PK, SK, entityType: 'SMUGMUG_MIGRATION_ITEM', value }, ConditionExpression: 'attribute_not_exists(PK)' }));
    } catch (error) {
      if ((error as { name?: string }).name !== 'ConditionalCheckFailedException') throw error;
      const existing = await this.get<SmugMugMigrationItem>(PK, SK, true);
      if (!existing || existing.migrationId !== id || existing.remoteId !== value.remoteId || existing.idempotencyKey !== value.idempotencyKey) throw new Error('Migration item initialization conflict.');
    }
  }
  private async get<T>(PK: string, SK: string, ConsistentRead = false): Promise<T | undefined> {
    const response = await this.client.send(new GetCommand({ TableName: this.tableName, Key: { PK, SK }, ConsistentRead }));
    return response.Item?.value as T | undefined;
  }
  private async list<T>(PK: string, prefix: string, ConsistentRead = false): Promise<T[]> {
    const values: T[] = [];
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const response = await this.client.send(new QueryCommand({
        TableName: this.tableName, KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: { ':pk': PK, ':sk': prefix }, ExclusiveStartKey, ConsistentRead
      }));
      values.push(...(response.Items || []).map((item) => item.value as T));
      ExclusiveStartKey = response.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return values;
  }
  private async putAll<T>(values: T[], write: (value: T) => Promise<void>) {
    for (let offset = 0; offset < values.length; offset += 20) await Promise.all(values.slice(offset, offset + 20).map(write));
  }

  async putConnection(value: SmugMugConnection) {
    const records = [
      { PK: `SMUGMUG_CONNECTION#${value.id}`, SK: 'PROFILE', entityType: 'SMUGMUG_CONNECTION', value },
      { PK: `SMUGMUG_OAUTH_STATE#${value.oauthState}`, SK: 'CONNECTION', entityType: 'SMUGMUG_OAUTH_STATE', value: { connectionId: value.id } },
      { PK: this.connectionIndex(value.userId, value.creatorId), SK: `CONNECTION#${value.id}`, entityType: 'SMUGMUG_CONNECTION_INDEX', value: { connectionId: value.id } }
    ];
    await this.client.send(new TransactWriteCommand({ TransactItems: records.map(Item => ({ Put: { TableName: this.tableName, Item } })) }));
  }
  private connectionIndex(userId: string, creatorId: string) {
    if (![userId, creatorId].every(value => typeof value === 'string' && value.trim())) throw new Error('Invalid connection index identity.');
    return `SMUGMUG_CONNECTIONS#${Buffer.from(JSON.stringify([userId, creatorId])).toString('base64url')}`;
  }
  async listConnectionPage(userId: string, creatorId: string, limit: number, afterId?: string) {
    validateSmugMugItemPage(limit, afterId);
    const PK = this.connectionIndex(userId, creatorId);
    const response = await this.client.send(new QueryCommand({ TableName: this.tableName, Limit: limit, ConsistentRead: true,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)', ExpressionAttributeValues: { ':pk': PK, ':sk': 'CONNECTION#' },
      ...(afterId === undefined ? {} : { ExclusiveStartKey: { PK, SK: `CONNECTION#${afterId}` } }) }));
    const ids = (response.Items || []).map(item => {
      const id = item.value?.connectionId;
      if (typeof id !== 'string' || !id || item.SK !== `CONNECTION#${id}`) throw new Error('Invalid connection index record.');
      return id;
    });
    const records = await Promise.all(ids.map(id => this.getConnection(id)));
    const items = records.filter((value, index): value is SmugMugConnection => Boolean(value && value.id === ids[index] && value.userId === userId && value.creatorId === creatorId));
    const key = response.LastEvaluatedKey;
    if (key && (key.PK !== PK || typeof key.SK !== 'string' || !key.SK.startsWith('CONNECTION#') || !key.SK.slice(11))) throw new Error('Invalid connection continuation.');
    return { items, ...(key ? { nextAfterConnectionId: (key.SK as string).slice(11) } : {}), legacyLookupMayBeRequired: true };
  }
  getConnection(id: string) { return this.get<SmugMugConnection>(`SMUGMUG_CONNECTION#${id}`, 'PROFILE', true); }
  async findAuthorizingConnection(state: string) {
    const lookup = await this.get<{ connectionId: string }>(`SMUGMUG_OAUTH_STATE#${state}`, 'CONNECTION');
    const connection = lookup ? await this.getConnection(lookup.connectionId) : undefined;
    return connection?.state === 'AUTHORIZING' && connection.oauthState === state ? connection : undefined;
  }
  async claimOAuth(connection: SmugMugConnection, now: number) {
    if (!isSmugMugOAuthClaimable(connection, now)) return false;
    try {
      await this.client.send(new TransactWriteCommand({ TransactItems: [
        { ConditionCheck: { TableName: this.tableName, Key: { PK: `SMUGMUG_CONNECTION#${connection.id}`, SK: 'PROFILE' },
          ConditionExpression: '#value = :expected', ExpressionAttributeNames: { '#value': 'value' }, ExpressionAttributeValues: { ':expected': connection } } },
        { Put: { TableName: this.tableName, Item: { PK: `SMUGMUG_OAUTH_USED#${connection.oauthState}`, SK: 'CLAIM', entityType: 'SMUGMUG_OAUTH_USED', claimedAt: now },
          ConditionExpression: 'attribute_not_exists(PK)' } }
      ] }));
      return true;
    } catch (error) {
      const failure = error as { name?: string; CancellationReasons?: Array<{ Code?: string }> };
      if (failure.name === 'TransactionCanceledException' && failure.CancellationReasons?.some(reason => reason.Code === 'ConditionalCheckFailed')
        && failure.CancellationReasons.every(reason => reason.Code === 'None' || reason.Code === 'ConditionalCheckFailed')) return false;
      throw error;
    }
  }
  async putMigration(value: SmugMugMigration) {
    const records = [
      { PK: `SMUGMUG_MIGRATION#${value.id}`, SK: 'PROFILE', entityType: 'SMUGMUG_MIGRATION', value },
      { PK: `SMUGMUG_MIGRATIONS#${value.connectionId}`, SK: `MIGRATION#${value.id}`, entityType: 'SMUGMUG_MIGRATION_INDEX', value: { migrationId: value.id } }
    ];
    await this.client.send(new TransactWriteCommand({ TransactItems: records.map(Item => ({ Put: { TableName: this.tableName, Item } })) }));
  }
  getMigration(id: string) { return this.get<SmugMugMigration>(`SMUGMUG_MIGRATION#${id}`, 'PROFILE', true); }
  async listMigrationPage(connectionId: string, limit: number, afterId?: string) {
    validateSmugMugItemPage(limit, afterId);
    const PK = `SMUGMUG_MIGRATIONS#${connectionId}`;
    const response = await this.client.send(new QueryCommand({ TableName: this.tableName, Limit: limit, ConsistentRead: true,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)', ExpressionAttributeValues: { ':pk': PK, ':sk': 'MIGRATION#' },
      ...(afterId === undefined ? {} : { ExclusiveStartKey: { PK, SK: `MIGRATION#${afterId}` } }) }));
    const ids = (response.Items || []).map(item => {
      const id = item.value?.migrationId;
      if (typeof id !== 'string' || !id || item.SK !== `MIGRATION#${id}`) throw new Error('Invalid migration index record.');
      return id;
    });
    const records = await Promise.all(ids.map(id => this.getMigration(id)));
    const items = records.filter((value, index): value is SmugMugMigration => Boolean(value && value.id === ids[index] && value.connectionId === connectionId));
    const key = response.LastEvaluatedKey;
    if (key && (key.PK !== PK || typeof key.SK !== 'string' || !key.SK.startsWith('MIGRATION#') || !key.SK.slice(10))) throw new Error('Invalid migration continuation.');
    return { items, ...(key ? { nextAfterMigrationId: (key.SK as string).slice(10) } : {}), legacyLookupMayBeRequired: true };
  }
  async mergeCollections(id: string, values: SmugMugRemoteCollection[]) { await this.putAll(values, (value) => this.put(`SMUGMUG_CONNECTION#${id}`, `COLLECTION#${value.remoteId}`, 'SMUGMUG_EXTERNAL_COLLECTION', value)); }
  getCollections(id: string) { return this.list<SmugMugRemoteCollection>(`SMUGMUG_CONNECTION#${id}`, 'COLLECTION#'); }
  async getCollectionPage(id: string, limit: number, afterRemoteId?: string) {
    validateSmugMugItemPage(limit, afterRemoteId);
    const PK = `SMUGMUG_CONNECTION#${id}`;
    const response = await this.client.send(new QueryCommand({ TableName: this.tableName,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)', ExpressionAttributeValues: { ':pk': PK, ':sk': 'COLLECTION#' },
      Limit: limit, ConsistentRead: true, ...(afterRemoteId === undefined ? {} : { ExclusiveStartKey: { PK, SK: `COLLECTION#${afterRemoteId}` } }) }));
    const items = (response.Items || []).map(item => item.value as SmugMugRemoteCollection);
    const key = response.LastEvaluatedKey;
    if (key && (key.PK !== PK || typeof key.SK !== 'string' || !key.SK.startsWith('COLLECTION#') || !key.SK.slice(11))) throw new Error('Invalid SmugMug collection continuation.');
    return { items, ...(key ? { nextAfterRemoteId: (key.SK as string).slice(11) } : {}) };
  }
  getCollection(id: string, remoteId: string) { return this.get<SmugMugRemoteCollection>(`SMUGMUG_CONNECTION#${id}`, `COLLECTION#${remoteId}`, true); }
  async mergeImages(id: string, values: SmugMugRemoteImage[]) { await this.putAll(values, (value) => this.put(`SMUGMUG_CONNECTION#${id}`, `IMAGE#${value.remoteId}`, 'SMUGMUG_REMOTE_IMAGE', value)); }
  getImages(id: string) { return this.list<SmugMugRemoteImage>(`SMUGMUG_CONNECTION#${id}`, 'IMAGE#'); }
  async getImagePage(id: string, limit: number, afterRemoteId?: string) {
    validateSmugMugItemPage(limit, afterRemoteId);
    const PK = `SMUGMUG_CONNECTION#${id}`;
    const response = await this.client.send(new QueryCommand({ TableName: this.tableName,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)', ExpressionAttributeValues: { ':pk': PK, ':sk': 'IMAGE#' },
      Limit: limit, ConsistentRead: true, ...(afterRemoteId === undefined ? {} : { ExclusiveStartKey: { PK, SK: `IMAGE#${afterRemoteId}` } }) }));
    const items = (response.Items || []).map(item => item.value as SmugMugRemoteImage);
    const key = response.LastEvaluatedKey;
    if (key && (key.PK !== PK || typeof key.SK !== 'string' || !key.SK.startsWith('IMAGE#') || !key.SK.slice(6))) throw new Error('Invalid SmugMug image continuation.');
    return { items, ...(key ? { nextAfterRemoteId: (key.SK as string).slice(6) } : {}) };
  }
  getImage(id: string, remoteId: string) { return this.get<SmugMugRemoteImage>(`SMUGMUG_CONNECTION#${id}`, `IMAGE#${remoteId}`, true); }
  async putItems(id: string, values: SmugMugMigrationItem[]) { await this.putAll(values, (value) => this.put(`SMUGMUG_MIGRATION#${id}`, `ITEM#${value.remoteId}`, 'SMUGMUG_MIGRATION_ITEM', value)); }
  async putItem(id: string, value: SmugMugMigrationItem) {
    if (value.migrationId !== id) throw new Error('Migration item identity mismatch.');
    await this.put(`SMUGMUG_MIGRATION#${id}`, `ITEM#${value.remoteId}`, 'SMUGMUG_MIGRATION_ITEM', value);
  }
  getItems(id: string) { return this.list<SmugMugMigrationItem>(`SMUGMUG_MIGRATION#${id}`, 'ITEM#', true); }
  async getItemPage(id: string, limit: number, afterRemoteId?: string) {
    validateSmugMugItemPage(limit, afterRemoteId);
    const PK = `SMUGMUG_MIGRATION#${id}`;
    const response = await this.client.send(new QueryCommand({ TableName: this.tableName,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)', ExpressionAttributeValues: { ':pk': PK, ':sk': 'ITEM#' },
      Limit: limit, ConsistentRead: true, ...(afterRemoteId === undefined ? {} : { ExclusiveStartKey: { PK, SK: `ITEM#${afterRemoteId}` } }) }));
    const items = (response.Items || []).map(item => item.value as SmugMugMigrationItem);
    const key = response.LastEvaluatedKey;
    if (key && (key.PK !== PK || typeof key.SK !== 'string' || !key.SK.startsWith('ITEM#') || !key.SK.slice(5))) throw new Error('Invalid SmugMug item continuation.');
    return { items, ...(key ? { nextAfterRemoteId: (key.SK as string).slice(5) } : {}) };
  }
}
