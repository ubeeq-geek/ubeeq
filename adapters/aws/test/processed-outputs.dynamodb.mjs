import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DynamoDBClient,CreateTableCommand,DeleteTableCommand} from '@aws-sdk/client-dynamodb';
import {DynamoDBDocumentClient,ScanCommand} from '@aws-sdk/lib-dynamodb';
import {createDynamoRepositories} from '@ubeeq/adapter-aws';
import {createLocalAdapterSet} from '@ubeeq/adapter-local';
import {OwnedObjectWrites} from '../../../packages/runtime/dist/owned-object-writes.js';
import {persistProcessedOutputs} from '../../../packages/runtime/dist/processed-outputs.js';

const endpoint=process.env.TEST_DYNAMODB_ENDPOINT;
if(!endpoint||!/^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(endpoint))throw Error('An explicit loopback DynamoDB endpoint is required.');
async function fixture(t){
 const directory=await mkdtemp(join(tmpdir(),'processed-output-dynamodb-')),region='ca-central-1';
 const raw=new DynamoDBClient({region,endpoint,credentials:{accessKeyId:'DUMMYLOCALTEST',secretAccessKey:'DUMMYLOCALTEST'}}),client=DynamoDBDocumentClient.from(raw),table='processed-outputs-'+randomUUID();let created=false;
 const local=createLocalAdapterSet({databasePath:join(directory,'state.sqlite'),dataDirectory:directory,cellId:'cell',publicBaseUrl:'http://localhost'});
 t.after(async()=>{try{if(created)await raw.send(new DeleteTableCommand({TableName:table}));}finally{raw.destroy();local.database.close();await rm(directory,{recursive:true,force:true});}});
 await raw.send(new CreateTableCommand({TableName:table,BillingMode:'PAY_PER_REQUEST',KeySchema:[{AttributeName:'pk',KeyType:'HASH'},{AttributeName:'sk',KeyType:'RANGE'}],AttributeDefinitions:['pk','sk','repository','id'].map(AttributeName=>({AttributeName,AttributeType:'S'})),GlobalSecondaryIndexes:[{IndexName:'repository-id-index',KeySchema:[{AttributeName:'repository',KeyType:'HASH'},{AttributeName:'id',KeyType:'RANGE'}],Projection:{ProjectionType:'ALL'}}]}));created=true;
 const repositories=createDynamoRepositories(client,{tableName:table,cellId:'cell'}),grants=new Map(),settlements=new Map();let writes=0;
 const quota={async checkAndReserveQuota(value){const prior=grants.get(value.idempotencyKey);if(prior)assert.deepEqual(value,prior);grants.set(value.idempotencyKey,structuredClone(value));return {allowed:true};},async recordUsageSettlement(value){const prior=settlements.get(value.idempotencyKey);if(prior)assert.deepEqual(value,prior);settlements.set(value.idempotencyKey,structuredClone(value));},async closeStorageReservation(){}};
 const complete=local.storage.complete.bind(local.storage);local.storage.complete=async value=>{writes++;return complete(value);};
 const sourceBytes=Buffer.from('original source'),source={bucket:'cell',key:'cells/cell/creators/creator/source',versionId:'physical-source',contentType:'audio/wav',byteLength:sourceBytes.length,checksum:createHash('sha256').update(sourceBytes).digest('hex'),scope:'private'};
 await local.storage.put({object:source,body:sourceBytes});
 const asset=await repositories.assets.create({id:'asset',instanceId:'instance',creatorId:'creator',mimeType:'audio/wav',checksum:source.checksum,objectVersion:'logical-source',status:'processing',homeCellId:'cell',dataHomeRegion:region,dataHomeAssignedAt:'2026-01-01T00:00:00.000Z',routingRevision:1});
 const args=repo=>({repositories:repo,storage:local.storage,owned:new OwnedObjectWrites(repo,local.storage,quota,'instance','cell'),asset,source,usageKey:'asset-processing:asset:logical-source',assertCurrent:async()=>{const current=await repo.assets.get(asset.id);assert.equal(current.revision,asset.revision);},transform:async(bytes,mimeType)=>({bytes,mimeType})});
 const produce=async()=>({result:{metadata:{decoded:true},measuredUnits:1,renditions:[{id:'audio',sourceVersionId:'logical-source',contentType:'audio/mpeg',role:'preview',byteLength:7,body:Buffer.from('encoded')},{id:'poster',sourceVersionId:'logical-source',contentType:'image/png',role:'poster',byteLength:6,body:Buffer.from('poster')},{id:'alias',sourceVersionId:'logical-source',contentType:'image/png',role:'poster',byteLength:6,body:Buffer.from('poster')}]},fallback:async()=>({bytes:sourceBytes,mimeType:'audio/wav'})});
 return {repositories,local,asset,source,produce,args,settlements,get writes(){return writes;},rows:async()=>(await client.send(new ScanCommand({TableName:table}))).Items,independent:()=>createDynamoRepositories(client,{tableName:table,cellId:'cell'})};
}
test('actual DynamoDB output sets recover accepted files across independent repositories without encoding again',async t=>{
 const f=await fixture(t),first=await persistProcessedOutputs({...f.args(f.repositories),produce:f.produce});
 const recovered=await persistProcessedOutputs({...f.args(f.independent()),produce:async()=>{throw Error('Completed outputs must not rerun the encoder');}});
 assert.deepEqual(recovered,first);assert.equal(f.writes,2);assert.equal(first.storage.contentType,'audio/mpeg');assert.equal(first.renditions.length,3);
 assert.deepEqual(first.renditions[1].storage,first.renditions[2].storage);assert.equal(first.renditions[1].storage.scope,'private');
 assert.equal([...f.settlements.values()].reduce((n,value)=>n+(value.storageBytesDelta??0),0),13);
 assert.equal((await f.rows()).filter(row=>row.value.namespace==='runtime-processed-outputs').length,1);
});
test('an accepted DynamoDB output-set update with a lost reply recovers its exact physical versions',async t=>{
 const f=await fixture(t),update=f.repositories.hostRecords.update.bind(f.repositories.hostRecords);let lost=false;
 f.repositories.hostRecords.update=async(...args)=>{const saved=await update(...args);if(!lost&&saved.namespace==='runtime-processed-outputs'&&Object.keys(saved.value.objects).length){lost=true;throw Error('Accepted output-set response lost');}return saved;};
 await assert.rejects(()=>persistProcessedOutputs({...f.args(f.repositories),produce:f.produce}),/response lost/);
 const recovered=await persistProcessedOutputs({...f.args(f.independent()),produce:f.produce});
 assert.equal(lost,true);assert.equal(f.writes,2);assert.equal(recovered.renditions.length,3);assert.equal(f.settlements.size,2);
});
test('actual DynamoDB refuses a changed output set after a partial physical effect',async t=>{
 const f=await fixture(t),update=f.repositories.hostRecords.update.bind(f.repositories.hostRecords);let failed=false;
 f.repositories.hostRecords.update=async(...args)=>{const row=await f.repositories.hostRecords.get(args[0]);if(!failed&&row.namespace==='runtime-processed-outputs'){failed=true;throw Error('Output-set unavailable');}return update(...args);};
 await assert.rejects(()=>persistProcessedOutputs({...f.args(f.repositories),produce:f.produce}),/unavailable/);assert.equal(f.writes,1);
 await assert.rejects(()=>persistProcessedOutputs({...f.args(f.independent()),produce:async()=>{const value=await f.produce();value.result.metadata.decoded=false;return value;}}),/recipe or bytes changed/);
 assert.equal(f.writes,1);assert.equal(f.settlements.size,1);
});
