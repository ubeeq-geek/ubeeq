import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DynamoDBClient,CreateTableCommand,DeleteTableCommand} from '@aws-sdk/client-dynamodb';
import {DynamoDBDocumentClient} from '@aws-sdk/lib-dynamodb';
import {createDynamoRepositories} from '../dist/index.js';
import {createLocalAdapterSet} from '@ubeeq/adapter-local';
import {UsageSettlementOutbox} from '../../../packages/runtime/dist/usage-settlement-outbox.js';
import {UploadLifecycle} from '../../../packages/runtime/dist/upload-lifecycle.js';
const endpoint=process.env.TEST_DYNAMODB_ENDPOINT;
if(!endpoint||!/^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(endpoint))throw Error('An explicit loopback DynamoDB endpoint is required; this test never uses AWS.');
async function fixture(t){
 const region='local',cellId='cell',raw=new DynamoDBClient({endpoint,region,credentials:{accessKeyId:'DUMMYLOCALTEST',secretAccessKey:'DUMMYLOCALTEST'}}),client=DynamoDBDocumentClient.from(raw),table='outside-read-'+randomUUID(),directory=await mkdtemp(join(tmpdir(),'dynamo-read-scope-')),local=createLocalAdapterSet({databasePath:join(directory,'actual-provider.sqlite'),dataDirectory:directory,cellId,publicBaseUrl:'http://127.0.0.1'});let created=false;
 t.after(async()=>{try{if(created)await raw.send(new DeleteTableCommand({TableName:table}));}finally{raw.destroy();local.database.close();await rm(directory,{recursive:true,force:true});}});
 await raw.send(new CreateTableCommand({TableName:table,BillingMode:'PAY_PER_REQUEST',KeySchema:[{AttributeName:'pk',KeyType:'HASH'},{AttributeName:'sk',KeyType:'RANGE'}],AttributeDefinitions:['pk','sk','repository','id'].map(AttributeName=>({AttributeName,AttributeType:'S'})),GlobalSecondaryIndexes:[{IndexName:'repository-id-index',KeySchema:[{AttributeName:'repository',KeyType:'HASH'},{AttributeName:'id',KeyType:'RANGE'}],Projection:{ProjectionType:'ALL'}}]}));created=true;
 const repositories=createDynamoRepositories(client,{tableName:table,cellId}),home={homeCellId:cellId,dataHomeRegion:region,dataHomeAssignedAt:new Date().toISOString(),routingRevision:1};
 // Actual unrelated persisted rows force more than one outside query page.
 for(let i=0;i<105;i++)await repositories.hostRecords.create({id:'unrelated-'+String(i).padStart(3,'0'),instanceId:'instance',namespace:'unrelated',scopeId:'other',key:String(i),value:{preserve:['existing',i]},...home});
 return {repositories,local,home};
}

test('actual Dynamo outbox drains multiple outside query pages and keeps its real conditional acknowledgements and original settlement identities',async t=>{
 const f=await fixture(t),settlements=new Map();
 // Explicit quota transport/idempotency fixture. This is not billing acceptance.
 const quota={async recordUsageSettlement(input){const old=settlements.get(input.idempotencyKey);if(old)assert.deepEqual(old,input);settlements.set(input.idempotencyKey,structuredClone(input));}},outbox=new UsageSettlementOutbox(f.repositories,quota,'instance','cell'),records=[];
 for(let i=0;i<3;i++)records.push(await f.repositories.transaction(transaction=>outbox.enqueue({creatorId:'creator',operation:'actual-effect',idempotencyKey:'original-'+i,processingCreditsUsed:i},f.home,transaction)));
 assert.equal(await outbox.drain(),3);assert.equal(settlements.size,3);
 for(const row of records){const current=await f.repositories.hostRecords.get(row.id);assert.equal(current.value.state,'settled');assert.deepEqual(current.value.input,row.value.input);}
 assert.equal(await new UsageSettlementOutbox(f.repositories,quota,'instance','cell').drain(),0);assert.equal(settlements.size,3);
});

test('actual Dynamo upload repair queries outside write transactions and recovers one genuine Local provider receipt and processing job',async t=>{
 const f=await fixture(t);await f.repositories.creators.create({id:'creator',instanceId:'instance',subjectId:'actor',handle:'actual-creator',displayName:'Actual Creator',...f.home});const work=await f.repositories.works.create({id:'work',instanceId:'instance',creatorId:'creator',title:'Actual original',status:'draft',...f.home}),body=Buffer.from('Genuine Local bytes with Dynamo lifecycle '+randomUUID()),checksum=createHash('sha256').update(body).digest('hex'),lifecycle=new UploadLifecycle(f.repositories,f.local.storage,f.local.jobs,'instance','cell','http://127.0.0.1');
 const issued=await lifecycle.initiate(work,'actor',{mimeType:'application/octet-stream',byteLength:body.byteLength,checksum},'actual-original');await lifecycle.accept(issued.uploadId,'creator',body);
 const enqueue=f.local.jobs.enqueue.bind(f.local.jobs);let unavailable=true;t.mock.method(f.local.jobs,'enqueue',async input=>{if(unavailable)throw Error('Actual processing queue unavailable before any effect');return enqueue(input);});
 const completed=await lifecycle.complete(issued.uploadId,work,'actor',{byteLength:body.byteLength,checksum});assert.equal(completed.queuePending,true);assert.equal(completed.job,null);unavailable=false;
 const reopened=new UploadLifecycle(f.repositories,f.local.storage,f.local.jobs,'instance','cell','http://127.0.0.1');assert.equal(await reopened.repair(),1);assert.equal(await reopened.repair(),0);
 const recovered=await reopened.complete(issued.uploadId,work,'actor',{byteLength:body.byteLength,checksum});assert.equal(recovered.queuePending,false);assert.equal(recovered.asset.id,completed.asset.id);assert.equal(recovered.asset.objectVersion,completed.asset.objectVersion);assert.equal((await f.local.jobs.list({cellId:'cell',limit:100})).length,1);assert.equal(recovered.job.payload.assetId,completed.asset.id);assert.deepEqual((await f.local.storage.get(completed.asset.storage)).body,body);
});
