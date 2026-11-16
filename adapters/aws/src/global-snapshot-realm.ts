import {randomUUID} from 'node:crypto';
import {CreateTableCommand,DescribeTableCommand,waitUntilTableExists,type DynamoDBClient} from '@aws-sdk/client-dynamodb';
import {DynamoDBDocumentClient,GetCommand,PutCommand,ScanCommand} from '@aws-sdk/lib-dynamodb';
import type {AwsCommandClient} from './client-port.js';

export const globalSnapshotKey={pk:'__ubeeq_repository_snapshot#global-v2',sk:'fence'} as const;
const legacyPrefix='__ubeeq_repository_snapshot#';
export interface GlobalSnapshotRoot extends Record<string,unknown> {
 pk:typeof globalSnapshotKey.pk;sk:'fence';schemaVersion:2;protocol:'global-v2';instanceId:string;realmId:string;version:string;
 genesis:{kind:'fresh-owned-table';tableArn:string;createdAt:string;provisioningId:string};
}
/** A server-only capability from a real persisted fresh-table genesis. A JSON
 * object, configuration flag or claimed empty inventory is not a capability. */
export interface GlobalSnapshotRealm {readonly tableName:string;readonly instanceId:string}
export interface GlobalSnapshotSession {readonly client:DynamoDBDocumentClient;readonly realm:GlobalSnapshotRealm}
const realms=new WeakMap<object,{client:AwsCommandClient;root:GlobalSnapshotRoot}>();
export class SnapshotProtocolError extends Error {
 readonly code='snapshot_protocol_migration_required';readonly status=503;
 constructor(message='This table requires its original snapshot writer and an explicitly fenced migration.'){super(message);this.name='SnapshotProtocolError';}
}
const valid=(root:unknown):root is GlobalSnapshotRoot=>{
 const r=root as GlobalSnapshotRoot;
 return !!r&&r.pk===globalSnapshotKey.pk&&r.sk==='fence'&&r.schemaVersion===2&&r.protocol==='global-v2'
  &&typeof r.instanceId==='string'&&!!r.instanceId&&typeof r.realmId==='string'&&!!r.realmId&&typeof r.version==='string'&&!!r.version
  &&r.genesis?.kind==='fresh-owned-table'&&typeof r.genesis.tableArn==='string'&&!!r.genesis.tableArn&&typeof r.genesis.provisioningId==='string'&&!!r.genesis.provisioningId
  &&typeof r.genesis.createdAt==='string'&&Number.isFinite(Date.parse(r.genesis.createdAt));
};
export function requireGlobalSnapshotRealm(realm:GlobalSnapshotRealm,client:AwsCommandClient,table:string):Readonly<GlobalSnapshotRoot>{
 const proof=realm&&typeof realm==='object'?realms.get(realm):undefined;
 if(!proof||proof.client!==client||realm.tableName!==table||realm.instanceId!==proof.root.instanceId)throw new SnapshotProtocolError('Use the actual genesis/reopen capability for this exact client and table.');
 return structuredClone(proof.root);
}
/** Internal composition uses the same actual client that verified genesis;
 * it never reconstructs a second client from an unrelated config/profile. */
export function boundGlobalSnapshotClient(realm:GlobalSnapshotRealm,table:string):AwsCommandClient {
 const proof=realm&&typeof realm==='object'?realms.get(realm):undefined;
 if(!proof||realm.tableName!==table)throw new SnapshotProtocolError('Use the actual table-bound global snapshot capability.');
 return proof.client;
}
const authorize=(client:AwsCommandClient,tableName:string,root:GlobalSnapshotRoot):GlobalSnapshotRealm=>{
 const realm=Object.freeze({tableName,instanceId:root.instanceId});realms.set(realm,{client,root:structuredClone(root)});return realm;
};
export async function readGlobalSnapshotRoot(client:AwsCommandClient,tableName:string,proof?:Readonly<GlobalSnapshotRoot>):Promise<GlobalSnapshotRoot|undefined>{
 const root=(await client.send(new GetCommand({TableName:tableName,Key:globalSnapshotKey,ConsistentRead:true}))).Item;
 if(!root)return undefined;
 if(!valid(root)||proof&&(root.instanceId!==proof.instanceId||root.realmId!==proof.realmId||root.genesis.kind!==proof.genesis.kind||root.genesis.tableArn!==proof.genesis.tableArn||root.genesis.createdAt!==proof.genesis.createdAt||root.genesis.provisioningId!==proof.genesis.provisioningId))throw new SnapshotProtocolError('The persisted global snapshot realm requires reconciliation.');
 return root;
}
async function assertNoLegacyMarkers(client:AwsCommandClient,tableName:string):Promise<void>{
 let cursor:Record<string,unknown>|undefined;
 do{
  const page=await client.send(new ScanCommand({TableName:tableName,ConsistentRead:true,FilterExpression:'begins_with(pk,:prefix) AND sk = :fence',ExpressionAttributeValues:{':prefix':legacyPrefix,':fence':'fence'},ExclusiveStartKey:cursor}));
  if((page.Items??[]).some((row:Record<string,unknown>)=>row.pk!==globalSnapshotKey.pk))throw new SnapshotProtocolError('Legacy per-repository markers cannot be silently adopted by the global snapshot realm.');
  cursor=page.LastEvaluatedKey;
 }while(cursor);
}
/** Owns actual CreateTable; existing/empty/V1 tables are NEVER adopted. Source
 * writers cannot already target a table that has not existed or been published.
 * No in-place migration API is supplied until the host has an enforceable fence
 * for every older/raw writer. An uncertain provision is an operator recovery,
 * never a reason to treat ResourceInUse as successful genesis. */
export async function createFreshGlobalSnapshotRealm(raw:DynamoDBClient,input:{tableName:string;instanceId:string}):Promise<GlobalSnapshotSession>{
 const client=DynamoDBDocumentClient.from(raw);
 if(typeof input.instanceId!=='string'||!input.instanceId||input.instanceId.length>200||typeof input.tableName!=='string'||!/^[A-Za-z0-9_.-]{3,255}$/.test(input.tableName))throw new SnapshotProtocolError('A fresh installation table and exact instance identity are required.');
 const created=await raw.send(new CreateTableCommand({TableName:input.tableName,BillingMode:'PAY_PER_REQUEST',KeySchema:[{AttributeName:'pk',KeyType:'HASH'},{AttributeName:'sk',KeyType:'RANGE'}],AttributeDefinitions:['pk','sk','repository','id'].map(AttributeName=>({AttributeName,AttributeType:'S'})),GlobalSecondaryIndexes:[{IndexName:'repository-id-index',KeySchema:[{AttributeName:'repository',KeyType:'HASH'},{AttributeName:'id',KeyType:'RANGE'}],Projection:{ProjectionType:'ALL'}}]}));
 await waitUntilTableExists({client:raw,maxWaitTime:120},{TableName:input.tableName});
 const receipt=created.TableDescription,description=(await raw.send(new DescribeTableCommand({TableName:input.tableName}))).Table;
 if(!receipt?.TableArn||!receipt.CreationDateTime||description?.TableArn!==receipt.TableArn||description.CreationDateTime?.toISOString()!==receipt.CreationDateTime.toISOString()||description.TableStatus!=='ACTIVE')throw new SnapshotProtocolError('The actual CreateTable and active DescribeTable receipts must agree.');
 const root:GlobalSnapshotRoot={...globalSnapshotKey,schemaVersion:2,protocol:'global-v2',instanceId:input.instanceId,realmId:randomUUID(),version:randomUUID(),genesis:{kind:'fresh-owned-table',tableArn:description.TableArn,createdAt:description.CreationDateTime.toISOString(),provisioningId:randomUUID()}};
 await client.send(new PutCommand({TableName:input.tableName,Item:root,ConditionExpression:'attribute_not_exists(pk)'}));
 return reopen(raw,client,input);
}
/** Actual durable reopen. No absent-root fallback, marker migration or writable
 * configuration flag. The new process verifies the actual table's receipt. */
export async function openGlobalSnapshotRealm(raw:DynamoDBClient,input:{tableName:string;instanceId:string}):Promise<GlobalSnapshotSession>{return reopen(raw,DynamoDBDocumentClient.from(raw),input);}
async function reopen(raw:DynamoDBClient,client:DynamoDBDocumentClient,input:{tableName:string;instanceId:string}):Promise<GlobalSnapshotSession>{
 const root=await readGlobalSnapshotRoot(client,input.tableName);
 if(!root||root.instanceId!==input.instanceId)throw new SnapshotProtocolError();
 const description=(await raw.send(new DescribeTableCommand({TableName:input.tableName}))).Table;
 if(description?.TableArn!==root.genesis.tableArn||description.CreationDateTime?.toISOString()!==root.genesis.createdAt)throw new SnapshotProtocolError('The snapshot genesis belongs to another physical table.');
 await assertNoLegacyMarkers(client,input.tableName);return {client,realm:authorize(client,input.tableName,root)};
}
