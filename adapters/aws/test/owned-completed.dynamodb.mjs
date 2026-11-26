import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DynamoDBClient,DeleteTableCommand} from '@aws-sdk/client-dynamodb';
import {createLocalAdapterSet} from '@ubeeq/adapter-local';
import {OwnedObjectWrites} from '@ubeeq/runtime/owned-object-writes';
import {createDynamoRepositories,createFreshGlobalSnapshotRealm,openGlobalSnapshotRealm} from '../dist/index.js';
const endpoint=process.env.TEST_DYNAMODB_ENDPOINT;
if(!endpoint||!/^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(endpoint))throw Error('Explicit loopback DynamoDB is required; this suite never uses AWS.');
const home={homeCellId:'cell',dataHomeRegion:'us-east-1',dataHomeAssignedAt:'2026-01-01T00:00:00.000Z',routingRevision:1};
async function fixture(t){
 const config={endpoint,region:home.dataHomeRegion,credentials:{accessKeyId:'DUMMYLOCALTEST',secretAccessKey:'DUMMYLOCALTEST'}},raw=new DynamoDBClient(config),otherRaw=new DynamoDBClient(config),table='owned-completed-'+randomUUID(),directory=await mkdtemp(join(tmpdir(),'owned-completed-'));
 let created=false;const local=createLocalAdapterSet({databasePath:join(directory,'physical.sqlite'),dataDirectory:directory,cellId:'cell',publicBaseUrl:'http://127.0.0.1'});
 t.after(async()=>{try{if(created)await raw.send(new DeleteTableCommand({TableName:table}));}finally{raw.destroy();otherRaw.destroy();local.database.close();await rm(directory,{recursive:true,force:true});}});
 const first=await createFreshGlobalSnapshotRealm(raw,{tableName:table,instanceId:'instance'});created=true;
 const second=await openGlobalSnapshotRealm(otherRaw,{tableName:table,instanceId:'instance'}),repositories=createDynamoRepositories(first.client,{tableName:table,cellId:'cell',globalSnapshotRealm:first.realm}),independent=createDynamoRepositories(second.client,{tableName:table,cellId:'cell',globalSnapshotRealm:second.realm});
 const reserved=new Map(),settled=new Map(),quota={async checkAndReserveQuota(input){reserved.set(input.idempotencyKey,structuredClone(input));return {allowed:true};},async recordUsageSettlement(input){assert.equal(reserved.get(input.idempotencyKey)?.storageBytesDelta,input.storageBytesDelta);settled.set(input.idempotencyKey,structuredClone(input));},async closeStorageReservation(){throw Error('No unused generation is expected in this control.');}};
 const writer=new OwnedObjectWrites(repositories,local.storage,quota,'instance','cell'),input={creatorId:'creator',operation:'asset.custom-rendition',idempotencyKey:'one-actual-output',home,bucket:'cell',kind:'renditions',scope:'private',contentType:'text/plain',body:Buffer.from('Actual Local bytes, real Dynamo metadata'),metadata:{originalRender:{unknown:['多字節',{future:true}]}}},output=await writer.write(input),row=(await repositories.hostRecords.snapshot()).items.find(row=>row.namespace==='runtime-owned-object');
 const companion=id=>({id,instanceId:'instance',...home,namespace:'unit',scopeId:'creator',key:id,value:{accepted:true}});
 return {repositories,independent,writer,input,output,row,client:first.client,quota,local,companion,settled};
}
test('actual Dynamo accepting metadata returns exact immutable full custody without effects and supports ordinary reopen',async t=>{
 const f=await fixture(t),count=f.settled.size;
 for(const key of ['initiate','recoverCompletion','complete','seal','accept','put','get'])if(typeof f.local.storage[key]==='function')f.local.storage[key]=async()=>{throw Error('Metadata read attempted physical IO');};
 for(const key of ['checkAndReserveQuota','recordUsageSettlement','closeStorageReservation'])f.quota[key]=async()=>{throw Error('Metadata read attempted quota IO');};
 await f.repositories.transaction(async tx=>{assert.deepEqual(await f.writer.readCompleted(f.input,tx),f.output);await f.repositories.hostRecords.create(f.companion('accepted'),{transaction:tx});});
 const reopened=new OwnedObjectWrites(f.independent,f.local.storage,f.quota,'instance','cell');assert.deepEqual(await reopened.readCompleted(f.input),f.output);assert.equal(f.settled.size,count);assert.ok(await f.independent.hostRecords.get('accepted'));
});
test('actual Dynamo owned-row revision change before accepting commit rejects the entire attachment companion',async t=>{
 const f=await fixture(t),send=f.client.send.bind(f.client);let raced=false;
 f.client.send=async(command,...rest)=>{if(!raced&&command.constructor.name==='TransactWriteCommand'&&command.input.TransactItems.some(item=>item.Put?.Item?.id==='must-rollback')){raced=true;const current=await f.independent.hostRecords.get(f.row.id);await f.independent.hostRecords.update(current.id,current.revision,{value:{...current.value,futureMetadata:{observed:'concurrent'}}});}return send(command,...rest);};
 try{await assert.rejects(f.repositories.transaction(async tx=>{assert.deepEqual(await f.writer.readCompleted(f.input,tx),f.output);await f.repositories.hostRecords.create(f.companion('must-rollback'),{transaction:tx});}),{name:'OptimisticConcurrencyError'});}finally{f.client.send=send;}
 assert.equal(raced,true);assert.equal(await f.independent.hostRecords.get('must-rollback'),undefined);assert.deepEqual(await f.writer.readCompleted(f.input),f.output);
});
test('actual Dynamo absence is guarded, foreign coordinator is rejected, and caught corrupt receipt poisons acceptance',async t=>{
 const f=await fixture(t),send=f.client.send.bind(f.client),missing={...f.input,idempotencyKey:'missing-output'};let foreign=false;
 await f.independent.transaction(async tx=>{await assert.rejects(f.writer.readCompleted(f.input,tx),/transaction|coordinator|scope/i);foreign=true;}).catch(error=>assert.match(error.message,/abort|failed|transaction|coordinator|scope/i));assert.equal(foreign,true);
 let raced=false;f.client.send=async(command,...rest)=>{if(!raced&&command.constructor.name==='TransactWriteCommand'&&command.input.TransactItems.some(item=>item.Put?.Item?.id==='absence-rollback')){raced=true;await new OwnedObjectWrites(f.independent,f.local.storage,f.quota,'instance','cell').write(missing);}return send(command,...rest);};
 try{await assert.rejects(f.repositories.transaction(async tx=>{assert.equal(await f.writer.readCompleted(missing,tx),undefined);await f.repositories.hostRecords.create(f.companion('absence-rollback'),{transaction:tx});}),{name:'OptimisticConcurrencyError'});}finally{f.client.send=send;}
 assert.equal(raced,true);assert.equal(await f.independent.hostRecords.get('absence-rollback'),undefined);
 const current=await f.independent.hostRecords.get(f.row.id);await f.independent.hostRecords.update(current.id,current.revision,{value:{...current.value,completedObject:{...current.value.completedObject,versionId:''}}});
 await assert.rejects(f.repositories.transaction(async tx=>{try{await f.writer.readCompleted(f.input,tx);}catch{}await f.repositories.hostRecords.create(f.companion('corrupt-rollback'),{transaction:tx});}),/abort|failed/i);assert.equal(await f.independent.hostRecords.get('corrupt-rollback'),undefined);
});
