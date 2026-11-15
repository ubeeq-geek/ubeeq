import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DynamoDBClient,CreateTableCommand,DeleteTableCommand} from '@aws-sdk/client-dynamodb';
import {DynamoDBDocumentClient} from '@aws-sdk/lib-dynamodb';
import {createDynamoRepositories} from '../dist/index.js';
import {createRetainedRepositoryCreator} from '@ubeeq/runtime/retained-repository-store';
import {sourceStore,sourceFile,sourceAudit,actorRecord,scope,creatorInput,at} from '../../../packages/runtime/test/retained-source-fixture.mjs';
import {work} from '../../../packages/runtime/test/retained-repository-fixture.mjs';
const endpoint=process.env.TEST_DYNAMODB_ENDPOINT;
if(!endpoint||!/^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(endpoint))throw Error('An explicit loopback DynamoDB test endpoint is required.');
async function fixture(t){
 const config={endpoint,region:scope.region,credentials:{accessKeyId:'DUMMYLOCALTEST',secretAccessKey:'DUMMYLOCALTEST'}},raw=new DynamoDBClient(config),otherRaw=new DynamoDBClient(config),client=DynamoDBDocumentClient.from(raw),other=DynamoDBDocumentClient.from(otherRaw),table='retained-source-'+randomUUID();let created=false;
 t.after(async()=>{try{if(created)await raw.send(new DeleteTableCommand({TableName:table}));}finally{raw.destroy();otherRaw.destroy();}});
 await raw.send(new CreateTableCommand({TableName:table,BillingMode:'PAY_PER_REQUEST',KeySchema:[{AttributeName:'pk',KeyType:'HASH'},{AttributeName:'sk',KeyType:'RANGE'}],AttributeDefinitions:['pk','sk','repository','id'].map(AttributeName=>({AttributeName,AttributeType:'S'})),GlobalSecondaryIndexes:[{IndexName:'repository-id-index',KeySchema:[{AttributeName:'repository',KeyType:'HASH'},{AttributeName:'id',KeyType:'RANGE'}],Projection:{ProjectionType:'ALL'}}]}));created=true;
 const repositories=createDynamoRepositories(client,{tableName:table,cellId:'cell'}),independent=createDynamoRepositories(other,{tableName:table,cellId:'cell'});
 await repositories.transaction(tx=>createRetainedRepositoryCreator(repositories,creatorInput,'tenant',tx));await repositories.hostRecords.create(actorRecord);
 return {client,repositories,independent,...sourceStore(repositories),other:()=>sourceStore(independent)};
}
test('actual Dynamo source, audit and workflow command commit together and reopen unchanged',async t=>{
 const f=await fixture(t),file=sourceFile(),audit=sourceAudit(),access=await f.access();
 await f.store.asActor('actor',async()=>{await f.store.commitSourceFile({expected:null,file,audit,access});await f.store.publicationAtomic.put('content-workflow:tenant:creator:operation','staged',{id:'staged',actorId:'actor',sourceId:file.fileId});});
 const reopened=f.other().store;assert.deepEqual(await reopened.getSourceFileById(file.fileId),file);assert.deepEqual(await reopened.getSourceFileAudit(audit.auditId),audit);assert.equal((await reopened.publicationAtomic.get('content-workflow:tenant:creator:operation','staged')).sourceId,file.fileId);
 assert.equal((await f.repositories.assets.snapshot()).items.length,0);assert.equal((await f.repositories.auditEvents.list({limit:100})).items.length,1);
});
test('actual source acceptance rolls back source, audit and command after actor revocation at commit',async t=>{
 const f=await fixture(t),send=f.client.send.bind(f.client),access=await f.access();let revoke=true;
 f.client.send=async(command,...rest)=>{if(revoke&&command.constructor.name==='TransactWriteCommand'&&command.input.TransactItems.some(item=>item.Put?.Item?.repository==='auditEvents')){revoke=false;await f.independent.hostRecords.update(actorRecord.id,1,{value:{...actorRecord.value,active:false}});}return send(command,...rest);};
 await assert.rejects(f.store.asActor('actor',async()=>{await f.store.commitSourceFile({expected:null,file:sourceFile(),audit:sourceAudit(),access});await f.store.publicationAtomic.put('content-workflow:tenant:creator:operation','must-rollback',{id:'must-rollback',actorId:'actor'});}),{name:'OptimisticConcurrencyError'});
 assert.equal(revoke,false);assert.equal(await f.store.getSourceFileById('original'),null);assert.equal(await f.store.getSourceFileAudit('source-created'),null);assert.equal(await f.store.publicationAtomic.get('content-workflow:tenant:creator:operation','must-rollback'),undefined);
});
test('a cancelled-source checkpoint survives deletion and revocation but cannot smuggle canonical mutations',async t=>{
 const f=await fixture(t),pending=sourceFile(),access=await f.access();await f.store.commitSourceFile({expected:null,file:pending,audit:sourceAudit(),access});
 const cancelled={...pending,revision:2,uploadState:'cancelled',cancellation:{requestedAt:at,requestedByUserId:'actor'}};await f.store.commitSourceFile({expected:pending,file:cancelled,audit:sourceAudit('cancelled'),access:await f.access()});
 const creator=await f.repositories.creators.get('creator');await f.repositories.creators.update('creator',creator.revision,{deletion:{operationId:'delete'}});await f.repositories.hostRecords.update(actorRecord.id,1,{value:{...actorRecord.value,active:false}});
 const input={expected:cancelled,now:at,nextAttemptAt:'2026-11-15T00:01:00.000Z'},read=f.store.getSourceFileById.bind(f.store);let inject=true;
 f.store.getSourceFileById=async id=>{const value=await read(id);if(inject&&f.store.transaction()){inject=false;await f.store.createWork(work('unauthorized'));}return value;};
 await assert.rejects(f.store.commitSourceCleanup(input),{code:'access_denied'});assert.equal(await f.store.getWork('tenant','unauthorized'),null);assert.deepEqual(await f.store.getSourceFileById('original'),cancelled);assert.equal((await f.repositories.auditEvents.list({limit:100})).items.length,2);
 f.store.getSourceFileById=read;await f.store.commitSourceCleanup(input);const reopened=f.other().store;assert.equal((await reopened.getSourceFileById('original')).cancellation.cleanupAttempts,1);assert.equal((await f.repositories.auditEvents.list({limit:100})).items.filter(row=>row.action==='source_file.upload.cleanup_attempted').length,1);
});
test('a concurrent original edit cannot be overwritten by an older cleanup checkpoint',async t=>{
 const f=await fixture(t),pending=sourceFile();await f.store.commitSourceFile({expected:null,file:pending,audit:sourceAudit(),access:await f.access()});
 const cancelled={...pending,revision:2,uploadState:'cancelled',cancellation:{requestedAt:at,requestedByUserId:'actor'}};await f.store.commitSourceFile({expected:pending,file:cancelled,audit:sourceAudit('cancelled'),access:await f.access()});
 const send=f.client.send.bind(f.client);let race=true;
 f.client.send=async(command,...rest)=>{if(race&&command.constructor.name==='TransactWriteCommand'&&command.input.TransactItems.some(item=>item.Put?.Item?.repository==='auditEvents')){race=false;const other=f.other();await other.store.commitSourceFile({expected:cancelled,file:{...cancelled,revision:3,restricted:true},audit:sourceAudit('concurrent-edit'),access:await other.access()});}return send(command,...rest);};
 await assert.rejects(f.store.commitSourceCleanup({expected:cancelled,now:at,nextAttemptAt:'2026-11-15T00:01:00.000Z'}),{name:'OptimisticConcurrencyError'});assert.equal(race,false);const current=await f.store.getSourceFileById('original');assert.equal(current.restricted,true);assert.equal(current.cancellation.cleanupAttempts,undefined);assert.equal((await f.repositories.auditEvents.list({limit:100})).items.filter(row=>row.action==='source_file.upload.cleanup_attempted').length,0);
});
