import {validateUbeeqWorkPageOptions,ubeeqWorkSortKey,type UbeeqWorkPageOptions,type UbeeqWorkPage,type RetainedCreatorContentModels,type CreatorContentStore,type CreatorContentAssetCommit,type CreatorContentRestore,type CreatorContentRestoreReceipt,type PublicationCopyRepository,type PublicationOperationRepository,validateCopyCreation,validateCopyOperation,assertCopyIdentityUnchanged,PublicationCopyConflict,type CopyCreation,type PublicationClaim,CreatorContentCommitError} from '@ubeeq/persistence';
import type {GetCommandInput,GetCommandOutput,QueryCommandInput,QueryCommandOutput,PutCommandInput,DeleteCommandInput,TransactWriteCommandInput} from '@aws-sdk/lib-dynamodb';
export interface RetainedContentTransport {
 get(input:GetCommandInput):Promise<GetCommandOutput>;query(input:QueryCommandInput):Promise<QueryCommandOutput>;
 put(input:PutCommandInput):Promise<unknown>;delete(input:DeleteCommandInput):Promise<unknown>;transactWrite(input:TransactWriteCommandInput):Promise<unknown>;
}
type Writes=NonNullable<TransactWriteCommandInput['TransactItems']>;
export type RetainedAssetCommit<M extends RetainedCreatorContentModels>=CreatorContentAssetCommit<M>&{
 replacement?:{previousAsset:M['asset']};
 sourceFileGuard?:{file:{fileId:string;creatorId:string;uploadState?:string;restricted?:boolean;premium?:boolean;storageKey:string};access:{actorUserId:string;isAdmin:boolean;expectedRole?:unknown;expectedMember?:{userId:string;creatorId:string;role:string;createdAt:string}|null}};
};
export interface RetainedContentBindings<M extends RetainedCreatorContentModels,R extends CreatorContentRestore<M>,A extends RetainedAssetCommit<M>> {
 getRestore(table:string,tenantId:string,restoreId:string):Promise<CreatorContentRestoreReceipt|null>;
 commitRestore(table:string,input:R):Promise<CreatorContentRestoreReceipt>;
 aliasWrites(table:string,item:Record<string,unknown>):Writes;
 validateAssetAttachment(input:A):void;
 validateDisclosureHistory(previous:M['publication']|null,next:M['publication']):void;
 validatePublicationProjection(previous:M['publication']|null,next:M['publication']):void;
}
const clean = <T>(item: Record<string, unknown>): T => {
  const value = { ...item };
  for (const key of ['PK', 'SK', 'GSI1PK', 'GSI1SK', 'GSI2PK', 'GSI2SK', 'entityType', 'contentRestoreId', 'contentRestoreTenant']) delete value[key];
  return value as T;
};

const tenantPrefix = (tenantId: string): string => `TENANT#${tenantId}`;

export class DynamoRetainedCreatorContent<M extends RetainedCreatorContentModels,R extends CreatorContentRestore<M>,A extends RetainedAssetCommit<M>> implements CreatorContentStore<M>,PublicationCopyRepository<M['publication']>,PublicationOperationRepository<M['publication']> {
  getContentRestore(tenantId: string, restoreId: string) { return this.bindings.getRestore(this.tableName, tenantId, restoreId); }
  commitProductContentRestore(input:R) { return this.bindings.commitRestore(this.tableName, input); }
  private async visible<T>(items: Record<string, any>[]): Promise<T[]> {
    const completed = new Map<string, boolean>();
    for (const item of items) if (item.contentRestoreId) {
      const key = JSON.stringify([item.contentRestoreTenant, item.contentRestoreId]);
      if (!completed.has(key)) completed.set(key, Boolean(await this.getContentRestore(item.contentRestoreTenant, item.contentRestoreId)));
    }
    return items.filter(item => !item.contentRestoreId || completed.get(JSON.stringify([item.contentRestoreTenant, item.contentRestoreId]))).map(item => clean<T>(item));
  }
  constructor(
    private readonly client: RetainedContentTransport,
    private readonly tableName: string,
    private readonly bindings:RetainedContentBindings<M,R,A>
  ) {
    for(const key of ['get','query','put','delete','transactWrite'] as const)if(typeof client?.[key]!=='function')throw Error('Retained content storage requires its actual transport.');
    for(const key of ['getRestore','commitRestore','aliasWrites','validateAssetAttachment','validateDisclosureHistory','validatePublicationProjection'] as const)if(typeof bindings?.[key]!=='function')throw Error('Retained content storage requires its actual host bindings.');
  }

  private async commitCreatorWrite(creatorId: string,
    writes: NonNullable<TransactWriteCommandInput['TransactItems']>): Promise<void> {
    try {
      await this.client.transactWrite({ TransactItems: [...writes, { ConditionCheck: {
        TableName: this.tableName, Key: { PK: `CREATOR#${creatorId}`, SK: 'PROFILE' },
        ConditionExpression: '#creator = :creator AND attribute_not_exists(#deletion)',
        ExpressionAttributeNames: { '#creator': 'creatorId', '#deletion': 'deletion' },
        ExpressionAttributeValues: { ':creator': creatorId }
      } }] });
    } catch (error) {
      const failure = error as { name?: string; CancellationReasons?: Array<{ Code?: string }> };
      if (failure.name === 'TransactionCanceledException' && failure.CancellationReasons?.some(reason => reason.Code === 'ConditionalCheckFailed')) {
        throw new CreatorContentCommitError('Content or Creator lifecycle changed; refresh before retrying.');
      }
      throw error;
    }
  }

  private async restoreWriteGuard(PK: unknown, SK: unknown) {
    const existing = (await this.client.get({ TableName: this.tableName, Key: { PK, SK }, ConsistentRead: true })).Item;
    if (existing?.contentRestoreId && !await this.getContentRestore(existing.contentRestoreTenant, existing.contentRestoreId))
      throw new CreatorContentCommitError('Content is reserved by an unfinished restore.');
    return { condition: existing?.contentRestoreId ? 'contentRestoreId = :restore' : 'attribute_not_exists(contentRestoreId)',
      values: existing?.contentRestoreId ? { ':restore': existing.contentRestoreId } : {} };
  }

  private async put(input:object): Promise<void> {
    const item:Record<string,unknown>=Object.fromEntries(Object.entries(input));
    const guard = await this.restoreWriteGuard(item.PK, item.SK);
    const write = { TableName: this.tableName, Item: item, ConditionExpression: guard.condition,
      ...(Object.keys(guard.values).length ? { ExpressionAttributeValues: guard.values } : {}) };
    if (typeof item.creatorId === 'string') {
      await this.commitCreatorWrite(item.creatorId, [{ Put: write }, ...this.bindings.aliasWrites(this.tableName, item)]);
      return;
    }
    await this.client.put(write);
  }

  private async get<T>(PK: string, SK: string): Promise<T | null> {
    const result = await this.client.get({ TableName: this.tableName, Key: { PK, SK }, ConsistentRead: true });
    return result.Item ? (await this.visible<T>([result.Item]))[0] || null : null;
  }

  private async list<T>(PK: string, prefix: string, entityType: string): Promise<T[]> {
    const items: T[] = [];
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const result = await this.client.query({
        TableName: this.tableName,
        ConsistentRead: true,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: { ':pk': PK, ':sk': prefix },
        ExclusiveStartKey
      });
      items.push(...await this.visible<T>((result.Items || []).filter((item) => item.entityType === entityType)));
      ExclusiveStartKey = result.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return items;
  }

  private async listIndex<T>(key: string, prefix: string, entityType: string): Promise<T[]> {
    const items: T[] = [];
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const result = await this.client.query({
        TableName: this.tableName,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :sk)',
        ExpressionAttributeValues: { ':pk': key, ':sk': prefix },
        ExclusiveStartKey
      });
      items.push(...await this.visible<T>((result.Items || []).filter((item) => item.entityType === entityType)));
      ExclusiveStartKey = result.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return items;
  }

  private async listIndex2<T>(key: string, prefix: string, entityType: string): Promise<T[]> {
    const items: T[] = [];
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const result = await this.client.query({
        TableName: this.tableName,
        IndexName: 'GSI2',
        KeyConditionExpression: 'GSI2PK = :pk AND begins_with(GSI2SK, :sk)',
        ExpressionAttributeValues: { ':pk': key, ':sk': prefix },
        ExclusiveStartKey
      });
      items.push(...await this.visible<T>((result.Items || []).filter((item) => item.entityType === entityType)));
      ExclusiveStartKey = result.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return items;
  }

  async listUbeeqWorksPage(tenantId: string, creatorId: string, options: UbeeqWorkPageOptions): Promise<UbeeqWorkPage<M['work']>> {
    validateUbeeqWorkPageOptions(options);
    const indexKey = `${tenantPrefix(tenantId)}#CREATOR_WORK#${creatorId}`;
    const result = await this.client.query({ TableName: this.tableName, IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :sk)',
      ExpressionAttributeValues: { ':pk': indexKey, ':sk': 'WORK#' }, Limit: options.limit,
      ...(options.after ? { ExclusiveStartKey: { PK: `${tenantPrefix(tenantId)}#WORK#${options.after.workId}`, SK: 'PROFILE',
        GSI1PK: indexKey, GSI1SK: ubeeqWorkSortKey(options.after) } } : {})
    });
    // GSI rows are eventually consistent; reload authoritative Work records so
    // a stale index cannot expose a deleted/transferred or unfinished-restore Work.
    const current:Array<M['work']|null> = await Promise.all((result.Items || []).filter(item => item.entityType === 'WORK')
      .map(item => this.getWork(tenantId, String(item.workId))));
    const rows = current.filter((item): item is M['work'] => item !== null);
    const key = result.LastEvaluatedKey;
    const workId = key ? String(key.PK).slice(`${tenantPrefix(tenantId)}#WORK#`.length) : undefined;
    const updatedAt = key && workId ? String(key.GSI1SK).slice('WORK#'.length, -(workId.length + 1)) : undefined;
    return { items: rows.filter(work => work.tenantId === tenantId && work.creatorId === creatorId && work.status !== 'deleted'),
      ...(workId && updatedAt ? { next: { workId, updatedAt } } : {}) };
  }

  async listWorksByCreator(tenantId: string, creatorId: string): Promise<M['work'][]> {
    const items = await this.listIndex<M['work']>(`${tenantPrefix(tenantId)}#CREATOR_WORK#${creatorId}`, 'WORK#', 'WORK');
    return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getWork(tenantId: string, workId: string): Promise<M['work'] | null> {
    return this.get(`${tenantPrefix(tenantId)}#WORK#${workId}`, 'PROFILE');
  }

  async createWork(work: M['work']): Promise<void> {
    await this.put({
      PK: `${tenantPrefix(work.tenantId)}#WORK#${work.workId}`,
      SK: 'PROFILE',
      GSI1PK: `${tenantPrefix(work.tenantId)}#CREATOR_WORK#${work.creatorId}`,
      GSI1SK: `WORK#${work.updatedAt}#${work.workId}`,
      GSI2PK: `${tenantPrefix(work.tenantId)}#WORK_SLUG#${work.creatorId}`,
      GSI2SK: `SLUG#${work.slug}`,
      entityType: 'WORK',
      ...work
    });
  }

  async createWorkIfAbsent(work: M['work']): Promise<boolean> {
    try {
      await this.commitCreatorWrite(work.creatorId, [{ Put: { TableName: this.tableName, Item: {
        PK: `${tenantPrefix(work.tenantId)}#WORK#${work.workId}`, SK: 'PROFILE',
        GSI1PK: `${tenantPrefix(work.tenantId)}#CREATOR_WORK#${work.creatorId}`, GSI1SK: `WORK#${work.updatedAt}#${work.workId}`,
        GSI2PK: `${tenantPrefix(work.tenantId)}#WORK_SLUG#${work.creatorId}`, GSI2SK: `SLUG#${work.slug}`, entityType: 'WORK', ...work
      }, ConditionExpression: 'attribute_not_exists(PK)' } }]); return true;
    } catch (error) { if (error instanceof CreatorContentCommitError && await this.getWork(work.tenantId, work.workId)) return false; throw error; }
  }

  async updateWork(work: M['work']): Promise<void> {
    await this.createWork(work);
  }
  async commitWorkRevision(work: M['work'], expectedRevision: number): Promise<void> {
    if (work.revision !== expectedRevision + 1) throw new CreatorContentCommitError('Invalid Work revision increment.');
    try {
      const guard = await this.restoreWriteGuard(`${tenantPrefix(work.tenantId)}#WORK#${work.workId}`, 'PROFILE');
      await this.commitCreatorWrite(work.creatorId, [{ Put: { TableName: this.tableName, Item: {
        PK: `${tenantPrefix(work.tenantId)}#WORK#${work.workId}`, SK: 'PROFILE',
        GSI1PK: `${tenantPrefix(work.tenantId)}#CREATOR_WORK#${work.creatorId}`,
        GSI1SK: `WORK#${work.updatedAt}#${work.workId}`, GSI2PK: `${tenantPrefix(work.tenantId)}#WORK_SLUG#${work.creatorId}`,
        GSI2SK: `SLUG#${work.slug}`, entityType: 'WORK', ...work
      }, ConditionExpression: '#revision = :previous AND creatorId = :creator AND tenantId = :tenant AND ' + guard.condition,
      ExpressionAttributeNames: { '#revision': 'revision' },
      ExpressionAttributeValues: { ':previous': expectedRevision, ':creator': work.creatorId, ':tenant': work.tenantId, ...guard.values } } },
        ...this.bindings.aliasWrites(this.tableName, Object.fromEntries(Object.entries({ ...work, entityType: 'WORK' })))]);
    } catch (error) {
      if ((error as { name?: string }).name === 'ConditionalCheckFailedException') throw new CreatorContentCommitError('Work changed before this revision could be committed.');
      throw error;
    }
  }

  async commitSharedWorkRevisions(changes:Array<{work:M['work'];expectedRevision:number}>):Promise<void>{
    if(!changes.length||changes.length>99)throw new CreatorContentCommitError('Choose at most 99 linked Works.');
    const creatorId=changes[0].work.creatorId,tenantId=changes[0].work.tenantId,ids=new Set<string>();
    const writes:NonNullable<TransactWriteCommandInput['TransactItems']>=[];
    for(const {work,expectedRevision} of changes){
      if(ids.has(work.workId)||work.creatorId!==creatorId||work.tenantId!==tenantId||work.revision!==expectedRevision+1)throw new CreatorContentCommitError('Invalid linked Work revision.');
      ids.add(work.workId);
      const guard=await this.restoreWriteGuard(`${tenantPrefix(tenantId)}#WORK#${work.workId}`,'PROFILE');
      writes.push({Put:{TableName:this.tableName,Item:{PK:`${tenantPrefix(tenantId)}#WORK#${work.workId}`,SK:'PROFILE',GSI1PK:`${tenantPrefix(tenantId)}#CREATOR_WORK#${creatorId}`,GSI1SK:`WORK#${work.updatedAt}#${work.workId}`,GSI2PK:`${tenantPrefix(tenantId)}#WORK_SLUG#${creatorId}`,GSI2SK:`SLUG#${work.slug}`,entityType:'WORK',...work},ConditionExpression:'#revision = :previous AND creatorId = :creator AND tenantId = :tenant AND slug = :slug AND slugHistory = :history AND '+guard.condition,ExpressionAttributeNames:{'#revision':'revision'},ExpressionAttributeValues:{':previous':expectedRevision,':creator':creatorId,':tenant':tenantId,':slug':work.slug,':history':work.slugHistory,...guard.values}}});
    }
    if(Buffer.byteLength(JSON.stringify(writes))>3_500_000)throw new CreatorContentCommitError('These linked Works exceed the transaction size. Link a smaller group.');
    await this.commitCreatorWrite(creatorId,writes);
  }

  async listCanonicalAssetsByWork(tenantId: string, workId: string): Promise<Array<M['asset'] & { attachment: M['attachment'] }>> {
    const attachments = (await this.list<M['attachment']>(`${tenantPrefix(tenantId)}#WORK#${workId}`, 'ASSET#', 'WORK_ASSET'))
      .sort((a, b) => a.position - b.position);
    const assets:Array<(M['asset']&{attachment:M['attachment'];replacedByAssetId?:string})|null> = await Promise.all(attachments.map(async (attachment) => {
      const asset = await this.getCanonicalAsset(tenantId, attachment.assetId);
      return asset ? { ...asset,...(attachment.replacedByAssetId?{replacedByAssetId:attachment.replacedByAssetId}:{}), attachment } : null;
    }));
    return assets.filter((asset): asset is M['asset'] & { attachment: M['attachment'] } => Boolean(asset));
  }

  async getCanonicalAsset(tenantId: string, assetId: string): Promise<M['asset'] | null> {
    return this.get(`${tenantPrefix(tenantId)}#ASSET#${assetId}`, 'PROFILE');
  }

  async listCanonicalAssetsByCreator(tenantId: string, creatorId: string): Promise<M['asset'][]> {
    const assets = await this.listIndex<M['asset']>(`${tenantPrefix(tenantId)}#CREATOR_ASSET#${creatorId}`, 'ASSET#', 'CANONICAL_ASSET');
    if (assets.some(asset => asset.tenantId !== tenantId || asset.creatorId !== creatorId)) throw new Error('Invalid creator asset inventory scope.');
    return assets;
  }

  async createCanonicalAsset(asset: M['asset']): Promise<void> {
    await this.put({
      PK: `${tenantPrefix(asset.tenantId)}#ASSET#${asset.assetId}`,
      SK: 'PROFILE',
      GSI1PK: `${tenantPrefix(asset.tenantId)}#CREATOR_ASSET#${asset.creatorId}`,
      GSI1SK: `ASSET#${asset.updatedAt}#${asset.assetId}`,
      entityType: 'CANONICAL_ASSET',
      ...asset
    });
  }

  async commitAssetAttachment(input: A): Promise<void> {
    const {previousRevision,work,asset,attachment,sourceFileGuard,replacement}=input;
    this.bindings.validateAssetAttachment(input);
    if (work.revision !== previousRevision + 1 || asset.tenantId !== work.tenantId || asset.creatorId !== work.creatorId ||
      attachment.workId !== work.workId || attachment.assetId !== asset.assetId || !Number.isSafeInteger(attachment.position) || attachment.position < 0) {
      throw new CreatorContentCommitError('Invalid asset attachment scope or revision.');
    }
    const guards: NonNullable<TransactWriteCommandInput['TransactItems']> = [];
    if (sourceFileGuard) {
      const { file, access } = sourceFileGuard;
      if (file.creatorId !== work.creatorId || file.uploadState !== 'ready' || file.restricted || file.premium || asset.storage.objectKey !== file.storageKey
        || !access.actorUserId || (!access.isAdmin && (!access.expectedMember || access.expectedMember.userId !== access.actorUserId
          || access.expectedMember.creatorId !== file.creatorId || !['owner', 'admin', 'manager', 'editor'].includes(access.expectedMember.role)))) throw new CreatorContentCommitError('Invalid original attachment.');
      const names: Record<string, string> = {}, values: Record<string, unknown> = {};
      const fields = ['revision', 'uploadState', 'fileId', 'creatorId', 'sourceKind', 'mimeType', 'storageKey', 'sizeBytes', 'checksumSha256', 'restricted', 'premium', 'downloadable'];
      const conditions = fields.map((field, index) => {
        names[`#f${index}`] = field;
        const value = (file as unknown as Record<string, unknown>)[field];
        if (value === undefined) return `attribute_not_exists(#f${index})`;
        values[`:v${index}`] = value; return `#f${index} = :v${index}`;
      });
      guards.push({ ConditionCheck: { TableName: this.tableName, Key: { PK: `FILE#${file.fileId}`, SK: 'PROFILE' },
        ConditionExpression: conditions.join(' AND '), ExpressionAttributeNames: names, ExpressionAttributeValues: values } });
      guards.push({ ConditionCheck: { TableName: this.tableName, Key: { PK: `USER#${access.actorUserId}`, SK: 'PLATFORM_ROLE' },
        ...(access.expectedRole ? { ConditionExpression: '#assignment = :expected', ExpressionAttributeNames: { '#assignment': 'assignment' }, ExpressionAttributeValues: { ':expected': access.expectedRole } }
          : { ConditionExpression: 'attribute_not_exists(PK)' }) } });
      if (!access.isAdmin) guards.push({ ConditionCheck: { TableName: this.tableName, Key: { PK: `CREATOR#${file.creatorId}`, SK: `MEMBER#USER#${access.actorUserId}` },
        ConditionExpression: '#role = :role AND createdAt = :created', ExpressionAttributeNames: { '#role': 'role' },
        ExpressionAttributeValues: { ':role': access.expectedMember!.role, ':created': access.expectedMember!.createdAt } } });
    }
    const prefix = tenantPrefix(work.tenantId);
    if(replacement){
      const old=replacement.previousAsset;
      guards.push({ConditionCheck:{TableName:this.tableName,Key:{PK:`${prefix}#ASSET#${old.assetId}`,SK:'PROFILE'},ConditionExpression:'checksumSha256 = :checksum AND updatedAt = :updated AND creatorId = :creator AND #status = :ready AND attribute_not_exists(replacedByAssetId) AND attribute_not_exists(deletedAt)',ExpressionAttributeNames:{'#status':'status'},ExpressionAttributeValues:{':checksum':old.checksumSha256,':updated':old.updatedAt,':creator':work.creatorId,':ready':'ready'}}});
      guards.push({Put:{TableName:this.tableName,Item:{PK:`${prefix}#WORK#${work.workId}`,SK:`ASSET#${attachment.position.toString().padStart(8,'0')}#${old.assetId}`,GSI1PK:`${prefix}#ASSET_WORK#${old.assetId}`,GSI1SK:`WORK#${work.workId}`,entityType:'WORK_ASSET',...attachment,assetId:old.assetId,replacedByAssetId:asset.assetId},ConditionExpression:'attribute_exists(PK) AND attribute_not_exists(replacedByAssetId)'}});
    }
    try {
      const guard = await this.restoreWriteGuard(`${prefix}#WORK#${work.workId}`, 'PROFILE');
      await this.commitCreatorWrite(work.creatorId, [
        ...guards,
        { Put: { TableName: this.tableName, Item: {
          PK: `${prefix}#WORK#${work.workId}`, SK: 'PROFILE', GSI1PK: `${prefix}#CREATOR_WORK#${work.creatorId}`,
          GSI1SK: `WORK#${work.updatedAt}#${work.workId}`, GSI2PK: `${prefix}#WORK_SLUG#${work.creatorId}`,
          GSI2SK: `SLUG#${work.slug}`, entityType: 'WORK', ...work
        }, ConditionExpression: '#revision = :previous AND creatorId = :creator AND tenantId = :tenant AND #status <> :deleted AND ' + guard.condition,
        ExpressionAttributeNames: { '#revision': 'revision', '#status': 'status' },
        ExpressionAttributeValues: { ':previous': previousRevision, ':creator': work.creatorId, ':tenant': work.tenantId, ':deleted': 'deleted', ...guard.values } } },
        { Put: { TableName: this.tableName, Item: {
          PK: `${prefix}#ASSET#${asset.assetId}`, SK: 'PROFILE', GSI1PK: `${prefix}#CREATOR_ASSET#${asset.creatorId}`,
          GSI1SK: `ASSET#${asset.updatedAt}#${asset.assetId}`, entityType: 'CANONICAL_ASSET', ...asset
        }, ConditionExpression: 'attribute_not_exists(PK)' } },
        { Put: { TableName: this.tableName, Item: {
          PK: `${prefix}#WORK#${work.workId}`, SK: `ASSET#${attachment.position.toString().padStart(8, '0')}#${attachment.assetId}`,
          GSI1PK: `${prefix}#ASSET_WORK#${asset.assetId}`, GSI1SK: `WORK#${work.workId}`, entityType: 'WORK_ASSET', ...attachment
        }, ConditionExpression: 'attribute_not_exists(PK)' } }
      ]);
    } catch (error) {
      if ((error as { name?: string }).name === 'TransactionCanceledException' &&
        (error as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons?.some((reason) => reason.Code === 'ConditionalCheckFailed')) {
        throw new CreatorContentCommitError('Work changed or uploaded asset already exists.');
      }
      throw error;
    }
  }

  async updateCanonicalAsset(asset: M['asset']): Promise<void> {
    await this.createCanonicalAsset(asset);
  }

  async attachAssetToWork(tenantId: string, attachment: M['attachment']): Promise<void> {
    await this.put({
      PK: `${tenantPrefix(tenantId)}#WORK#${attachment.workId}`,
      SK: `ASSET#${attachment.position.toString().padStart(8, '0')}#${attachment.assetId}`,
      GSI1PK: `${tenantPrefix(tenantId)}#ASSET_WORK#${attachment.assetId}`,
      GSI1SK: `WORK#${attachment.workId}`,
      entityType: 'WORK_ASSET',
      ...attachment
    });
  }

  async detachAssetFromWork(tenantId: string, workId: string, assetId: string): Promise<void> {
    const attachments = await this.list<M['attachment']>(`${tenantPrefix(tenantId)}#WORK#${workId}`, 'ASSET#', 'WORK_ASSET');
    await Promise.all(attachments.filter((item) => item.assetId === assetId).map((item) => this.client.delete({
      TableName: this.tableName,
      Key: {
        PK: `${tenantPrefix(tenantId)}#WORK#${workId}`,
        SK: `ASSET#${item.position.toString().padStart(8, '0')}#${item.assetId}`
      }
    })));
  }

  async listPublicationsByWork(tenantId: string, workId: string): Promise<M['publication'][]> {
    const items = await this.listIndex<M['publication']>(`${tenantPrefix(tenantId)}#WORK_PUBLICATION#${workId}`, 'PUBLICATION#', 'PUBLICATION');
    return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async listPublicationsByDestination(tenantId: string, destination: M['publication']['destination']): Promise<M['publication'][]> {
    const items = await this.listIndex2<M['publication']>(`${tenantPrefix(tenantId)}#DESTINATION_PUBLICATION#${destination}`, 'PUBLICATION#', 'PUBLICATION');
    return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async listPublicationsByIntegrationAccount(tenantId: string, accountId: string): Promise<M['publication'][]> {
    return this.listIndex2<M['publication']>(`${tenantPrefix(tenantId)}#ACCOUNT_PUBLICATION#${accountId}`, 'PUBLICATION#', 'PUBLICATION');
  }

  async getPublication(tenantId: string, publicationId: string): Promise<M['publication'] | null> {
    return this.get(`${tenantPrefix(tenantId)}#PUBLICATION#${publicationId}`, 'PROFILE');
  }

  async getPublicationClaim(tenantId: string, key: string): Promise<PublicationClaim | null> {
    return this.get(`${tenantPrefix(tenantId)}#PUBLICATION_CLAIM#${key}`, 'PROFILE');
  }

  async commitPublicationCopy(input: CopyCreation<M['publication']>): Promise<void> {
    validateCopyCreation(input);
    const { publication: p, request, slot, existing } = structuredClone(input);
    const publicationKey = { PK: `${tenantPrefix(p.tenantId)}#PUBLICATION#${p.publicationId}`, SK: 'PROFILE' };
    const claimItem = (claim: PublicationClaim) => ({ PK: `${tenantPrefix(p.tenantId)}#PUBLICATION_CLAIM#${claim.key}`, SK: 'PROFILE', entityType: 'PUBLICATION_CLAIM', ...claim });
    const claimPut = (claim: PublicationClaim) => ({ Put: { TableName: this.tableName, Item: claimItem(claim), ConditionExpression: 'attribute_not_exists(PK)' } });
    const writes: NonNullable<TransactWriteCommandInput['TransactItems']> = [claimPut(request)];
    if (existing) {
      writes.push({ ConditionCheck: { TableName: this.tableName, Key: { PK: claimItem(slot).PK, SK: 'PROFILE' },
        ConditionExpression: 'publicationId = :id AND fingerprint = :fingerprint', ExpressionAttributeValues: { ':id': p.publicationId, ':fingerprint': slot.fingerprint } } },
        { ConditionCheck: { TableName: this.tableName, Key: publicationKey, ConditionExpression: 'attribute_exists(PK)' } });
    } else {
      writes.push(claimPut(slot), { Put: { TableName: this.tableName,
        Item: { ...publicationKey, ...p, entityType: 'PUBLICATION',
          GSI1PK: `${tenantPrefix(p.tenantId)}#WORK_PUBLICATION#${p.workId}`, GSI1SK: `PUBLICATION#${p.updatedAt}#${p.publicationId}`,
          GSI2PK: p.integrationAccountId ? `${tenantPrefix(p.tenantId)}#ACCOUNT_PUBLICATION#${p.integrationAccountId}` : `${tenantPrefix(p.tenantId)}#DESTINATION_PUBLICATION#${p.destination}`,
          GSI2SK: `PUBLICATION#${p.updatedAt}#${p.publicationId}` }, ConditionExpression: 'attribute_not_exists(PK)' } });
    }
    writes.push({ ConditionCheck: { TableName: this.tableName, Key: { PK: `${tenantPrefix(p.tenantId)}#WORK#${p.workId}`, SK: 'PROFILE' },
      ConditionExpression: 'creatorId = :creator AND #status <> :deleted AND #status <> :archived', ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':creator': p.creatorId, ':deleted': 'deleted', ':archived': 'archived' } } });
    try { await this.commitCreatorWrite(p.creatorId, writes); }
    catch (error) {
      if (error instanceof CreatorContentCommitError) throw new PublicationCopyConflict(error.message);
      throw error;
    }
  }

  async getPublicationOperation(tenantId: string, operationId: string): Promise<import('@ubeeq/core').PublicationOperation | null> {
    return this.get(`${tenantPrefix(tenantId)}#PUBLICATION_OPERATION#${operationId}`, 'PROFILE');
  }

  async commitPublicationOperation(input: import('@ubeeq/persistence').CopyOperationCommit<M['publication']>): Promise<void> {
    validateCopyOperation(input);
    const { previous, next: p, operation, previousOperation, remoteClaim } = structuredClone(input);
    this.bindings.validateDisclosureHistory(previous, p);
    const writes: NonNullable<TransactWriteCommandInput['TransactItems']> = [
      { Put: { TableName: this.tableName,
        Item: { ...p, PK: `${tenantPrefix(p.tenantId)}#PUBLICATION#${p.publicationId}`, SK: 'PROFILE', entityType: 'PUBLICATION',
          GSI1PK: `${tenantPrefix(p.tenantId)}#WORK_PUBLICATION#${p.workId}`, GSI1SK: `PUBLICATION#${p.updatedAt}#${p.publicationId}`,
          GSI2PK: p.integrationAccountId ? `${tenantPrefix(p.tenantId)}#ACCOUNT_PUBLICATION#${p.integrationAccountId}` : `${tenantPrefix(p.tenantId)}#DESTINATION_PUBLICATION#${p.destination}`,
          GSI2SK: `PUBLICATION#${p.updatedAt}#${p.publicationId}` },
        ConditionExpression: 'revision = :previous AND #copy = :identity', ExpressionAttributeNames: { '#copy': 'copy' },
        ExpressionAttributeValues: { ':previous': previous.revision, ':identity': previous.copy } } },
      { Put: { TableName: this.tableName,
        Item: { ...operation, PK: `${tenantPrefix(p.tenantId)}#PUBLICATION_OPERATION#${operation.operationId}`, SK: 'PROFILE', entityType: 'PUBLICATION_OPERATION' },
        ConditionExpression: previousOperation ? '#version = :previous' : 'attribute_not_exists(PK)',
        ...(previousOperation ? { ExpressionAttributeNames: { '#version': 'version' }, ExpressionAttributeValues: { ':previous': previousOperation.version } } : {}) } },
      { ConditionCheck: { TableName: this.tableName, Key: { PK: `${tenantPrefix(p.tenantId)}#WORK#${p.workId}`, SK: 'PROFILE' },
        ConditionExpression: 'creatorId = :creator AND #status <> :deleted AND #status <> :archived' + (operation.state === 'IN_FLIGHT' ? ' AND revision = :source' : ''),
        ExpressionAttributeNames: { '#status': 'status' }, ExpressionAttributeValues: { ':creator': p.creatorId, ':deleted': 'deleted', ':archived': 'archived', ...(operation.state === 'IN_FLIGHT' ? { ':source': operation.sourceRevision } : {}) } } }
    ];
    if (remoteClaim) writes.push({ Put: { TableName: this.tableName,
      Item: { ...remoteClaim, PK: `${tenantPrefix(p.tenantId)}#PUBLICATION_CLAIM#${remoteClaim.key}`, SK: 'PROFILE', entityType: 'PUBLICATION_CLAIM' },
      ConditionExpression: 'attribute_not_exists(PK) OR publicationId = :id', ExpressionAttributeValues: { ':id': p.publicationId } } });
    try { await this.commitCreatorWrite(p.creatorId, writes); }
    catch (error) { if (error instanceof CreatorContentCommitError) throw new PublicationCopyConflict(error.message); throw error; }
  }

  async claimPublicationState(expected:M['publication'],next:M['publication'],expectedWorkRevision?:number):Promise<boolean>{
    if(next.publicationId!==expected.publicationId||next.workId!==expected.workId||next.creatorId!==expected.creatorId||next.tenantId!==expected.tenantId)throw new CreatorContentCommitError('Publication scope changed.');
    this.bindings.validatePublicationProjection(expected,next);
    this.bindings.validateDisclosureHistory(expected,next);assertCopyIdentityUnchanged(expected,next);
    const names:Record<string,string>={},values:Record<string,unknown>={};
    const fields=['updatedAt','sync','providerData','metadataOverrides','revision','status','visibility','remoteId','remoteUrl','remoteUpdatedAt','copy','imageSelection','configurationRevision','unresolvedImageContext','command','activeOperationId','lastConfirmedImage'];
    const conditions=fields.map((field,index)=>{names['#f'+index]=field;const value=(expected as unknown as Record<string,unknown>)[field];if(value===undefined)return 'attribute_not_exists(#f'+index+')';values[':v'+index]=value;return '#f'+index+' = :v'+index;});
    const sourceFence=expectedWorkRevision===undefined?[]:[{ConditionCheck:{TableName:this.tableName,Key:{PK:`${tenantPrefix(next.tenantId)}#WORK#${next.workId}`,SK:'PROFILE'},ConditionExpression:'revision = :revision AND creatorId = :creator AND attribute_not_exists(deletedAt) AND attribute_not_exists(archivedAt)',ExpressionAttributeValues:{':revision':expectedWorkRevision,':creator':next.creatorId}}}];
    try{await this.commitCreatorWrite(next.creatorId,[{Update:{TableName:this.tableName,Key:{PK:`${tenantPrefix(next.tenantId)}#PUBLICATION#${next.publicationId}`,SK:'PROFILE'},UpdateExpression:'SET providerData = :next',ConditionExpression:conditions.join(' AND '),ExpressionAttributeNames:names,ExpressionAttributeValues:{...values,':next':next.providerData}}},...sourceFence]);return true;}catch(error){if(error instanceof CreatorContentCommitError)return false;throw error;}
  }
  async upsertPublication(publication: M['publication']): Promise<void> {
    const previous = await this.getPublication(publication.tenantId, publication.publicationId);
    this.bindings.validatePublicationProjection(previous,publication);
    this.bindings.validateDisclosureHistory(previous, publication);
    assertCopyIdentityUnchanged(previous, publication);
    const item = {
      PK: `${tenantPrefix(publication.tenantId)}#PUBLICATION#${publication.publicationId}`,
      SK: 'PROFILE',
      GSI1PK: `${tenantPrefix(publication.tenantId)}#WORK_PUBLICATION#${publication.workId}`,
      GSI1SK: `PUBLICATION#${publication.updatedAt}#${publication.publicationId}`,
      GSI2PK: publication.integrationAccountId
        ? `${tenantPrefix(publication.tenantId)}#ACCOUNT_PUBLICATION#${publication.integrationAccountId}`
        : `${tenantPrefix(publication.tenantId)}#DESTINATION_PUBLICATION#${publication.destination}`,
      GSI2SK: `PUBLICATION#${publication.updatedAt}#${publication.publicationId}`,
      entityType: 'PUBLICATION',
      ...publication
    };
    try {
      const guard = await this.restoreWriteGuard(item.PK, item.SK);
      const imageNames:Record<string,string>={},imageValues:Record<string,unknown>={};
      const imageConditions=['imageSelection','configurationRevision','unresolvedImageContext','command','activeOperationId','lastConfirmedImage'].map((field,index)=>{
        const name=`#image${index}`,value=(previous as unknown as Record<string,unknown>|null)?.[field];imageNames[name]=field;
        if(value===undefined)return `attribute_not_exists(${name})`;imageValues[`:image${index}`]=value;return `${name} = :image${index}`;
      });
      await this.client.put({
        TableName: this.tableName,
        Item: item,
        // Legacy writes cannot replace an allocation that raced the prior read.
        // Even an identical copy-aware no-op must compare its current CAS revision.
        ConditionExpression: (previous?.disclosureSnapshots?.length
          ? 'disclosureSnapshots = :previousDisclosureSnapshots'
          : 'attribute_not_exists(disclosureSnapshots)') + (previous?.copy ? ' AND revision = :copyRevision AND #copy = :copyIdentity' : ' AND attribute_not_exists(#copy)') + ' AND ' + guard.condition + ' AND ' + imageConditions.join(' AND '),
        ExpressionAttributeNames: { '#copy': 'copy',...imageNames },
        ...((previous?.disclosureSnapshots?.length || previous?.copy || Object.keys(guard.values).length||Object.keys(imageValues).length) ? { ExpressionAttributeValues: {
          ...guard.values,
          ...imageValues,
          ...(previous?.disclosureSnapshots?.length ? { ':previousDisclosureSnapshots': previous.disclosureSnapshots } : {}),
          ...(previous?.copy ? { ':copyRevision': previous.revision, ':copyIdentity': previous.copy } : {})
        } } : {})
      });
    } catch (error) {
      if ((error as { name?: string }).name === 'ConditionalCheckFailedException') {
        throw new Error('Publication identity, revision or disclosure history changed concurrently; reload before retrying.');
      }
      throw error;
    }
  }

  async commitIntegrationPublication(next: M['publication'], previous: M['publication'] | null, lease: { key: string; id: string }): Promise<void> {
    this.bindings.validatePublicationProjection(previous,next);
    this.bindings.validateDisclosureHistory(previous, next);
    if (previous?.copy || next.copy) throw new CreatorContentCommitError('Copy publications require the copy operation contract.');
    const prefix = tenantPrefix(next.tenantId);
    const names: Record<string, string> = {}, values: Record<string, unknown> = {};
    const conditions = previous ? Object.entries(previous).map(([key, value], n) => {
      names[`#f${n}`] = key; values[`:v${n}`] = value; return `#f${n} = :v${n}`;
    }) : ['attribute_not_exists(PK)'];
    // Marshalled records omit undefined values; compare absence rather than sending undefined expressions.
    if (previous) for (const [n, [key, value]] of Object.entries(previous).entries()) if (value === undefined) {
      delete values[`:v${n}`]; conditions[n] = `attribute_not_exists(#f${n})`;
    }
    await this.commitCreatorWrite(next.creatorId, [
      { ConditionCheck: { TableName: this.tableName, Key: { PK: `EXTERNAL_ACCOUNT#${lease.key}`, SK: 'TOKEN_REFRESH_LEASE' },
        ConditionExpression: 'leaseId = :lease AND expiresAt > :now', ExpressionAttributeValues: { ':lease': lease.id, ':now': Math.floor(Date.now() / 1000) } } },
      { Put: { TableName: this.tableName, Item: {
        PK: `${prefix}#PUBLICATION#${next.publicationId}`, SK: 'PROFILE',
        GSI1PK: `${prefix}#WORK_PUBLICATION#${next.workId}`, GSI1SK: `PUBLICATION#${next.updatedAt}#${next.publicationId}`,
        GSI2PK: next.integrationAccountId ? `${prefix}#ACCOUNT_PUBLICATION#${next.integrationAccountId}` : `${prefix}#DESTINATION_PUBLICATION#${next.destination}`,
        GSI2SK: `PUBLICATION#${next.updatedAt}#${next.publicationId}`, entityType: 'PUBLICATION', ...next
      }, ConditionExpression: conditions.join(' AND '), ...(Object.keys(names).length ? { ExpressionAttributeNames: names } : {}),
        ...(Object.keys(values).length ? { ExpressionAttributeValues: values } : {}) } }
    ]);
  }

  async listPublicationIntentsByWork(tenantId: string, workId: string): Promise<M['intent'][]> {
    const items = await this.listIndex<M['intent']>(`${tenantPrefix(tenantId)}#WORK_PUBLICATION_INTENT#${workId}`, 'PUBLICATION_INTENT#', 'PUBLICATION_INTENT');
    return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getPublicationIntent(tenantId: string, publicationIntentId: string): Promise<M['intent'] | null> {
    return this.get(`${tenantPrefix(tenantId)}#PUBLICATION_INTENT#${publicationIntentId}`, 'PROFILE');
  }

  async upsertPublicationIntent(intent: M['intent']): Promise<void> {
    await this.put({
      PK: `${tenantPrefix(intent.tenantId)}#PUBLICATION_INTENT#${intent.publicationIntentId}`,
      SK: 'PROFILE',
      GSI1PK: `${tenantPrefix(intent.tenantId)}#WORK_PUBLICATION_INTENT#${intent.workId}`,
      GSI1SK: `PUBLICATION_INTENT#${intent.updatedAt}#${intent.publicationIntentId}`,
      entityType: 'PUBLICATION_INTENT',
      ...intent
    });
  }

  async deletePublicationIntent(tenantId: string, publicationIntentId: string): Promise<void> {
    await this.client.delete({ TableName: this.tableName, Key: { PK: `${tenantPrefix(tenantId)}#PUBLICATION_INTENT#${publicationIntentId}`, SK: 'PROFILE' } });
  }

  async listCreatorCollections(tenantId: string, creatorId: string): Promise<M['collection'][]> {
    const items = await this.listIndex<M['collection']>(`${tenantPrefix(tenantId)}#CREATOR_COLLECTION#${creatorId}`, 'COLLECTION#', 'CREATOR_COLLECTION');
    return items.sort((a, b) => a.title.localeCompare(b.title));
  }

  async getCreatorCollection(tenantId: string, collectionId: string): Promise<M['collection'] | null> {
    return this.get(`${tenantPrefix(tenantId)}#COLLECTION#${collectionId}`, 'PROFILE');
  }

  async createCreatorCollection(collection: M['collection']): Promise<void> {
    await this.put({
      PK: `${tenantPrefix(collection.tenantId)}#COLLECTION#${collection.collectionId}`,
      SK: 'PROFILE',
      GSI1PK: `${tenantPrefix(collection.tenantId)}#CREATOR_COLLECTION#${collection.creatorId}`,
      GSI1SK: `COLLECTION#${collection.updatedAt}#${collection.collectionId}`,
      GSI2PK: `${tenantPrefix(collection.tenantId)}#COLLECTION_SLUG#${collection.creatorId}`,
      GSI2SK: `SLUG#${collection.slug}`,
      entityType: 'CREATOR_COLLECTION',
      ...collection
    });
  }

  async updateCreatorCollection(collection: M['collection']): Promise<void> {
    await this.createCreatorCollection(collection);
  }

  async listCollectionWorks(tenantId: string, collectionId: string): Promise<M['collectionWork'][]> {
    const snapshot=await this.get<{members:M['collectionWork'][]}>(`${tenantPrefix(tenantId)}#COLLECTION#${collectionId}`, 'MEMBERSHIP');
    if(snapshot)return snapshot.members;

    return (await this.list<M['collectionWork']>(`${tenantPrefix(tenantId)}#COLLECTION#${collectionId}`, 'WORK#', 'COLLECTION_WORK'))
      .sort((a, b) => a.position - b.position);
  }

  async replaceCollectionWorks(tenantId: string, collectionId: string, works: M['collectionWork'][]): Promise<void> {
    const existing = await this.listCollectionWorks(tenantId, collectionId);
    await Promise.all(existing.map((item) => this.client.delete({
      TableName: this.tableName,
      Key: {
        PK: `${tenantPrefix(tenantId)}#COLLECTION#${collectionId}`,
        SK: `WORK#${item.position.toString().padStart(8, '0')}#${item.workId}`
      }
    })));
    await Promise.all(works.map((item) => this.put({
      PK: `${tenantPrefix(tenantId)}#COLLECTION#${collectionId}`,
      SK: `WORK#${item.position.toString().padStart(8, '0')}#${item.workId}`,
      GSI1PK: `${tenantPrefix(tenantId)}#WORK_COLLECTION#${item.workId}`,
      GSI1SK: `COLLECTION#${item.collectionId}`,
      entityType: 'COLLECTION_WORK',
      ...item
    })));
  }

  async getWorkDiscoveryParticipation(tenantId: string, workId: string): Promise<M['discovery'] | null> {
    return this.get(`${tenantPrefix(tenantId)}#WORK#${workId}`, 'DISCOVERY');
  }

  async upsertWorkDiscoveryParticipation(participation: M['discovery']): Promise<void> {
    await this.put({
      PK: `${tenantPrefix(participation.tenantId)}#WORK#${participation.workId}`,
      SK: 'DISCOVERY',
      GSI1PK: `${tenantPrefix(participation.tenantId)}#DISCOVERY#${participation.state}`,
      GSI1SK: `WORK#${participation.updatedAt}#${participation.workId}`,
      entityType: 'WORK_DISCOVERY',
      ...participation
    });
  }
}
