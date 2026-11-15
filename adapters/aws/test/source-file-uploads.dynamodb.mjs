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
import {createRetainedRepositoryCreator} from '@ubeeq/runtime/retained-repository-store';
import {SourceFileUploads,sourceFileOriginalObjectKey} from '@ubeeq/runtime/source-file-uploads';
import {sourceStore,sourceFile,sourceAudit,actorRecord,scope,creatorInput} from '../../../packages/runtime/test/retained-source-fixture.mjs';
const endpoint=process.env.TEST_DYNAMODB_ENDPOINT;
if(!endpoint||!/^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(endpoint))throw Error('An explicit loopback DynamoDB endpoint is required; this test never uses AWS.');
const body=Buffer.from('Actual local original with DynamoDB metadata'),checksum=createHash('sha256').update(body).digest('hex');
async function fixture(t){
 const config={endpoint,region:scope.region,credentials:{accessKeyId:'DUMMYLOCALTEST',secretAccessKey:'DUMMYLOCALTEST'}},raw=new DynamoDBClient(config),otherRaw=new DynamoDBClient(config),client=DynamoDBDocumentClient.from(raw),other=DynamoDBDocumentClient.from(otherRaw),table='source-upload-'+randomUUID(),directory=await mkdtemp(join(tmpdir(),'source-upload-dynamo-'));let created=false;
 const local=createLocalAdapterSet({databasePath:join(directory,'provider.sqlite'),dataDirectory:directory,cellId:scope.cellId,publicBaseUrl:'http://127.0.0.1'});
 t.after(async()=>{try{if(created)await raw.send(new DeleteTableCommand({TableName:table}));}finally{raw.destroy();otherRaw.destroy();local.database.close();await rm(directory,{recursive:true,force:true});}});
 await raw.send(new CreateTableCommand({TableName:table,BillingMode:'PAY_PER_REQUEST',KeySchema:[{AttributeName:'pk',KeyType:'HASH'},{AttributeName:'sk',KeyType:'RANGE'}],AttributeDefinitions:['pk','sk','repository','id'].map(AttributeName=>({AttributeName,AttributeType:'S'})),GlobalSecondaryIndexes:[{IndexName:'repository-id-index',KeySchema:[{AttributeName:'repository',KeyType:'HASH'},{AttributeName:'id',KeyType:'RANGE'}],Projection:{ProjectionType:'ALL'}}]}));created=true;
 const repositories=createDynamoRepositories(client,{tableName:table,cellId:scope.cellId}),independent=createDynamoRepositories(other,{tableName:table,cellId:scope.cellId});
 await repositories.transaction(tx=>createRetainedRepositoryCreator(repositories,creatorInput,scope.tenantId,tx));await repositories.hostRecords.create(actorRecord);
 const reservations=new Map(),settlements=new Map(),closures=new Map();
 // This suite accepts physical bytes only through the actual local provider.
 // Quota is a validating unit port; managed financial quota has its own suite.
 const quota={async checkAndReserveQuota(input){const previous=reservations.get(input.idempotencyKey);if(previous)assert.deepEqual(previous,input);reservations.set(input.idempotencyKey,structuredClone(input));return {allowed:!closures.has(input.idempotencyKey)};},async recordUsageSettlement(input){const reserved=reservations.get(input.idempotencyKey);assert.ok(reserved);assert.equal(reserved.storageBytesDelta,input.storageBytesDelta);const previous=settlements.get(input.idempotencyKey);if(previous)assert.deepEqual(previous,input);settlements.set(input.idempotencyKey,structuredClone(input));},async closeStorageReservation(input){assert.equal(settlements.has(input.idempotencyKey),false);const previous=closures.get(input.idempotencyKey);if(previous)assert.deepEqual(previous,input);closures.set(input.idempotencyKey,structuredClone(input));}};
 const bind=repo=>{const {store}=sourceStore(repo);return {store,uploads:new SourceFileUploads({repositories:repo,files:store,uploads:local.storage,quota,bucket:scope.cellId,prepareCompletion:async(file,object)=>{const loaded=await local.storage.get(object);assert.equal(loaded.object.versionId,object.versionId);return {checksumSha256:createHash('sha256').update(loaded.body).digest('hex'),sizeBytes:loaded.body.length,metadata:file.metadata};}})};};
 const bound=bind(repositories),file=sourceFile('original',{storageKey:sourceFileOriginalObjectKey({...scope,fileId:'original'}),sizeBytes:body.length});await bound.store.commitSourceFile({expected:null,file,audit:sourceAudit(),access:await bound.store.captureSourceAccess('actor')});
 const journal=async()=>(await repositories.hostRecords.list({limit:100})).items.find(row=>row.namespace==='runtime-source-file-upload');
 return {client,repositories,independent,local,bind,...bound,file,journal,reservations,settlements,closures};
}
test('actual Dynamo source, audit, immutable receipt and usage outbox roll back together, then recover the real physical effect',async t=>{
 const f=await fixture(t);await f.uploads.initiate({actorId:'actor',fileId:'original',checksumSha256:checksum});await f.uploads.accept({actorId:'actor',fileId:'original',body});
 const send=f.client.send.bind(f.client);let fail=true;
 f.client.send=async(command,...rest)=>{if(fail&&command.constructor.name==='TransactWriteCommand'&&command.input.TransactItems.some(item=>item.Put?.Item?.repository==='auditEvents'&&item.Put.Item.value.action==='source_file.upload.completed')){fail=false;throw Error('Actual accepting transaction interrupted before send');}return send(command,...rest);};
 await assert.rejects(f.uploads.complete({actorId:'actor',fileId:'original'}),/interrupted before send/);assert.equal(fail,false);
 const row=await f.journal();assert.equal(row.value.phase,'retained');assert.equal((await f.store.getSourceFileById('original')).uploadState,'pending');assert.equal((await f.repositories.auditEvents.list({limit:100})).items.filter(row=>row.action==='source_file.upload.completed').length,0);assert.equal(f.settlements.size,1);assert.deepEqual((await f.local.storage.get(row.value.completedObject)).body,body);
 const reopened=f.bind(f.independent);const results=await Promise.all([reopened.uploads.complete({actorId:'actor',fileId:'original'}),f.uploads.complete({actorId:'actor',fileId:'original'})]);assert.equal(results.every(result=>result.state==='completed'),true);assert.equal(results[0].object.versionId,row.value.completedObject.versionId);assert.equal(results[1].object.versionId,results[0].object.versionId);assert.equal((await reopened.store.getSourceFileById('original')).revision,2);assert.equal((await f.repositories.auditEvents.list({limit:100})).items.filter(row=>row.action==='source_file.upload.completed').length,1);assert.equal(f.settlements.size,1);assert.equal((await f.repositories.assets.list({limit:100})).items.length,0);assert.equal((await f.repositories.works.list({limit:100})).items.length,0);
});
test('actual Dynamo saved-actor revocation at acceptance retains/charges bytes and forbids source completion after reopen',async t=>{
 const f=await fixture(t);await f.uploads.initiate({actorId:'actor',fileId:'original',checksumSha256:checksum});await f.uploads.accept({actorId:'actor',fileId:'original',body});
 const send=f.client.send.bind(f.client);let revoke=true;
 f.client.send=async(command,...rest)=>{if(revoke&&command.constructor.name==='TransactWriteCommand'&&command.input.TransactItems.some(item=>item.Put?.Item?.repository==='auditEvents'&&item.Put.Item.value.action==='source_file.upload.completed')){revoke=false;await f.independent.hostRecords.update(actorRecord.id,1,{value:{...actorRecord.value,active:false}});}return send(command,...rest);};
 await assert.rejects(f.uploads.complete({actorId:'actor',fileId:'original'}),{code:'access_denied'});assert.equal(revoke,false);assert.equal((await f.store.getSourceFileById('original')).uploadState,'pending');assert.equal((await f.journal()).value.phase,'retained');assert.equal(f.settlements.size,1);assert.equal(f.closures.size,0);
 const reopened=f.bind(f.independent),result=await reopened.uploads.recover('original');assert.equal(result.state,'retained');assert.equal(result.file.uploadState,'pending');assert.deepEqual(result.object,await reopened.uploads.readPhysicalReceipt('original'));assert.equal((await f.repositories.auditEvents.list({limit:100})).items.filter(row=>row.action==='source_file.upload.completed').length,0);
});
