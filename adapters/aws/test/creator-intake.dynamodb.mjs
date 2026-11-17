import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { DynamoDBClient, CreateTableCommand, DeleteTableCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { createDynamoRepositories } from '@ubeeq/adapter-aws';
import { createIntakeCreator, persistIntakeCreator } from '../../../packages/runtime/dist/creator-intake.js';
import { createRetainedRepositoryCreator } from '../../../packages/runtime/dist/retained-repository-store.js';
import {finalizeRetainedCreatorRemoval} from '@ubeeq/persistence';

const endpoint=process.env.TEST_DYNAMODB_ENDPOINT;
if(!endpoint||!/^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(endpoint))throw Error('An explicit loopback DynamoDB test endpoint is required.');
async function fixture(t){
 const region='ca-central-1',credentials={accessKeyId:'DUMMYLOCALTEST',secretAccessKey:'DUMMYLOCALTEST'},raw=new DynamoDBClient({region,endpoint,credentials}),otherRaw=new DynamoDBClient({region,endpoint,credentials}),client=DynamoDBDocumentClient.from(raw),other=DynamoDBDocumentClient.from(otherRaw),table='creator-intake-'+randomUUID();let created=false;
 t.after(async()=>{try{if(created)await raw.send(new DeleteTableCommand({TableName:table}));}finally{raw.destroy();otherRaw.destroy();}});
 await raw.send(new CreateTableCommand({TableName:table,BillingMode:'PAY_PER_REQUEST',KeySchema:[{AttributeName:'pk',KeyType:'HASH'},{AttributeName:'sk',KeyType:'RANGE'}],AttributeDefinitions:['pk','sk','repository','id'].map(AttributeName=>({AttributeName,AttributeType:'S'})),GlobalSecondaryIndexes:[{IndexName:'repository-id-index',KeySchema:[{AttributeName:'repository',KeyType:'HASH'},{AttributeName:'id',KeyType:'RANGE'}],Projection:{ProjectionType:'ALL'}}]}));created=true;
 const repositories=createDynamoRepositories(client,{tableName:table,cellId:'cell'}),independent=createDynamoRepositories(other,{tableName:table,cellId:'cell'}),home={homeCellId:'cell',dataHomeRegion:region,dataHomeAssignedAt:new Date().toISOString(),routingRevision:1},input={instanceId:'instance',cellId:'cell',region,actorId:'actor',handle:'creator',displayName:'Creator',idempotencyKey:'request'};
 const create=repo=>async(transaction,id)=>{const creator=await repo.creators.create({id,instanceId:input.instanceId,...home,subjectId:input.actorId,handle:input.handle,displayName:input.displayName},{transaction});await repo.hostRecords.create({id:'birth-'+id,instanceId:input.instanceId,...home,namespace:'test-birth',scopeId:id,key:'birth',value:{creatorId:id,actorId:input.actorId}},{transaction});return creator;};
 return {client,table,repositories,independent,home,input,create,rows:async()=>(await client.send(new ScanCommand({TableName:table}))).Items};
}
function assertCompleteCreation(rows){
 assert.equal(rows.filter(row=>row.repository).length,4,'Creator, host birth, collection directory and receipt remain unchanged');
 const markers=rows.filter(row=>!row.repository);assert.equal(markers.length,2);
 assert.deepEqual(markers.map(row=>row.pk).sort(),['__ubeeq_repository_snapshot#creators','__ubeeq_repository_snapshot#hostRecords']);
 for(const marker of markers){assert.equal(marker.sk,'fence');assert.match(marker.version,/^[0-9a-f-]{36}$/);}
 assert.equal(rows.length,6,'both mutation markers commit with the original four records');
}
test('actual Creator, host birth and request receipt commit together and recover a lost transaction response',async t=>{
 const f=await fixture(t),send=f.client.send.bind(f.client);let lost=false;
 f.client.send=async(command,...rest)=>{const result=await send(command,...rest);if(!lost&&command instanceof TransactWriteCommand&&command.input.TransactItems?.some(item=>item.Put?.Item?.repository==='creators')){lost=true;throw Error('Synthetic accepted response lost');}return result;};
 const first=await createIntakeCreator(f.repositories,f.input,f.create(f.repositories)),second=await createIntakeCreator(f.independent,f.input,f.create(f.independent));assert.equal(lost,true);assert.equal(first.id,second.id);assertCompleteCreation(await f.rows());
});
test('actual concurrent Creator receipts converge and failed preparation leaves no partial records',async t=>{
 const f=await fixture(t);
 await assert.rejects(createIntakeCreator(f.repositories,f.input,async(transaction,id)=>{await f.create(f.repositories)(transaction,id);throw Error('Host preparation failed');}),/Host preparation failed/);assert.deepEqual(await f.rows(),[]);
 const results=await Promise.all([createIntakeCreator(f.repositories,f.input,f.create(f.repositories)),createIntakeCreator(f.independent,f.input,f.create(f.independent))]);assert.equal(results[0].id,results[1].id);assertCompleteCreation(await f.rows());
});

const birthRecord=(f,id,input=f.input)=>({id,instanceId:input.instanceId,...f.home,subjectId:input.actorId,handle:input.handle,displayName:input.displayName});
const birthHostRecord=(f,id,kind,value)=>({id:kind+'-'+id,instanceId:f.input.instanceId,...f.home,namespace:kind,scopeId:id,key:kind,value});

test('actual Dynamo prepared inventory is captured outside writes and lost-reply replay never resets rich defaults or financial birth',async t=>{
 const f=await fixture(t),send=f.client.send.bind(f.client);let lost=false,prepared=0,written=0,births=0;
 f.client.send=async(command,...rest)=>{const result=await send(command,...rest);if(!lost&&command instanceof TransactWriteCommand&&command.input.TransactItems?.some(item=>item.Put?.Item?.repository==='creators')){lost=true;throw Error('Synthetic accepted response lost');}return result;};
 const prepare=async({intent,repositories,creatorId})=>{
  prepared++;assert.equal(Object.isFrozen(intent),true);assert.deepEqual(intent,f.input);assert.equal(repositories,f.repositories);
  // The actual adapter rejects this call if a write transaction is active.
  const snapshot=await repositories.creators.snapshot();
  return async input=>{written++;assert.equal(input.record.id,creatorId);await snapshot.bind(input.transaction);const creator=await createRetainedRepositoryCreator(repositories,input.record,'tenant',input.transaction);
   await repositories.hostRecords.create(birthHostRecord(f,creator.id,'rich-profile',{watermarkPresets:[{id:'original',opacity:.7}],opaque:{legacy:true}}),{transaction:input.transaction});return creator;};
 };
 const create=async(transaction,id,factory)=>{const creator=await persistIntakeCreator(f.repositories,birthRecord(f,id),f.input.actorId,transaction,factory);births++;
  await f.repositories.hostRecords.create(birthHostRecord(f,id,'financial-birth',{creatorId:id,ownerUserId:f.input.actorId}),{transaction});return creator;};
 const creator=await createIntakeCreator(f.repositories,f.input,create,prepare);
 assert.equal(lost,true);assert.equal(prepared,1);assert.equal(written,1);assert.equal(births,1);
 await f.independent.creators.update(creator.id,creator.revision,{displayName:'Edited after birth'});
 const profile=await f.independent.hostRecords.get('rich-profile-'+creator.id);
 await f.independent.hostRecords.update(profile.id,profile.revision,{value:{watermarkPresets:[{id:'edited',opacity:.25}],opaque:{legacy:true,changed:true}}});
 const replay=await createIntakeCreator(f.independent,f.input,()=>{assert.fail('Replay must not enter any birth writer.');},async()=>{assert.fail('Replay must recover before preparation.');});
 assert.equal(replay.displayName,'Edited after birth');assert.deepEqual((await f.repositories.hostRecords.get(profile.id)).value,{watermarkPresets:[{id:'edited',opacity:.25}],opaque:{legacy:true,changed:true}});
 const rows=await f.rows();assert.equal(rows.filter(row=>row.repository==='creators').length,1);assert.equal(rows.filter(row=>row.value?.namespace==='financial-birth').length,1);assert.equal(rows.filter(row=>row.value?.namespace==='runtime-creator-intake').length,1);
 assert.equal(prepared,1);assert.equal(written,1);assert.equal(births,1);
});

test('actual Dynamo concurrent inventory change rolls back canonical Creator, retained cohort, profile, financial birth and receipt together',async t=>{
 const f=await fixture(t);let before,competitor,written=0;
 await assert.rejects(createIntakeCreator(f.repositories,f.input,async(transaction,id,factory)=>{
  const creator=await persistIntakeCreator(f.repositories,birthRecord(f,id),f.input.actorId,transaction,factory);
  await f.repositories.hostRecords.create(birthHostRecord(f,id,'financial-birth',{creatorId:id}),{transaction});return creator;
 },async()=>{
  const snapshot=await f.repositories.creators.snapshot(),other={...f.input,idempotencyKey:'competing-birth',handle:'competing',displayName:'Competing'};
  competitor=await createIntakeCreator(f.independent,other,(transaction,id)=>persistIntakeCreator(f.independent,birthRecord(f,id,other),other.actorId,transaction));
  before=await f.rows();
  return async input=>{written++;await snapshot.bind(input.transaction);const creator=await createRetainedRepositoryCreator(f.repositories,input.record,'tenant',input.transaction);
   await f.repositories.hostRecords.create(birthHostRecord(f,creator.id,'rich-profile',{opaque:{intake:true}}),{transaction:input.transaction});return creator;};
 }),error=>error.constructor.name==='OptimisticConcurrencyError');
 assert.equal(written,1,'the transaction stages real records before its guarded commit rejects');
 const ordered=rows=>rows.sort((a,b)=>(a.pk+'|'+a.sk).localeCompare(b.pk+'|'+b.sk));
 assert.deepEqual(ordered(await f.rows()),ordered(before));assert.equal((await f.repositories.creators.get(competitor.id)).displayName,'Competing');
});

test('actual Dynamo receipt committed while preparation fails is recovered without entering another writer',async t=>{
 const f=await fixture(t);let concurrent,prepared=0;
 const recovered=await createIntakeCreator(f.repositories,f.input,()=>{assert.fail('A duplicate accepting writer must not run.');},async()=>{
  prepared++;concurrent=await createIntakeCreator(f.independent,f.input,f.create(f.independent));throw Error('Concurrent preparation became stale');
 });
 assert.equal(prepared,1);assert.equal(recovered.id,concurrent.id);assertCompleteCreation(await f.rows());
});

test('actual Dynamo existing Creator without an intake receipt never bootstraps retained content or financial birth',async t=>{
 const f=await fixture(t),key=createHash('sha256').update(JSON.stringify([f.input.instanceId,f.input.actorId,f.input.idempotencyKey])).digest('hex'),id='creator-'+key;
 const existing=await f.repositories.creators.create(birthRecord(f,id)),before=await f.rows();let writes=0;
 await assert.rejects(createIntakeCreator(f.repositories,f.input,(transaction,creatorId,factory)=>persistIntakeCreator(f.repositories,birthRecord(f,creatorId),f.input.actorId,transaction,factory),async()=>async input=>{
  writes++;await f.repositories.hostRecords.create(birthHostRecord(f,id,'rich-profile',{invented:true}),{transaction:input.transaction});return existing;
 }),{code:'creator_intake_requires_reconciliation'});
 assert.equal(writes,0);assert.deepEqual(await f.repositories.creators.get(id),existing);assert.deepEqual(await f.rows(),before);
});

test('actual Dynamo finalization binds the host inventory and atomically retains the full original Creator archive',async t=>{
 const f=await fixture(t),r=f.repositories;
 const creator=await createIntakeCreator(r,f.input,(transaction,id)=>persistIntakeCreator(r,birthRecord(f,id),f.input.actorId,transaction,input=>createRetainedRepositoryCreator(r,input.record,'tenant',input.transaction)));
 await assert.rejects(r.creators.remove(creator.id,creator.revision),{code:'creator_content_authority_conflict'});
 const stale=await r.hostRecords.snapshot();
 await f.independent.hostRecords.create(birthHostRecord(f,creator.id,'actual-later-domain-record',{creatorId:creator.id}));
 const archive=birthHostRecord(f,creator.id,'actual-removal-archive',{creator});
 await assert.rejects(finalizeRetainedCreatorRemoval(r,{expected:creator,authorize:async(_actual,transaction)=>{await stale.bind(transaction);await r.hostRecords.create(archive,{transaction});}}));
 assert.deepEqual(await r.creators.get(creator.id),creator);assert.equal(await r.hostRecords.get(archive.id),undefined);
 const current=await r.hostRecords.snapshot();
 await finalizeRetainedCreatorRemoval(r,{expected:creator,authorize:async(actual,transaction)=>{assert.equal(Object.isFrozen(actual),true);assert.notEqual(actual,creator);assert.deepEqual(actual,creator);await current.bind(transaction);await r.hostRecords.create(archive,{transaction});}});
 assert.equal(await r.creators.get(creator.id),undefined);assert.deepEqual((await r.hostRecords.get(archive.id)).value.creator,creator);
});

test('actual Dynamo caught removal on an independent coordinator poisons the accepting finalization and preserves its archive boundary',async t=>{
 const f=await fixture(t),r=f.repositories;
 const creator=await createIntakeCreator(r,f.input,(transaction,id)=>persistIntakeCreator(r,birthRecord(f,id),f.input.actorId,transaction,input=>createRetainedRepositoryCreator(r,input.record,'tenant',input.transaction)));
 const remove=r.creators.remove.bind(r.creators);let rejected=false;
 r.creators.remove=async(...args)=>{try{await f.independent.creators.remove(creator.id,creator.revision);}catch(error){assert.equal(error.code,'creator_content_authority_conflict');rejected=true;}return remove(...args);};
 const archive=birthHostRecord(f,creator.id,'rejected-removal-archive',{creator});
 await assert.rejects(finalizeRetainedCreatorRemoval(r,{expected:creator,authorize:async(_actual,transaction)=>{await r.hostRecords.create(archive,{transaction});}}));
 assert.equal(rejected,true);assert.deepEqual(await r.creators.get(creator.id),creator);assert.equal(await r.hostRecords.get(archive.id),undefined);
});
