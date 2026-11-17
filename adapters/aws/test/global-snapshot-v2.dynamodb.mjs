// SOURCE ONLY, NOT RUN. Requires this draft producer and raw-cohort-update.patch.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DynamoDBClient,CreateTableCommand,DeleteTableCommand} from '@aws-sdk/client-dynamodb';
import {DynamoDBDocumentClient,GetCommand,PutCommand,DeleteCommand,QueryCommand,TransactWriteCommand,ScanCommand} from '@aws-sdk/lib-dynamodb';
import {createLocalAdapterSet} from '@ubeeq/adapter-local';
import {createRetainedRepositoryCreator,RepositoryRetainedContentStore} from '@ubeeq/runtime/retained-repository-store';
import {DynamoRetainedCreatorContent,DynamoRevisionedRepository,createDynamoRepositories,createFreshGlobalSnapshotRealm,openGlobalSnapshotRealm} from '../dist/index.js';
import {scope,creatorInput,work} from '../../../packages/runtime/test/retained-repository-fixture.mjs';

const endpoint=process.env.TEST_DYNAMODB_ENDPOINT;
if(!endpoint||!/^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(endpoint))throw Error('An explicit loopback DynamoDB endpoint is required.');
const sorted=rows=>[...rows].sort((a,b)=>JSON.stringify([a.pk,a.sk]).localeCompare(JSON.stringify([b.pk,b.sk])));
const globalKey={pk:'__ubeeq_repository_snapshot#global-v2',sk:'fence'};
const isWorkPut=item=>item.Put?.Item?.repository==='hostRecords'&&item.Put.Item.value?.namespace==='retained-creator-content'&&item.Put.Item.value.value?.kind==='works';
async function fixture(t){
 const config={region:scope.region,endpoint,credentials:{accessKeyId:'DUMMYLOCALTEST',secretAccessKey:'DUMMYLOCALTEST'}},raw=new DynamoDBClient(config),otherRaw=new DynamoDBClient(config),table='global-snapshot-'+randomUUID(),directory=await mkdtemp(join(tmpdir(),'global-snapshot-'));
 const local=createLocalAdapterSet({databasePath:join(directory,'identity.sqlite'),dataDirectory:directory,cellId:scope.cellId,publicBaseUrl:'http://127.0.0.1'});
 t.after(async()=>{try{await raw.send(new DeleteTableCommand({TableName:table}));}finally{raw.destroy();otherRaw.destroy();local.database.close();await rm(directory,{recursive:true,force:true});}});
 const first=await createFreshGlobalSnapshotRealm(raw,{tableName:table,instanceId:scope.instanceId}),second=await openGlobalSnapshotRealm(otherRaw,{tableName:table,instanceId:scope.instanceId}),client=first.client,other=second.client;
 const repositories=createDynamoRepositories(client,{tableName:table,cellId:scope.cellId,globalSnapshotRealm:first.realm}),independent=createDynamoRepositories(other,{tableName:table,cellId:scope.cellId,globalSnapshotRealm:second.realm});
 const account=await local.identity.register({email:'owner@global-snapshot.test',password:'Actual persisted Local guard principal password 123!'}),actor=account.subjectId,creator={...creatorInput,subjectId:actor};
 await repositories.transaction(tx=>createRetainedRepositoryCreator(repositories,creator,scope.tenantId,tx));
 const home={instanceId:scope.instanceId,homeCellId:scope.cellId,dataHomeRegion:scope.region,dataHomeAssignedAt:creator.dataHomeAssignedAt,routingRevision:1};
 for(const [id,value]of [['profile',{status:'active',userId:actor}],['member',{role:'owner',userId:actor,creatorId:scope.creatorId}],['role',{role:'user',userId:actor}]])await repositories.hostRecords.create({id:'auth-'+id,...home,namespace:'unit-current-authority',scopeId:scope.creatorId,key:id,value});
 const store=()=>new RepositoryRetainedContentStore(repositories,scope,{
  async resolveActorRole(id,record,transaction){
   const principal=await local.identity.getAuthorizationSubject(id),account=await local.identity.getAccount(id),current=await repositories.creators.get(record.id,{transaction});await repositories.creators.checkRevision(current.id,current.revision,{transaction});
   const values={};for(const key of ['profile','member','role']){const row=await repositories.hostRecords.get('auth-'+key,{transaction});if(!row)return null;await repositories.hostRecords.checkRevision(row.id,row.revision,{transaction});values[key]=row.value;}
   await repositories.hostRecords.checkAbsent('auth-override',{transaction});
   // Honest neutral persistence unit authority over actual current records;
   // this does not claim Cognito/commercial/provider acceptance.
   return !!principal&&principal.id===id&&account?.status==='active'&&principal.accountScope!=='customer_account'&&current.subjectId===id&&values.profile.userId===id&&values.profile.status==='active'&&values.member.userId===id&&values.member.role==='owner'&&values.role.role==='user'?'owner':null;
  },validateAssetAttachment:async()=>{throw Error('No source/transform host is installed in this snapshot protocol test.');}
 });
 return {raw,otherRaw,table,client,other,repositories,independent,local,actor,creator,home,realm:first.realm,store,root:async()=>(await client.send(new GetCommand({TableName:table,Key:globalKey,ConsistentRead:true}))).Item};
}
async function seedWorks(f,count=99){const store=f.store();for(let start=0;start<count;start+=30)await store.asActor(f.actor,async()=>{for(let i=start;i<Math.min(start+30,count);i++)await store.createWork(work('work-'+i));});return store;}

test('actual global-v2 accepts99 full Work UPDATEs plus all current actor/Creator/absence guards in exactly100 operations',async t=>{
 const f=await fixture(t),store=await seedWorks(f),before=await f.repositories.hostRecords.snapshot(),cohort=before.items.find(row=>row.namespace==='retained-creator-content'&&row.key==='cohort'),original=await store.listWorksByCreator(scope.tenantId,scope.creatorId),send=f.client.send.bind(f.client);let accepted;
 f.client.send=async(command,...rest)=>{if(command.constructor.name==='TransactWriteCommand'&&command.input.TransactItems.filter(isWorkPut).length===99)accepted=structuredClone(command.input.TransactItems);return send(command,...rest);};
 try{await store.asActor(f.actor,()=>store.commitSharedWorkRevisions(original.map(row=>({work:{...row,title:'Changed '+row.workId,revision:row.revision+1},expectedRevision:row.revision}))));}finally{f.client.send=send;}
 assert.equal(accepted.length,100);assert.equal(accepted.filter(isWorkPut).length,99);assert.equal(accepted.filter(item=>item.Put?.Item?.pk===globalKey.pk).length,1);assert.equal(accepted.some(item=>item.Put?.Item?.value?.key==='cohort'),false);
 assert.ok((await store.listWorksByCreator(scope.tenantId,scope.creatorId)).every(row=>row.revision===2&&row.title==='Changed '+row.workId));assert.deepEqual((await f.repositories.hostRecords.snapshot()).items.find(row=>row.id===cohort.id),cohort);
 assert.equal((await f.independent.hostRecords.snapshot()).items.filter(row=>row.value.kind==='works'&&JSON.parse(row.value.json).revision===2).length,99);
});

test('actual Native and global-v2 both accept the original near3.5MB99-Work UPDATE group with identical full JSON',async t=>{
 const f=await fixture(t),store=await seedWorks(f),original=await store.listWorksByCreator(scope.tenantId,scope.creatorId),changes=original.map(row=>({work:{...row,description:'x'.repeat(33500),revision:2},expectedRevision:1})),table='native-group-'+randomUUID();
 t.after(()=>f.raw.send(new DeleteTableCommand({TableName:table})));
 await f.raw.send(new CreateTableCommand({TableName:table,BillingMode:'PAY_PER_REQUEST',KeySchema:[{AttributeName:'PK',KeyType:'HASH'},{AttributeName:'SK',KeyType:'RANGE'}],AttributeDefinitions:[{AttributeName:'PK',AttributeType:'S'},{AttributeName:'SK',AttributeType:'S'}]}));
 await f.client.send(new PutCommand({TableName:table,Item:{PK:'CREATOR#creator',SK:'PROFILE',creatorId:'creator',subjectId:f.actor}}));
 for(let start=0;start<original.length;start+=90)await f.client.send(new TransactWriteCommand({TransactItems:original.slice(start,start+90).map(row=>({Put:{TableName:table,Item:{PK:'TENANT#tenant#WORK#'+row.workId,SK:'PROFILE',entityType:'WORK',...row}}}))}));
 let nativeBytes=0,nativeCount=0;const unavailable=()=>{throw Error('This full-Work group test does not bind media/publication/restore commands.');};
 const native=new DynamoRetainedCreatorContent({get:input=>f.client.send(new GetCommand(input)),put:input=>f.client.send(new PutCommand(input)),delete:input=>f.client.send(new DeleteCommand(input)),query:input=>f.client.send(new QueryCommand(input)),transactWrite:input=>{nativeBytes=Buffer.byteLength(JSON.stringify(input.TransactItems));nativeCount=input.TransactItems.length;return f.client.send(new TransactWriteCommand(input));}},table,{getRestore:unavailable,commitRestore:unavailable,aliasWrites:unavailable,validateAssetAttachment:unavailable,validateDisclosureHistory:unavailable,validatePublicationProjection:unavailable});
 await native.commitSharedWorkRevisions(changes);assert.equal(nativeCount,100);assert.ok(nativeBytes>3300000&&nativeBytes<3500000,nativeBytes);
 await store.asActor(f.actor,()=>store.commitSharedWorkRevisions(changes));
 const expected=changes.map(change=>change.work).sort((a,b)=>a.workId.localeCompare(b.workId));assert.deepEqual((await store.listWorksByCreator(scope.tenantId,scope.creatorId)).sort((a,b)=>a.workId.localeCompare(b.workId)),expected);
 assert.deepEqual((await Promise.all(expected.map(row=>native.getWork(scope.tenantId,row.workId)))).sort((a,b)=>a.workId.localeCompare(b.workId)),expected);
});

test('actual global-v2 revocation after99 rows stage rejects every update and the original full inventory survives',async t=>{
 const f=await fixture(t),store=await seedWorks(f),original=await store.listWorksByCreator(scope.tenantId,scope.creatorId),before=(await f.repositories.hostRecords.snapshot()).items.filter(row=>row.namespace==='retained-creator-content'),send=f.client.send.bind(f.client);let revoked=false;
 f.client.send=async(command,...rest)=>{
  if(!revoked&&command.constructor.name==='TransactWriteCommand'&&command.input.TransactItems.filter(isWorkPut).length===99){revoked=true;const profile=await f.independent.hostRecords.get('auth-profile');await f.independent.hostRecords.update(profile.id,profile.revision,{value:{...profile.value,status:'inactive'}});}
  return send(command,...rest);
 };
 try{await assert.rejects(store.asActor(f.actor,()=>store.commitSharedWorkRevisions(original.map(row=>({work:{...row,title:'Must roll back',revision:2},expectedRevision:1})))),{name:'OptimisticConcurrencyError'});}finally{f.client.send=send;}
 assert.equal(revoked,true);assert.deepEqual((await f.independent.hostRecords.snapshot()).items.filter(row=>row.namespace==='retained-creator-content'),before);assert.deepEqual(await f.store().listWorksByCreator(scope.tenantId,scope.creatorId),original);assert.equal(await f.store().authorizeActor(f.actor),false);
});

test('every guarded SDK writer advances the same actual marker and fences insert/update/removal across complete inventories',async t=>{
 const f=await fixture(t),plain={id:'plain',...f.home,subjectId:f.actor,displayName:'Plain Creator',handle:'plain'};await f.repositories.creators.create(plain);
 const records={creators:{id:'target-creator',...f.home,subjectId:f.actor,displayName:'Target',handle:'target'},assets:{id:'target-asset',...f.home,creatorId:'plain',workId:'plain-work',mimeType:'image/png',status:'ready',checksum:'a'.repeat(64),objectVersion:'v1'},publications:{id:'target-publication',...f.home,creatorId:'plain',workId:'plain-work',destination:'native',status:'draft'},moderationHolds:{id:'target-hold',...f.home,subjectType:'creator',subjectId:'plain',state:'active',reason:'Actual local protocol control'},hostRecords:{id:'target-host',...f.home,namespace:'unit',scopeId:'plain',key:'target',value:{all:['full','fields']}}};
 for(const [name,record]of Object.entries(records))for(const operation of ['create','update','remove']){
  const repository=f.repositories[name],independent=f.independent[name],captured=await repository.snapshot(),root=await f.root(),send=f.client.send.bind(f.client),auditId=name+'-'+operation;let raced=false;
  f.client.send=async(command,...rest)=>{
   if(!raced&&command.constructor.name==='TransactWriteCommand'&&command.input.TransactItems.some(item=>item.Put?.Item?.repository==='auditEvents'&&item.Put.Item.id===auditId)){
    raced=true;if(operation==='create')await independent.create(record);else {const old=await independent.get(record.id);if(operation==='update')await independent.update(record.id,old.revision,{opaque:{preserve:'update'}});else await independent.remove(record.id,old.revision);}
   }return send(command,...rest);
  };
  try{await assert.rejects(f.repositories.transaction(async transaction=>{await captured.bind(transaction);await f.repositories.auditEvents.create({id:auditId,...f.home,action:'must.rollback',payload:{}},{transaction});}),{name:'OptimisticConcurrencyError'});}finally{f.client.send=send;}
  assert.equal(raced,true,name+':'+operation);assert.notEqual((await f.root()).version,root.version);assert.equal(await f.repositories.auditEvents.get(auditId),undefined);
 }
});

test('the public low-level SDK constructor also advances the guarded marker and refuses legacy mode on a global realm',async t=>{
 const f=await fixture(t),before=await f.root(),direct=new DynamoRevisionedRepository(f.client,{tableName:f.table,cellId:scope.cellId,globalSnapshotRealm:f.realm},'hostRecords');
 await direct.create({id:'direct-sdk-writer',...f.home,namespace:'unit',scopeId:'creator',key:'direct',value:{full:{preserved:true}}});assert.notEqual((await f.root()).version,before.version);assert.deepEqual((await f.independent.hostRecords.get('direct-sdk-writer')).value,{full:{preserved:true}});
 const legacy=new DynamoRevisionedRepository(f.client,{tableName:f.table,cellId:scope.cellId},'hostRecords');await assert.rejects(legacy.update('direct-sdk-writer',1,{value:{must:'not replace'}}),{code:'snapshot_protocol_migration_required'});assert.equal((await direct.get('direct-sdk-writer')).revision,1);
});

test('actual point revisions/absence and caught contradictions remain binding; same-item guarded writes cannot commit',async t=>{
 const f=await fixture(t),repository=f.repositories.hostRecords;
 const physical=new DynamoRevisionedRepository(f.client,{tableName:f.table,globalSnapshotRealm:f.realm},'hostRecords');
 await physical.create({id:'foreign-cell-guard',...f.home,homeCellId:'foreign-cell',namespace:'unit',scopeId:'creator',key:'foreign',value:{}});
 for(const mode of ['stale','present','guard-write','write-guard','contradiction','foreign']){
  const id='companion-'+mode;
  await assert.rejects(f.repositories.transaction(async transaction=>{
   await f.repositories.auditEvents.create({id,...f.home,action:'must.rollback',payload:{}},{transaction});
   try{
    if(mode==='stale')await repository.checkRevision('auth-profile',99,{transaction});
    if(mode==='present')await repository.checkAbsent('auth-profile',{transaction});
    if(mode==='guard-write'){await repository.checkRevision('auth-profile',1,{transaction});await repository.update('auth-profile',1,{value:{status:'inactive'}},{transaction});}
    if(mode==='write-guard'){await repository.create({id:'new-'+mode,...f.home,namespace:'unit',scopeId:'creator',key:mode,value:{}},{transaction});await repository.checkRevision('new-'+mode,1,{transaction});}
    if(mode==='contradiction'){await repository.checkAbsent('missing',{transaction});await repository.checkRevision('missing',1,{transaction});}
    if(mode==='foreign')await repository.checkRevision('foreign-cell-guard',1,{transaction});
   }catch{}
  }),/aborted/);assert.equal(await f.repositories.auditEvents.get(id),undefined);
 }
 const send=f.client.send.bind(f.client);let inserted=false;
 f.client.send=async(command,...rest)=>{if(!inserted&&command.constructor.name==='TransactWriteCommand'&&command.input.TransactItems.some(item=>item.Put?.Item?.id==='late-absence')){inserted=true;await f.independent.hostRecords.create({id:'late-role',...f.home,namespace:'unit',scopeId:'users',key:'role',value:{role:'customer'}});}return send(command,...rest);};
 try{await assert.rejects(f.repositories.transaction(async transaction=>{await repository.checkAbsent('late-role',{transaction});await f.repositories.auditEvents.create({id:'late-absence',...f.home,action:'must.rollback',payload:{}},{transaction});}),{name:'OptimisticConcurrencyError'});}finally{f.client.send=send;}
 assert.equal(inserted,true);assert.equal(await f.repositories.auditEvents.get('late-absence'),undefined);
});

test('global marker contention explicitly rejects an unrelated guarded write, while an unguarded point-only repository retains its original independence',async t=>{
 const f=await fixture(t),send=f.client.send.bind(f.client);let current,interventions=0;
 f.client.send=async(command,...rest)=>{if(current&&command.constructor.name==='TransactWriteCommand'&&command.input.TransactItems.some(item=>item.Put?.Item?.repository==='auditEvents')){const id=current;current=undefined;interventions++;await f.independent.hostRecords.create({id,...f.home,namespace:'unit',scopeId:'unrelated',key:id,value:{status:'active'}});}return send(command,...rest);};
 try{
  current='unrelated-global';await assert.rejects(f.repositories.transaction(async transaction=>{await f.repositories.hostRecords.checkAbsent('still-missing',{transaction});await f.repositories.auditEvents.create({id:'global-contention',...f.home,action:'must.rollback',payload:{}},{transaction});}),{name:'OptimisticConcurrencyError'});
  current='unrelated-point';await f.repositories.transaction(async transaction=>{await f.repositories.federationActors.checkAbsent('still-missing',{transaction});await f.repositories.auditEvents.create({id:'point-independent',...f.home,action:'accepted',payload:{}},{transaction});});
 }finally{f.client.send=send;}
 assert.equal(interventions,2);assert.equal(await f.repositories.auditEvents.get('global-contention'),undefined);assert.ok(await f.repositories.auditEvents.get('point-independent'));
});

test('an unawaited asynchronous global read guard cannot escape and let a companion write accept',async t=>{
 const f=await fixture(t);let detached;
 await assert.rejects(f.repositories.transaction(async transaction=>{
  await f.repositories.auditEvents.create({id:'detached-guard',...f.home,action:'must.rollback',payload:{}},{transaction});
  detached=f.repositories.hostRecords.checkRevision('auth-profile',1,{transaction});detached.catch(()=>{});
 }),/Await every repository guard/);
 await assert.rejects(detached,/active|ended/);assert.equal(await f.repositories.auditEvents.get('detached-guard'),undefined);
});

test('a same-revision delete/recreate cannot change an actual observed authority before its coalesced guard',async t=>{
 const f=await fixture(t);
 await assert.rejects(f.repositories.transaction(async transaction=>{
  const observed=await f.repositories.hostRecords.get('auth-profile',{transaction});assert.equal(observed.value.status,'active');
  await f.independent.hostRecords.remove(observed.id,observed.revision);
  const {revision,createdAt,updatedAt,...identity}=observed;
  const replacement=await f.independent.hostRecords.create({...identity,value:{...observed.value,status:'inactive'}});assert.equal(replacement.revision,observed.revision);
  await f.repositories.hostRecords.checkRevision(observed.id,observed.revision,{transaction});
  await f.repositories.auditEvents.create({id:'aba-must-rollback',...f.home,action:'must.rollback',payload:{}},{transaction});
 }),{name:'OptimisticConcurrencyError'});
 assert.equal((await f.independent.hostRecords.get('auth-profile')).value.status,'inactive');assert.equal(await f.repositories.auditEvents.get('aba-must-rollback'),undefined);
});

test('actual realm genesis/reopen rejects fake client capabilities, legacy writer selection and all existing-table adoption',async t=>{
 const f=await fixture(t),before=sorted((await f.client.send(new ScanCommand({TableName:f.table,ConsistentRead:true}))).Items);
 assert.throws(()=>createDynamoRepositories(f.other,{tableName:f.table,cellId:scope.cellId,globalSnapshotRealm:f.realm}),{code:'snapshot_protocol_migration_required'});
 assert.throws(()=>createDynamoRepositories(f.client,{tableName:f.table,cellId:scope.cellId,globalSnapshotRealm:JSON.parse(JSON.stringify(f.realm))}),{code:'snapshot_protocol_migration_required'});
 const legacy=createDynamoRepositories(f.client,{tableName:f.table,cellId:scope.cellId});await assert.rejects(legacy.hostRecords.snapshot(),{code:'snapshot_protocol_migration_required'});await assert.rejects(legacy.hostRecords.create({id:'legacy-must-not-write',...f.home,namespace:'unit',scopeId:'creator',key:'legacy',value:{}}),{code:'snapshot_protocol_migration_required'});
 await assert.rejects(createFreshGlobalSnapshotRealm(f.raw,{tableName:f.table,instanceId:scope.instanceId}));assert.deepEqual(sorted((await f.client.send(new ScanCommand({TableName:f.table,ConsistentRead:true}))).Items),before);
 const config={region:scope.region,endpoint,credentials:{accessKeyId:'DUMMYLOCALTEST',secretAccessKey:'DUMMYLOCALTEST'}},raw=new DynamoDBClient(config),table='legacy-not-adopted-'+randomUUID(),client=DynamoDBDocumentClient.from(raw);
 t.after(async()=>{try{await raw.send(new DeleteTableCommand({TableName:table}));}finally{raw.destroy();}});
 await raw.send(new CreateTableCommand({TableName:table,BillingMode:'PAY_PER_REQUEST',KeySchema:[{AttributeName:'pk',KeyType:'HASH'},{AttributeName:'sk',KeyType:'RANGE'}],AttributeDefinitions:[{AttributeName:'pk',AttributeType:'S'},{AttributeName:'sk',AttributeType:'S'}]}));
 await assert.rejects(openGlobalSnapshotRealm(raw,{tableName:table,instanceId:scope.instanceId}),{code:'snapshot_protocol_migration_required'});assert.equal((await client.send(new GetCommand({TableName:table,Key:globalKey,ConsistentRead:true}))).Item,undefined,'an empty existing table is never initialized by open');
 const old=createDynamoRepositories(client,{tableName:table,cellId:scope.cellId});await old.hostRecords.create({id:'original-history',...f.home,namespace:'legacy',scopeId:'creator',key:'history',value:{unknown:{preserve:['full','history']}}});
 await assert.rejects(openGlobalSnapshotRealm(raw,{tableName:table,instanceId:scope.instanceId}),{code:'snapshot_protocol_migration_required'});await assert.rejects(createFreshGlobalSnapshotRealm(raw,{tableName:table,instanceId:scope.instanceId}));assert.deepEqual((await old.hostRecords.get('original-history')).value,{unknown:{preserve:['full','history']}});
});

test('350000-byte Unicode/escaping logical JSON stays one actual Dynamo string item and reopens exactly',async t=>{
 const f=await fixture(t),store=f.store(),value={tenantId:scope.tenantId,creatorId:scope.creatorId,id:'opaque-native-row',opaque:'\\"漢📷'.repeat(18000),unknown:{all:['retained','fields']}};value.opaque+='x'.repeat(350000-Buffer.byteLength(JSON.stringify(value)));assert.equal(Buffer.byteLength(JSON.stringify(value)),350000);
 await store.asActor(f.actor,()=>store.putRetainedEntity('native-budget','opaque',value));assert.deepEqual(await f.store().getRetainedEntity('native-budget','opaque'),value);const rows=(await f.repositories.hostRecords.snapshot()).items,header=rows.find(row=>row.value.kind==='native-budget');assert.equal(header.value.encoding.format,'json-utf8-inline-v1');assert.equal(Buffer.byteLength(header.value.json),350000);assert.equal(rows.some(row=>row.value.physicalKind==='retained-json-chunk'),false);assert.deepEqual(JSON.parse(header.value.json),value);
});

test('99 real inline logical rows plus one marker remain100; adding an actual command/cohort mutation is truthfully refused atomically',async t=>{
 const f=await fixture(t),store=await seedWorks(f),original=await store.listWorksByCreator(scope.tenantId,scope.creatorId),before=(await f.repositories.hostRecords.snapshot()).items,send=f.client.send.bind(f.client);let acceptingSends=0;f.client.send=async(command,...args)=>{if(command.constructor.name==='TransactWriteCommand')acceptingSends++;return send(command,...args);};
 try{await assert.rejects(store.asActor(f.actor,async()=>{await store.commitSharedWorkRevisions(original.map(row=>({work:{...row,title:'Must roll back extra business rows',revision:2},expectedRevision:1})));await store.publicationAtomic.put('content-workflow:tenant:creator:capacity-command','actual-command',{id:'actual-command',actorId:f.actor});}),/100 distinct writes/);}finally{f.client.send=send;}
 assert.equal(acceptingSends,0);assert.deepEqual((await f.independent.hostRecords.snapshot()).items,before);assert.deepEqual(await f.store().listWorksByCreator(scope.tenantId,scope.creatorId),original);
});

test('actual final4MiB physical budget is checked before TransactWrite and preserves all99 existing entities',async t=>{
 const f=await fixture(t),store=f.store();for(let start=0;start<99;start+=30)await store.asActor(f.actor,async()=>{for(let i=start;i<Math.min(99,start+30);i++)await store.putRetainedEntity('capacity-rows','row-'+i,{id:'row-'+i,opaque:'old'});});const before=(await f.repositories.hostRecords.snapshot()).items,send=f.client.send.bind(f.client);let acceptingSends=0;f.client.send=async(command,...args)=>{if(command.constructor.name==='TransactWriteCommand')acceptingSends++;return send(command,...args);};
 try{await assert.rejects(store.asActor(f.actor,async()=>{for(let i=0;i<99;i++)await store.putRetainedEntity('capacity-rows','row-'+i,{id:'row-'+i,opaque:'x'.repeat(45000)});}),/4MiB/);}finally{f.client.send=send;}
 assert.equal(acceptingSends,0);assert.deepEqual((await f.independent.hostRecords.snapshot()).items,before);
});

test('a logical overflow uses its genuine guarded physical chunks, and a missing original part is not repaired on read',async t=>{
 const f=await fixture(t),store=f.store(),value={tenantId:scope.tenantId,creatorId:scope.creatorId,id:'overflow',opaque:'漢'.repeat(350000)};await store.asActor(f.actor,()=>store.putRetainedEntity('overflow','original',value));assert.deepEqual(await f.store().getRetainedEntity('overflow','original'),value);const rows=(await f.repositories.hostRecords.snapshot()).items,header=rows.find(row=>row.value.kind==='overflow'),chunk=rows.find(row=>row.value.physicalKind==='retained-json-chunk');assert.equal(header.value.encoding.format,'json-utf8-chunks-v1');assert.ok(chunk);await f.repositories.hostRecords.remove(chunk.id,chunk.revision);const before=(await f.repositories.hostRecords.snapshot()).items;await assert.rejects(f.store().getRetainedEntity('overflow','original'),{code:'retained_content_invalid'});assert.deepEqual((await f.repositories.hostRecords.snapshot()).items,before);
});

test('the actual complete400KiB item boundary is exercised against Dynamo, independent of wire JSON escaping',async t=>{
 const f=await fixture(t),repository=f.repositories.hostRecords,id='physical-boundary',old=await repository.create({id,...f.home,namespace:'unit-boundary',scopeId:scope.creatorId,key:id,value:{opaque:''}});const candidate=n=>({...old,revision:2,updatedAt:new Date().toISOString(),value:{opaque:'\\"'.repeat(n)}});let low=0,high=410000;while(low+1<high){const middle=Math.floor((low+high)/2);if(repository.physicalRecordFits(candidate(middle)))low=middle;else high=middle;}
 assert.ok(Buffer.byteLength(JSON.stringify(candidate(low)))>400*1024,'wire JSON escaping is not the stored-item budget');const accepted=await repository.update(id,old.revision,{value:candidate(low).value});assert.equal(accepted.revision,2);const before=await f.independent.hostRecords.get(id);await assert.rejects(repository.update(id,accepted.revision,{value:candidate(high).value}),/item budget/);assert.deepEqual(await f.independent.hostRecords.get(id),before);
});

test('99 genuine existing opaque entity updates use99 physical rows plus the one shared global marker',async t=>{
 const f=await fixture(t),store=f.store();for(let start=0;start<99;start+=30)await store.asActor(f.actor,async()=>{for(let i=start;i<Math.min(99,start+30);i++)await store.putRetainedEntity('capacity-existing-rows','row-'+i,{id:'row-'+i,opaque:'before'});});
 const before=(await f.repositories.hostRecords.snapshot()).items,cohort=before.find(row=>row.namespace==='retained-creator-content'&&row.key==='cohort'),send=f.client.send.bind(f.client);let accepted;f.client.send=async(command,...args)=>{if(command.constructor.name==='TransactWriteCommand'&&command.input.TransactItems.filter(item=>item.Put?.Item?.value?.value?.kind==='capacity-existing-rows').length===99)accepted=structuredClone(command.input.TransactItems);return send(command,...args);};
 try{await store.asActor(f.actor,async()=>{for(let i=0;i<99;i++)await store.putRetainedEntity('capacity-existing-rows','row-'+i,{id:'row-'+i,opaque:'漢'.repeat(100),unknown:{preserved:true}});});}finally{f.client.send=send;}
 assert.equal(accepted.length,100);assert.equal(accepted.filter(item=>item.Put?.Item?.pk===globalKey.pk).length,1);assert.equal(accepted.some(item=>item.Put?.Item?.value?.key==='cohort'),false);const after=(await f.independent.hostRecords.snapshot()).items;assert.deepEqual(after.find(row=>row.id===cohort.id),cohort);assert.equal(after.filter(row=>row.value.kind==='capacity-existing-rows'&&JSON.parse(row.value.json).opaque==='漢'.repeat(100)).length,99);
});
