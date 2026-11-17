import {createHash,randomUUID} from 'node:crypto';
import {GetCommand,QueryCommand,TransactWriteCommand} from '@aws-sdk/lib-dynamodb';
import {collectionMetadata as metadata} from '@ubeeq/core';
import type {AwsCommandClient} from './client-port.js';

export type CollectionMetadataTransactionItems=NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']>;
export interface DynamoCollectionMetadataConfiguration<C extends metadata.MetadataCollectionRecord> {
  client:AwsCommandClient;
  /** One installation boundary; the route graph is shared across its tenants. */
  tableName:string;
  /** Trusted host composition only. Return current Creator, collection, organization,
   * all-actor permission and lease guards, plus any collection/alias writes. These
   * items commit atomically with metadata. Never authorize from request fields. */
  boundaryItems(input:metadata.MetadataCommit<C>):Promise<CollectionMetadataTransactionItems>;
}
const groups=['connections','snapshots','proposals','provenance','audit','executions','commands'] as const;
const immutable=new Set<string>(['snapshots','provenance','audit','executions','commands']);
const partition=(tenant:string,id:string)=>`TENANT#${tenant}#COLLECTION_METADATA#${id}`;
const graphKey={PK:'COLLECTION_METADATA_GRAPH#INSTALLATION',SK:'ROUTES'};
const {metadataHash}=metadata.createMetadataDomain({sha256Hex:value=>createHash('sha256').update(value,'utf8').digest('hex'),createId:randomUUID,now:()=>new Date().toISOString()});
const budget=(value:unknown,message:string)=>{if(Buffer.byteLength(JSON.stringify(value))>350000)metadata.metadataError('storage_budget',message);};
export function assertCollectionMetadataTransactionBudget(items:CollectionMetadataTransactionItems):void {
  if(items.length>100)metadata.metadataError('storage_budget','Too many metadata operations. Review destinations separately.');
}

/** Partitioned metadata persistence retaining the established PK/SK wire format.
 * This is distinct from the generic pk/sk repository layout; it never adopts an
 * existing library, rewrites historical keys, or uses an eventual index as history.
 * Hosts own authorization and boundary schemas, including sidecar transactions. */
export class DynamoCollectionMetadataStore<C extends metadata.MetadataCollectionRecord=metadata.MetadataCollectionRecord> implements metadata.CollectionMetadataStore<C> {
  constructor(private readonly configuration:DynamoCollectionMetadataConfiguration<C>) {
    if(!configuration?.client||!configuration.tableName||typeof configuration.boundaryItems!=='function')throw new Error('Metadata client, table and transaction-bound host authorization are required.');
  }
  async getCollectionMetadataPresentation(tenantId:string,collectionId:string):Promise<metadata.MetadataState['published']> {
    const {client,tableName}=this.configuration;
    return (await client.send(new GetCommand({TableName:tableName,Key:{PK:partition(tenantId,collectionId),SK:'STATE'},ConsistentRead:true}))).Item?.header?.published??{};
  }
  async getCollectionMetadata(tenantId:string,collectionId:string):Promise<metadata.MetadataState> {
    const {client,tableName}=this.configuration,state=metadata.emptyMetadataState();let cursor:Record<string,unknown>|undefined;
    do {
      const page=await client.send(new QueryCommand({TableName:tableName,KeyConditionExpression:'PK = :pk',ExpressionAttributeValues:{':pk':partition(tenantId,collectionId)},ConsistentRead:true,ExclusiveStartKey:cursor}));
      for(const row of page.Items??[]) {
        if(row.SK==='STATE')Object.assign(state,row.header);
        else if(groups.includes(row.group))(state[row.group as typeof groups[number]] as unknown[]).push(row.value);
      }
      cursor=page.LastEvaluatedKey;
    }while(cursor);
    return state;
  }
  async getCollectionMetadataGraph(_tenantId:string):Promise<metadata.MetadataGraph> {
    const {client,tableName}=this.configuration;
    return (await client.send(new GetCommand({TableName:tableName,Key:graphKey,ConsistentRead:true}))).Item?.graph??metadata.emptyMetadataGraph();
  }
  /** Prepare ONLY metadata/graph writes. This does not persist or authorize anything.
   * A host using these as a sidecar must retain its enclosing transaction's current
   * Creator/collection/organization/permission/lease guards and final item budget. */
  async transactionItems(input:metadata.MetadataCommit<C>):Promise<CollectionMetadataTransactionItems> {
    metadata.validateMetadataCommit(input);
    if(input.graph)budget(input.graph,'Metadata route reservations exceed their storage budget.');
    const before=await this.getCollectionMetadata(input.tenantId,input.collectionId);
    if(before.revision!==input.expectedRevision)metadata.metadataError('stale_revision','Metadata changed. Refresh before retrying.');
    const {connections,snapshots,proposals,provenance,audit,executions,commands,...header}=input.state;
    const table=this.configuration.tableName;
    const items:CollectionMetadataTransactionItems=[{Put:{TableName:table,Item:{PK:partition(input.tenantId,input.collectionId),SK:'STATE',revision:input.state.revision,creatorId:input.creatorId,header},ConditionExpression:input.expectedRevision?'revision = :r':'attribute_not_exists(PK)',...(input.expectedRevision?{ExpressionAttributeValues:{':r':input.expectedRevision}}:{})}}];
    for(const group of groups) {
      const previous=new Map<string,unknown>((before[group] as Array<{id:string}>).map(row=>[row.id,row]));
      if(immutable.has(group)&&[...previous.keys()].some(id=>!(input.state[group] as Array<{id:string}>).some(row=>row.id===id)))metadata.metadataError('invalid_request','Historical metadata records cannot be removed.');
      for(const value of input.state[group] as Array<{id:string}>) {
        const old=previous.get(value.id);
        if(old&&metadataHash(old)===metadataHash(value))continue;
        if(old&&immutable.has(group))metadata.metadataError('invalid_request','Historical metadata records are immutable.');
        budget(value,'This metadata record exceeds its storage limit.');
        items.push({Put:{TableName:table,Item:{PK:partition(input.tenantId,input.collectionId),SK:`${group}#${value.id}`,group,value}}});
      }
    }
    if(input.graph)items.push({Put:{TableName:table,Item:{...graphKey,revision:input.graph.revision,graph:input.graph},ConditionExpression:input.expectedGraphRevision?'revision = :r':'attribute_not_exists(PK)',...(input.expectedGraphRevision?{ExpressionAttributeValues:{':r':input.expectedGraphRevision}}:{})}});
    assertCollectionMetadataTransactionBudget(items);
    return items;
  }
  async commitCollectionMetadata(input:metadata.MetadataCommit<C>):Promise<void> {
    const items=await this.transactionItems(input),boundary=await this.configuration.boundaryItems(input);
    if(!Array.isArray(boundary)||!boundary.length)metadata.metadataError('permission_denied','Transaction-bound metadata authorization is required.');
    items.push(...boundary);assertCollectionMetadataTransactionBudget(items);
    try{await this.configuration.client.send(new TransactWriteCommand({TransactItems:JSON.parse(JSON.stringify(items))}));}
    catch(error){if((error as Error).name==='TransactionCanceledException')metadata.metadataError('stale_revision','Collection, permissions or destination ownership changed. Refresh before retrying.');throw error;}
  }
}
