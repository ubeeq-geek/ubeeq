import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash,randomUUID } from 'node:crypto';
import { DynamoDBClient,CreateTableCommand,DeleteTableCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient,GetCommand,ScanCommand } from '@aws-sdk/lib-dynamodb';
import { createDynamoRepositories,AwsJobQueue } from '../dist/index.js';
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
