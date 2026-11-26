import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createLocalAdapterSet} from '@ubeeq/adapter-local';
import {createCoreRuntime} from '@ubeeq/runtime';
import {DynamoDBClient,CreateTableCommand,DeleteTableCommand} from '@aws-sdk/client-dynamodb';
import {DynamoDBDocumentClient} from '@aws-sdk/lib-dynamodb';
import {createDynamoRepositories} from '../dist/index.js';
import {createRetainedRepositoryCreator} from '@ubeeq/runtime/retained-repository-store';
import {retainedStore,scope,creatorInput,work} from '../../../packages/runtime/test/retained-repository-fixture.mjs';

const endpoint=process.env.TEST_DYNAMODB_ENDPOINT;
if(!endpoint||!/^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(endpoint))throw Error('An explicit loopback DynamoDB test endpoint is required.');
async function fixture(t,birth=true){
 const configuration={endpoint,region:scope.region,credentials:{accessKeyId:'DUMMYLOCALTEST',secretAccessKey:'DUMMYLOCALTEST'}},raw=new DynamoDBClient(configuration),otherRaw=new DynamoDBClient(configuration),client=DynamoDBDocumentClient.from(raw),other=DynamoDBDocumentClient.from(otherRaw),table='retained-repository-'+randomUUID();let created=false;
 t.after(async()=>{try{if(created)await raw.send(new DeleteTableCommand({TableName:table}));}finally{raw.destroy();otherRaw.destroy();}});
 await raw.send(new CreateTableCommand({TableName:table,BillingMode:'PAY_PER_REQUEST',KeySchema:[{AttributeName:'pk',KeyType:'HASH'},{AttributeName:'sk',KeyType:'RANGE'}],AttributeDefinitions:['pk','sk','repository','id'].map(AttributeName=>({AttributeName,AttributeType:'S'})),GlobalSecondaryIndexes:[{IndexName:'repository-id-index',KeySchema:[{AttributeName:'repository',KeyType:'HASH'},{AttributeName:'id',KeyType:'RANGE'}],Projection:{ProjectionType:'ALL'}}]}));created=true;
 const repositories=createDynamoRepositories(client,{tableName:table,cellId:'cell'}),independent=createDynamoRepositories(other,{tableName:table,cellId:'cell'});
 if(birth)await repositories.transaction(tx=>createRetainedRepositoryCreator(repositories,creatorInput,'tenant',tx));
 return {client,repositories,independent,store:()=>retainedStore(repositories)};
}

test('actual DynamoDB retains rich records and coalesces identical Creator guards into one physical condition',async t=>{
 const f=await fixture(t),store=f.store(),send=f.client.send.bind(f.client);let conditions=0;
 f.client.send=async(command,...rest)=>{if(command.constructor.name==='TransactWriteCommand')conditions=command.input.TransactItems.filter(item=>item.ConditionCheck?.Key?.pk==='creators#creator').length;return send(command,...rest);};
 await store.asActor('actor',async()=>{assert.equal(await store.authorizeActor('actor'),true);await store.createWork(work());await store.putRetainedEntity('audit','accepted',{actorId:'actor',workId:'work',detail:{opaque:'preserved'}});});
 assert.equal(conditions,1);assert.deepEqual(await f.store().getWork('tenant','work'),work());assert.equal((await f.store().getRetainedEntity('audit','accepted')).detail.opaque,'preserved');
 await assert.rejects(f.repositories.works.create({...creatorInput,id:'parallel',creatorId:'creator',title:'Wrong authority',status:'draft'}),{code:'creator_content_authority_conflict'});assert.equal(await f.repositories.works.get('parallel'),undefined);
});

test('actual DynamoDB creates seeded entities and their cohort once and rolls back a later failed birth step',async t=>{
 const f=await fixture(t,false),send=f.client.send.bind(f.client);let cohortWrites=0;
 f.client.send=async(command,...rest)=>{if(command.constructor.name==='TransactWriteCommand')cohortWrites+=command.input.TransactItems.filter(item=>item.Put?.Item?.repository==='hostRecords'&&item.Put.Item.value?.namespace==='retained-creator-content'&&item.Put.Item.value.key==='cohort').length;return send(command,...rest);};
 const initial=[{kind:'settings',key:'state',value:{tenantId:'tenant',creatorId:'creator',revision:0,presets:[],opaque:{keep:['complete','JSON']}}},{kind:'origin',key:'birth',value:{kind:'actual-birth'}}];
 await f.repositories.transaction(tx=>createRetainedRepositoryCreator(f.repositories,creatorInput,'tenant',tx,initial));assert.equal(cohortWrites,1);
 const reopened=retainedStore(f.independent),saved=await reopened.getRetainedEntity('settings','state');assert.deepEqual(saved,initial[0].value);assert.equal((await reopened.getRetainedEntity('origin','birth')).kind,'actual-birth');
 await reopened.asActor('actor',()=>reopened.putRetainedEntity('settings','state',{...saved,revision:1}));assert.equal((await f.store().getRetainedEntity('settings','state')).revision,1);
 const failed=await fixture(t,false);await assert.rejects(failed.repositories.transaction(async tx=>{await createRetainedRepositoryCreator(failed.repositories,creatorInput,'tenant',tx,initial);throw Error('Synthetic later lifecycle failure');}),/Synthetic later lifecycle failure/);
 assert.equal(await failed.repositories.creators.get('creator'),undefined);assert.deepEqual((await failed.repositories.hostRecords.snapshot()).items,[]);
});

test('different guards and guarded-item writes still poison the whole actual Dynamo transaction',async t=>{
 const f=await fixture(t),repo=f.repositories;
 await assert.rejects(repo.transaction(async transaction=>{
  await repo.creators.checkRevision('creator',1,{transaction});
  await assert.rejects(repo.creators.checkRevision('creator',2,{transaction}),{name:'OptimisticConcurrencyError'});
  await repo.auditEvents.create({...creatorInput,id:'conflict',action:'must.rollback',payload:{}},{transaction});
 }),/aborted/);assert.equal(await repo.auditEvents.get('conflict'),undefined);
 await assert.rejects(repo.transaction(async transaction=>{await repo.creators.checkRevision('creator',1,{transaction});await repo.creators.update('creator',1,{displayName:'Must roll back'},{transaction});}),/guarded item/);
 assert.equal((await repo.creators.get('creator')).displayName,creatorInput.displayName);
});

test('revocation after staging rolls back rich content, its command receipt and audit together',async t=>{
 const f=await fixture(t),store=f.store(),send=f.client.send.bind(f.client);let revoke=true;
 f.client.send=async(command,...rest)=>{
  if(revoke&&command.constructor.name==='TransactWriteCommand'&&command.input.TransactItems.some(item=>item.Put?.Item?.value?.value?.kind==='works')){
   revoke=false;await f.independent.creators.update('creator',1,{subjectId:'new-owner'});
  }return send(command,...rest);
 };
 await assert.rejects(store.asActor('actor',async()=>{await store.createWork(work());await store.publicationAtomic.put('content-workflow:tenant:creator:operation','accepted',{id:'accepted',actorId:'actor',state:'accepted'});await store.putRetainedEntity('audit','must-rollback',{workId:'work'});}),{name:'OptimisticConcurrencyError'});
 assert.equal(revoke,false);assert.equal(await f.store().getWork('tenant','work'),null);
 assert.equal(await f.store().publicationAtomic.get('content-workflow:tenant:creator:operation','accepted'),undefined);assert.equal(await f.store().getRetainedEntity('audit','must-rollback'),undefined);
 assert.equal(await store.authorizeActor('actor'),false);assert.equal(await store.authorizeActor('new-owner'),true);
});

test('exceeding the actual physical transaction budget never leaves a partial rich inventory',async t=>{
 const f=await fixture(t),store=f.store();await assert.rejects(store.asActor('actor',async()=>{for(let i=0;i<100;i++)await store.createWork(work('work-'+i));}),/at most 100/);
 assert.deepEqual(await f.store().listWorksByCreator('tenant','creator'),[]);
});


test('actual HTTP retained birth joins Creator, storage cohort, host preparation and intake receipt in one Dynamo transaction',async t=>{
 const f=await fixture(t,false),directory=await mkdtemp(join(tmpdir(),'retained-dynamo-intake-')),local=createLocalAdapterSet({databasePath:join(directory,'identity.sqlite'),dataDirectory:directory,cellId:'cell',publicBaseUrl:'http://localhost'});
 let fail=true,births=0,preparations=0;
 const unused=()=>{throw Error('This birth acceptance test does not install preparation, media or publication drivers.');};
 const runtime=createCoreRuntime({instanceId:'instance',cellId:'cell',region:scope.region,publicBaseUrl:'http://localhost',adapters:{repositories:f.repositories,storage:local.storage,uploads:local.storage,delivery:local.storage,jobs:local.jobs,identity:local.identity,localIdentity:local.identity},
  creatorLifecycle:{prepare:async input=>{preparations++;const {creator,repositories,transaction}=input;assert.equal(creator.contentAuthority,'retained-v1');await repositories.hostRecords.create({id:'birth-'+creator.id,instanceId:creator.instanceId,homeCellId:creator.homeCellId,dataHomeRegion:creator.dataHomeRegion,dataHomeAssignedAt:creator.dataHomeAssignedAt,routingRevision:creator.routingRevision,namespace:'test-host-birth',scopeId:creator.id,key:'birth',value:{actorId:input.actorUserId}},{transaction});if(fail)throw Error('Synthetic host preparation failure');}},
  contentPreparation:()=>({createCreator:async input=>{births++;return createRetainedRepositoryCreator(input.repositories,input.record,'tenant',input.transaction);},access:unused,createService:unused,createRelease:unused,enabled:()=>false,durableDrafts:unused,offerings:unused,announcementDestinations:unused,destinations:unused,managementUrl:unused,runNextJob:unused})});
 t.after(async()=>{await runtime.close();local.database.close();await rm(directory,{recursive:true,force:true});});
 const credentials={email:'retained-owner@example.test',password:'Synthetic local password 123!'},account=await local.identity.register(credentials),signed=await local.identity.authenticate(credentials);
 await new Promise(resolve=>runtime.server.listen(0,'127.0.0.1',resolve));
 const call=async()=>{const response=await fetch(`http://127.0.0.1:${runtime.server.address().port}/v1/creators`,{method:'POST',headers:{authorization:'Bearer '+signed.token,'content-type':'application/json'},body:JSON.stringify({handle:'retained-owner',displayName:'Retained Owner',idempotencyKey:'actual-birth'})});return {status:response.status,body:await response.json()};};
 assert.equal((await call()).status,500);assert.equal(await f.repositories.instanceOperators.get('instance'),undefined);assert.deepEqual((await f.repositories.hostRecords.snapshot()).items,[]);assert.deepEqual((await f.repositories.creators.list({limit:100})).items,[]);
 fail=false;const created=await call();assert.equal(created.status,202,JSON.stringify(created.body));const id=created.body.creator.id;
 assert.equal(created.body.creator.subjectId,account.subjectId);assert.equal(created.body.creator.contentAuthority,'retained-v1');assert.equal((await f.repositories.instanceOperators.get('instance')).actorId,account.subjectId);
 const recovered=await call();assert.equal(recovered.body.creator.id,id);assert.equal(births,2);assert.equal(preparations,2,'neither callback repeats after the successful commit');
 const store=retainedStore(f.repositories,{}, {...scope,creatorId:id});assert.deepEqual(await store.listWorksByCreator('tenant',id),[],'the empty inventory belongs to a proven newly born Creator');
 const rows=(await f.repositories.hostRecords.snapshot()).items;assert.equal(rows.filter(row=>row.namespace==='retained-creator-content').length,1);assert.equal(rows.filter(row=>row.namespace==='test-host-birth').length,1);assert.equal(rows.filter(row=>row.namespace==='runtime-creator-intake').length,1);
});

const mutationEntity=()=>({tenantId:'tenant',creatorId:'creator',externalPublicationId:'publication',externalAccountId:'connection',externalContentId:'pending:publication',assetId:'work',rawMetadataJson:{nested:{all:['unknown','fields']}},opaque:{keep:true}});
const mutationNext=value=>({...value,externalContentId:'remote',rawMetadataJson:{...value.rawMetadataJson,observedId:'remote'}});
const rawEntityPut=(item,kind)=>item.Put?.Item?.repository==='hostRecords'&&item.Put.Item.value?.namespace==='retained-creator-content'&&item.Put.Item.value.value?.category==='entity'&&item.Put.Item.value.value.kind===kind;

test('actual Dynamo move removes old key, creates target and advances cohort in one conditional transaction without a success mirror',async t=>{
 const f=await fixture(t),store=f.store(),kind='compatibility-publication',source=mutationEntity(),next=mutationNext(source);
 await store.asActor('actor',()=>store.putRetainedEntity(kind,'old',source));
 const before=(await f.repositories.hostRecords.snapshot()).items,original=before.find(row=>row.value.category==='entity'&&row.value.kind===kind),send=f.client.send.bind(f.client);let writes;
 await assert.rejects(store.asActor('actor',async()=>{
  await store.createWork(work());
  await assert.rejects(store.removeRetainedEntity({kind,key:'old',expected:{}}),{code:'retained_entity_conflict'});
 }),/failed or unawaited/);
 assert.equal(await f.store().getWork('tenant','work'),null);assert.deepEqual((await f.repositories.hostRecords.snapshot()).items,before);
 f.client.send=async(command,...rest)=>{if(command.constructor.name==='TransactWriteCommand'&&command.input.TransactItems.some(item=>item.Delete?.Key?.pk==='hostRecords#'+original.id))writes=structuredClone(command.input.TransactItems);return send(command,...rest);};
 await store.asActor('actor',()=>store.moveRetainedEntity({kind,fromKey:'old',toKey:'new',expected:source,next}));
 assert.ok(writes);assert.equal(writes.filter(item=>item.Delete?.Key?.pk==='hostRecords#'+original.id).length,1);
 assert.equal(writes.filter(item=>rawEntityPut(item,kind)).length,1);assert.equal(writes.filter(item=>item.Put?.Item?.value?.namespace==='retained-creator-content'&&item.Put.Item.value.key==='cohort').length,1);
 const reopened=retainedStore(f.independent);assert.equal(await reopened.getRetainedEntity(kind,'old'),undefined);assert.deepEqual(await reopened.getRetainedEntity(kind,'new'),next);
 assert.equal((await f.independent.hostRecords.snapshot()).items.length,before.length,'No new provider-operation success record is created.');
 await assert.rejects(reopened.asActor('actor',()=>reopened.moveRetainedEntity({kind,fromKey:'old',toKey:'new',expected:source,next})),{code:'retained_entity_conflict',status:409});
 await reopened.asActor('actor',()=>reopened.removeRetainedEntity({kind,key:'new',expected:next}));assert.equal(await f.store().getRetainedEntity(kind,'new'),undefined);
});

test('actual Dynamo independent moves contend on absent target and retain the losing original entity',async t=>{
 const f=await fixture(t),a=f.store(),b=retainedStore(f.independent),kind='compatibility-publication',left=mutationEntity(),right={...mutationEntity(),externalPublicationId:'other-publication'};
 await a.asActor('actor',async()=>{await a.putRetainedEntity(kind,'left',left);await a.putRetainedEntity(kind,'right',right);});
 const results=await Promise.allSettled([a.asActor('actor',()=>a.moveRetainedEntity({kind,fromKey:'left',toKey:'target',expected:left,next:mutationNext(left)})),b.asActor('actor',()=>b.moveRetainedEntity({kind,fromKey:'right',toKey:'target',expected:right,next:mutationNext(right)}))]);
 assert.equal(results.filter(result=>result.status==='fulfilled').length,1);assert.equal(results.filter(result=>result.status==='rejected').length,1);
 const rows=await f.store().listRetainedEntities(kind),target=await f.store().getRetainedEntity(kind,'target');assert.equal(rows.length,2);assert.ok([left.externalPublicationId,right.externalPublicationId].includes(target.externalPublicationId));
 const loser=target.externalPublicationId===left.externalPublicationId?{key:'right',value:right}:{key:'left',value:left};assert.deepEqual(await f.store().getRetainedEntity(kind,loser.key),loser.value);
});

test('actual Dynamo target insertion after staging prevents deletion and preserves the competing target without inferred replay',async t=>{
 const f=await fixture(t),store=f.store(),competitor=retainedStore(f.independent),kind='compatibility-publication',source=mutationEntity(),next=mutationNext(source);
 await store.asActor('actor',()=>store.putRetainedEntity(kind,'old',source));
 const original=(await f.repositories.hostRecords.snapshot()).items.find(row=>row.value.category==='entity'&&row.value.kind===kind),send=f.client.send.bind(f.client);let inserted=false;
 f.client.send=async(command,...rest)=>{if(!inserted&&command.constructor.name==='TransactWriteCommand'&&command.input.TransactItems.some(item=>item.Delete?.Key?.pk==='hostRecords#'+original.id)){
  inserted=true;await competitor.asActor('actor',()=>competitor.putRetainedEntity(kind,'target',next));
 }return send(command,...rest);};
 await assert.rejects(store.asActor('actor',()=>store.moveRetainedEntity({kind,fromKey:'old',toKey:'target',expected:source,next})),{name:'OptimisticConcurrencyError'});
 assert.equal(inserted,true);assert.deepEqual(await competitor.getRetainedEntity(kind,'old'),source);assert.deepEqual(await competitor.getRetainedEntity(kind,'target'),next);
 await assert.rejects(store.asActor('actor',()=>store.moveRetainedEntity({kind,fromKey:'old',toKey:'target',expected:source,next})),{code:'retained_entity_conflict'});
});

test('actual Dynamo owner revocation rolls back entity removal/move and canonical changes together',async t=>{
 const f=await fixture(t),store=f.store(),kind='compatibility-publication',source=mutationEntity(),next=mutationNext(source);
 await store.asActor('actor',()=>store.putRetainedEntity(kind,'old',source));
 const original=(await f.repositories.hostRecords.snapshot()).items.find(row=>row.value.category==='entity'&&row.value.kind===kind),send=f.client.send.bind(f.client);let revoked=false;
 f.client.send=async(command,...rest)=>{if(!revoked&&command.constructor.name==='TransactWriteCommand'&&command.input.TransactItems.some(item=>item.Delete?.Key?.pk==='hostRecords#'+original.id)){
  revoked=true;const creator=await f.independent.creators.get('creator');await f.independent.creators.update(creator.id,creator.revision,{subjectId:'new-owner'});
 }return send(command,...rest);};
 await assert.rejects(store.asActor('actor',async()=>{await store.createWork(work());await store.moveRetainedEntity({kind,fromKey:'old',toKey:'new',expected:source,next});}),{name:'OptimisticConcurrencyError'});
 assert.equal(revoked,true);assert.deepEqual(await f.store().getRetainedEntity(kind,'old'),source);assert.equal(await f.store().getRetainedEntity(kind,'new'),undefined);assert.equal(await f.store().getWork('tenant','work'),null);
 await assert.rejects(store.asActor('actor',()=>store.removeRetainedEntity({kind,key:'old',expected:source})),{code:'access_denied'});
 await store.asActor('new-owner',()=>store.removeRetainedEntity({kind,key:'old',expected:source}));assert.equal(await f.store().getRetainedEntity(kind,'old'),undefined);
});
