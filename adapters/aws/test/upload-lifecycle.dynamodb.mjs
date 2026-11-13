import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash,randomUUID } from 'node:crypto';
import { DynamoDBClient,CreateTableCommand,DeleteTableCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient,GetCommand,ScanCommand } from '@aws-sdk/lib-dynamodb';
import { createDynamoRepositories,AwsJobQueue,DynamoRevisionedRepository } from '../dist/index.js';
import { createLocalAdapterSet } from '@ubeeq/adapter-local';
import { UploadLifecycle } from '../../../packages/runtime/dist/upload-lifecycle.js';
const endpoint=process.env.TEST_DYNAMODB_ENDPOINT;
if(!endpoint || !/^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(endpoint))throw Error('An explicit loopback DynamoDB test endpoint is required.');
test('actual DynamoDB upload/asset transaction and independent queue acknowledgement recover without duplication',async()=>{
 const client=new DynamoDBClient({endpoint,region:'ca-central-1',maxAttempts:1,credentials:{accessKeyId:'DUMMYLOCALTEST',secretAccessKey:'DUMMYLOCALTEST'}}),document=DynamoDBDocumentClient.from(client);
 const table='upload-test-'+randomUUID(),directory=await mkdtemp(join(tmpdir(),'upload-dynamodb-'));
 let created=false,local;
 try{
  await client.send(new CreateTableCommand({TableName:table,BillingMode:'PAY_PER_REQUEST',KeySchema:[{AttributeName:'pk',KeyType:'HASH'},{AttributeName:'sk',KeyType:'RANGE'}],AttributeDefinitions:[{AttributeName:'pk',AttributeType:'S'},{AttributeName:'sk',AttributeType:'S'},{AttributeName:'repository',AttributeType:'S'},{AttributeName:'id',AttributeType:'S'}],GlobalSecondaryIndexes:[{IndexName:'repository-id-index',KeySchema:[{AttributeName:'repository',KeyType:'HASH'},{AttributeName:'id',KeyType:'RANGE'}],Projection:{ProjectionType:'ALL'}}]}));created=true;
  const configuration={tableName:table,cellId:'cell'},repositories=createDynamoRepositories(document,configuration);
  let notifications=0,loseQueueReply=true;
  const jobs=new AwsJobQueue(document,configuration,{async send(){notifications++;return {}; }},'http://localhost/unused-notification-fixture');
  const enqueue=jobs.enqueue.bind(jobs);
  jobs.enqueue=async input=>{
   const persisted=(await document.send(new GetCommand({TableName:table,Key:{pk:'assets#'+input.payload.assetId,sk:'record'},ConsistentRead:true}))).Item;
   assert.ok(persisted,'asset transaction must already be committed before queue dispatch');
   const result=await enqueue(input);if(loseQueueReply){loseQueueReply=false;throw Error('Lost queue acknowledgement after durable enqueue');}return result;
  };
  local=createLocalAdapterSet({databasePath:join(directory,'provider.sqlite'),dataDirectory:directory,cellId:'cell',publicBaseUrl:'http://localhost'});
  const journal=()=>new UploadLifecycle(createDynamoRepositories(document,configuration),local.storage,jobs,'instance','cell','http://localhost');
  const work=await repositories.works.create({id:'work',creatorId:'creator',instanceId:'instance',title:'Synthetic Work',status:'draft',homeCellId:'cell',dataHomeRegion:'ca-central-1',dataHomeAssignedAt:new Date().toISOString(),routingRevision:1});
  const body=Buffer.from('Synthetic original body'),checksum=createHash('sha256').update(body).digest('hex');
  const upload=await journal().initiate(work,'operator',{mimeType:'text/plain',byteLength:body.length,checksum},'same-file');
  await journal().accept(upload.uploadId,'creator',body);
  const first=await journal().complete(upload.uploadId,work,'operator',{checksum,byteLength:body.length});
  assert.equal(first.queuePending,true);assert.equal(first.job,null);
  await journal().repair();
  const repeated=await Promise.all([journal().complete(upload.uploadId,work,'operator',{checksum,byteLength:body.length}),journal().complete(upload.uploadId,work,'operator',{checksum,byteLength:body.length})]);
  assert.equal(repeated.every(r=>r.asset.id===first.asset.id && !r.queuePending),true);assert.equal(repeated[0].job.id,repeated[1].job.id);assert.equal(notifications,1);
  const items=(await document.send(new ScanCommand({TableName:table}))).Items;
  for(const repository of ['assets','moderationEvidence','auditEvents','durableJobs'])assert.equal(items.filter(i=>i.repository===repository).length,1,repository+' must commit once');
  // Concurrent first completions also contend on the same journal/asset write set.
  const secondUpload=await journal().initiate(work,'operator',{mimeType:'text/plain',byteLength:body.length,checksum},'concurrent-file');await journal().accept(secondUpload.uploadId,'creator',body);
  const concurrent=await Promise.all([journal().complete(secondUpload.uploadId,work,'operator',{checksum,byteLength:body.length}),journal().complete(secondUpload.uploadId,work,'operator',{checksum,byteLength:body.length})]);
  assert.equal(concurrent[0].asset.id,concurrent[1].asset.id);assert.equal(concurrent[0].job.id,concurrent[1].job.id);
  console.log('Verified actual DynamoDB atomic asset/evidence/audit/upload receipts, unordered maps, concurrent completion and lost independent queue acknowledgement.');
 }finally{
  if(local)local.database.close();await rm(directory,{recursive:true,force:true});if(created)await client.send(new DeleteTableCommand({TableName:table}));client.destroy();
 }
});

test('actual DynamoDB job pagination finds later work and retains request traces through fenced retries',async()=>{
 const client=new DynamoDBClient({endpoint,region:'ca-central-1',maxAttempts:1,credentials:{accessKeyId:'DUMMYLOCALTEST',secretAccessKey:'DUMMYLOCALTEST'}}),document=DynamoDBDocumentClient.from(client);
 const table='queue-test-'+randomUUID();let created=false;
 try{
  await client.send(new CreateTableCommand({TableName:table,BillingMode:'PAY_PER_REQUEST',KeySchema:[{AttributeName:'pk',KeyType:'HASH'},{AttributeName:'sk',KeyType:'RANGE'}],AttributeDefinitions:[{AttributeName:'pk',AttributeType:'S'},{AttributeName:'sk',AttributeType:'S'},{AttributeName:'repository',AttributeType:'S'},{AttributeName:'id',AttributeType:'S'}],GlobalSecondaryIndexes:[{IndexName:'repository-id-index',KeySchema:[{AttributeName:'repository',KeyType:'HASH'},{AttributeName:'id',KeyType:'RANGE'}],Projection:{ProjectionType:'ALL'}}]}));created=true;
  const configuration={tableName:table,cellId:'queue-cell'},records=new DynamoRevisionedRepository(document,configuration,'durableJobs');
  for(let i=0;i<250;i++)await records.create({id:'a-history-'+String(i).padStart(3,'0'),cellId:'queue-cell',type:'work',payload:{},idempotencyKey:'history-'+i,state:'completed',attempt:1,maxAttempts:3,availableAt:new Date(0).toISOString()});
  const queue=new AwsJobQueue(document,configuration,{async send(){return {}; }},'http://localhost/unused-notification-fixture');
  const job=await queue.enqueue({cellId:'queue-cell',type:'work',payload:{},idempotencyKey:'trace-after-history',correlationId:'originating-request',maxAttempts:3});
  assert.deepEqual((await queue.list({cellId:'queue-cell',states:['queued'],limit:1})).map(j=>j.id),[job.id]);
  assert.equal((await queue.list({cellId:'queue-cell',states:[],limit:251})).length,251);
  const first=await queue.lease({cellId:'queue-cell',types:['work'],workerId:'first',leaseDurationSeconds:60});
  assert.ok(first);assert.equal(first.job.id,job.id);assert.equal(first.job.correlationId,'originating-request');
  await queue.retry({id:job.id,leaseToken:first.leaseToken,error:{code:'test',message:'synthetic retry'},retryAt:new Date(0).toISOString()});
  const second=await queue.lease({cellId:'queue-cell',types:['work'],workerId:'second',leaseDurationSeconds:60});
  assert.ok(second);assert.notEqual(second.leaseToken,first.leaseToken);assert.equal(second.job.correlationId,'originating-request');
  await assert.rejects(queue.complete({id:job.id,leaseToken:first.leaseToken}),/does not hold/);
  const raw=await records.get(job.id);assert.equal(raw.correlationId,'second:'+second.leaseToken);
  // Simulate an older writer retaining its existing lease protocol during a rolling upgrade.
  await records.update(job.id,raw.revision,{correlationId:'legacy:legacy-token'});
  await assert.rejects(queue.complete({id:job.id,leaseToken:second.leaseToken}),/does not hold/);
  await queue.complete({id:job.id,leaseToken:'legacy-token'});
  assert.equal((await queue.get(job.id)).state,'completed');assert.equal((await queue.get(job.id)).correlationId,'originating-request');
  console.log('Verified actual DynamoDB later-page leasing/listing, request correlation, retry fencing and legacy lease acknowledgement.');
 }finally{
  if(created)await client.send(new DeleteTableCommand({TableName:table}));client.destroy();
 }
});
