import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DynamoDBClient,CreateTableCommand,DeleteTableCommand} from '@aws-sdk/client-dynamodb';
import {DynamoDBDocumentClient,ScanCommand,TransactWriteCommand,GetCommand} from '@aws-sdk/lib-dynamodb';
import {createDynamoRepositories} from '@ubeeq/adapter-aws';
import {CreatorCollectionService,CreatorCollectionError} from '@ubeeq/core';
import {OptimisticConcurrencyError} from '@ubeeq/persistence';
import {RepositoryCreatorCollectionStore,prepareNewCreatorCollectionDirectory,withCollectionWorkLifecycleFence,createCollectionFromIntent,invalidateCollectionDirectoryForImport} from '../../../packages/runtime/dist/creator-collections.js';

const endpoint=process.env.TEST_DYNAMODB_ENDPOINT;
if(!endpoint||!/^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(endpoint))throw Error('An explicit loopback DynamoDB test endpoint is required.');
async function fixture(t){
 const region='ca-central-1',credentials={accessKeyId:'DUMMYLOCALTEST',secretAccessKey:'DUMMYLOCALTEST'},raw=new DynamoDBClient({region,endpoint,credentials}),otherRaw=new DynamoDBClient({region,endpoint,credentials}),client=DynamoDBDocumentClient.from(raw),other=DynamoDBDocumentClient.from(otherRaw),table='creator-collections-'+randomUUID();let created=false;
 t.after(async()=>{try{if(created)await raw.send(new DeleteTableCommand({TableName:table}));}finally{raw.destroy();otherRaw.destroy();}});
 await raw.send(new CreateTableCommand({TableName:table,BillingMode:'PAY_PER_REQUEST',KeySchema:[{AttributeName:'pk',KeyType:'HASH'},{AttributeName:'sk',KeyType:'RANGE'}],AttributeDefinitions:['pk','sk','repository','id'].map(AttributeName=>({AttributeName,AttributeType:'S'})),GlobalSecondaryIndexes:[{IndexName:'repository-id-index',KeySchema:[{AttributeName:'repository',KeyType:'HASH'},{AttributeName:'id',KeyType:'RANGE'}],Projection:{ProjectionType:'ALL'}}]}));created=true;
 const repositories=createDynamoRepositories(client,{tableName:table,cellId:'cell'}),independent=createDynamoRepositories(other,{tableName:table,cellId:'cell'}),home={homeCellId:'cell',dataHomeRegion:region,dataHomeAssignedAt:new Date().toISOString(),routingRevision:1},scope={instanceId:'instance',cellId:'cell',region};
 await repositories.transaction(async transaction=>{const creator=await repositories.creators.create({id:'creator',instanceId:'instance',...home,subjectId:'owner',handle:'creator',displayName:'Creator'},{transaction});await prepareNewCreatorCollectionDirectory(repositories,creator,transaction);});
 await repositories.hostRecords.create({id:'authority',instanceId:'instance',...home,namespace:'test-authority',scopeId:'creator',key:'member',value:{actorId:'editor',active:true}});
 const connect=(repo=repositories)=>{
  const store=new RepositoryCreatorCollectionStore(repo,scope,async(creator,transaction)=>{
   const authority=await repo.hostRecords.get('authority',{transaction});if(!authority?.value.active||authority.value.actorId!=='editor')throw new CreatorCollectionError('access_denied','Current membership required');
   await repo.hostRecords.checkRevision(authority.id,authority.revision,{transaction});await repo.creators.checkRevision(creator.id,creator.revision,{transaction});
  });
  return{store,service:new CreatorCollectionService(store,async s=>s.tenantId==='instance'&&s.creatorId==='creator')};
 };
 const collection=(id,slug=id)=>({id,collectionId:id,tenantId:'instance',creatorId:'creator',title:id,type:'collection',slug,slugHistory:[],status:'draft',visibility:'private',revision:1,managementReady:true,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
 const work=id=>repositories.works.create({id,instanceId:'instance',...home,creatorId:'creator',title:id,status:'draft'});
 return{client,other,table,repositories,independent,home,scope,connect,collection,work,...connect(),rows:async()=>(await client.send(new ScanCommand({TableName:table}))).Items};
}
const collectionWrite=command=>command instanceof TransactWriteCommand&&command.input.TransactItems?.some(i=>i.Put?.Item?.repository==='collections');
test('independent Dynamo coordinators cannot reserve the same slug concurrently; losing writes leave no collection or directory entry',async t=>{
 const f=await fixture(t),second=f.connect(f.independent);let arrived=0,release;const ready=new Promise(r=>{release=r;});
 for(const client of [f.client,f.other]){const send=client.send.bind(client);client.send=async(command,...rest)=>{if(collectionWrite(command)){if(++arrived===2)release();await ready;}return send(command,...rest);};}
 const results=await Promise.allSettled([f.service.create(f.collection('one','same')),second.service.create(f.collection('two','same'))]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);
 const rows=await f.rows(),collections=rows.filter(r=>r.repository==='collections'),directory=rows.find(r=>r.repository==='hostRecords'&&r.value.namespace==='runtime-collection-directory');assert.equal(collections.length,1);assert.deepEqual(directory.value.value.collectionIds,[collections[0].id]);
 const winning=await f.service.get('instance',collections[0].id);await f.service.update({...winning,slug:'renamed'},'draft',winning.revision);
 await assert.rejects(second.service.create(f.collection('three','same')),e=>e.code==='slug_conflict');
});
test('a concurrent real Work deletion invalidates an in-flight membership replacement',async t=>{
 const f=await fixture(t);await f.service.create(f.collection('one'));const work=await f.work('work');
 const send=f.client.send.bind(f.client);let inject=true;
 f.client.send=async(command,...rest)=>{
  const result=await send(command,...rest);
  if(inject&&command instanceof GetCommand&&command.input.Key.pk==='works#work'){
   inject=false;await withCollectionWorkLifecycleFence(f.independent,f.scope,'creator',transaction=>f.independent.works.update(work.id,work.revision,{status:'deleted'},{transaction}));
  }return result;
 };
 // Bypass the domain's preliminary read to put the deletion exactly between
 // the adapter's transactional Work read and its commit.
 await assert.rejects(f.store.replaceCollectionWorks('instance','one',[{collectionId:'one',workId:'work',position:0,addedAt:new Date().toISOString()}],[],1),OptimisticConcurrencyError);
 assert.deepEqual(await f.store.listCollectionWorks('instance','one'),[]);assert.equal((await f.repositories.works.get('work')).status,'deleted');
});
test('permission revocation after authorization and cover custody changes after validation both abort the actual transaction',async t=>{
 const f=await fixture(t);await f.service.create(f.collection('one'));let c=await f.service.get('instance','one');
 const send=f.client.send.bind(f.client);let mutation=async()=>{const a=await f.independent.hostRecords.get('authority');await f.independent.hostRecords.update(a.id,a.revision,{value:{...a.value,active:false}});};
 f.client.send=async(command,...rest)=>{if(mutation&&collectionWrite(command)){const run=mutation;mutation=undefined;await run();}return send(command,...rest);};
 await assert.rejects(f.service.update({...c,title:'Unauthorized'},undefined,c.revision),OptimisticConcurrencyError);assert.equal((await f.repositories.collections.get('one')).title,'one');
 let a=await f.independent.hostRecords.get('authority');await f.independent.hostRecords.update(a.id,a.revision,{value:{...a.value,active:true}});
 const asset=await f.repositories.assets.create({id:'image',instanceId:'instance',...f.home,creatorId:'creator',mimeType:'image/png',checksum:'a'.repeat(64),objectVersion:'one',status:'ready',originalStorage:{scope:'private',bucket:'private',key:'cells/cell/creators/creator/original/image.png',byteLength:12}});
 mutation=()=>f.independent.assets.update(asset.id,asset.revision,{status:'deleted'});
 await assert.rejects(f.service.update({...c,coverAssetId:'image'},undefined,c.revision),OptimisticConcurrencyError);assert.equal((await f.repositories.collections.get('one')).coverAssetId,undefined);
});
test('120 ordered members commit within Dynamo transaction limits and a fresh coordinator preserves the order',async t=>{
 const f=await fixture(t);await f.service.create(f.collection('many'));const ids=Array.from({length:120},(_,i)=>'work-'+i);
 for(let i=0;i<ids.length;i+=8)await Promise.all(ids.slice(i,i+8).map(f.work));
 const send=f.client.send.bind(f.client);let writes=[];f.client.send=async(command,...rest)=>{if(collectionWrite(command))writes=command.input.TransactItems;return send(command,...rest);};
 await f.service.replaceWorks('instance','many',ids,[],1);
 const markerWrites=writes.filter(write=>write.Put?.Item?.pk==='__ubeeq_repository_snapshot#hostRecords');
 assert.equal(markerWrites.length,1);assert.equal(markerWrites[0].Put.Item.sk,'fence');assert.match(markerWrites[0].Put.Item.version,/^[0-9a-f-]{36}$/);
 assert.equal(writes.length,5,'the same four domain guards/writes plus one atomic authority marker, independent of member count');const other=f.connect(f.independent);
 assert.deepEqual((await other.store.listCollectionWorks('instance','many')).map(m=>m.workId),ids);
 const c=await other.service.get('instance','many');assert.equal(c.revision,2);
 await assert.rejects(other.service.replaceWorks('instance','many',[...ids].reverse(),ids,1),e=>e.code==='revision_conflict');
});
test('a committed collection and intent receipt recover a lost response without reapplying edits or bypassing revoked membership',async t=>{
 const f=await fixture(t),input={...f.scope,creatorId:'creator',actorId:'editor',idempotencyKey:'intent',details:{title:'Original',slug:'original'}};
 const send=f.client.send.bind(f.client);let lose=true,creates=0;
 f.client.send=async(command,...rest)=>{const result=await send(command,...rest);if(lose&&collectionWrite(command)){lose=false;throw Error('Synthetic accepted response lost');}return result;};
 const create=id=>{creates++;return f.service.create({...f.collection(id,'original'),title:'Original'});};
 const first=await createCollectionFromIntent(f.repositories,f.store,input,create);assert.equal(creates,1);
 await f.service.update({...first,title:'Edited',slug:'edited'},undefined,first.revision);
 const second=f.connect(f.independent),replay=await createCollectionFromIntent(f.independent,second.store,input,create);assert.equal(replay.title,'Edited');assert.equal(replay.id,first.id);assert.equal(creates,1);
 await assert.rejects(createCollectionFromIntent(f.independent,second.store,{...input,details:{title:'Changed',slug:'original'}},create),e=>e.code==='collection_intent_conflict');
 const authority=await f.independent.hostRecords.get('authority');await f.independent.hostRecords.update(authority.id,authority.revision,{value:{...authority.value,active:false}});
 await assert.rejects(createCollectionFromIntent(f.independent,second.store,input,create),e=>e.code==='access_denied');assert.equal(creates,1);
});
test('concurrent collection creation retries recover one durable record across independent coordinators',async t=>{
 const f=await fixture(t),second=f.connect(f.independent),input={...f.scope,creatorId:'creator',actorId:'editor',idempotencyKey:'same',details:{title:'Same'}};
 const results=await Promise.all([
  createCollectionFromIntent(f.repositories,f.store,input,id=>f.service.create(f.collection(id,'same'))),
  createCollectionFromIntent(f.independent,second.store,input,id=>second.service.create(f.collection(id,'same'))),
 ]);
 assert.equal(results[0].id,results[1].id);const rows=await f.rows();assert.equal(rows.filter(r=>r.repository==='collections').length,1);assert.equal(rows.filter(r=>r.repository==='hostRecords'&&r.value.namespace==='runtime-collection-intake').length,1);
});
test('import fencing atomically exposes incoming IDs and prevents imported management metadata from granting write authority',async t=>{
 const f=await fixture(t);await f.service.create(f.collection('one'));const creator=await f.repositories.creators.get('creator');
 await f.work('a');await f.work('b');await f.repositories.works.create({id:'foreign',instanceId:'instance',...f.home,creatorId:'other',title:'Foreign',status:'draft'});
 await f.service.replaceWorks('instance','one',['b','a'],[],1);
 await f.repositories.transaction(async transaction=>{
  await f.repositories.collections.create({id:'imported',instanceId:'instance',...f.home,creatorId:'creator',title:'Imported',visibility:'private',opaque:{retain:true},collectionManagement:{schemaVersion:1,members:['a','foreign'].map((workId,position)=>({collectionId:'imported',workId,position,addedAt:new Date().toISOString()}))}},{transaction});
  await invalidateCollectionDirectoryForImport(f.repositories,creator,['imported'],transaction);
 });
 // Strong directory reads retain the imported ID even when the index result is
 // deliberately suppressed. This is also exercised by the actual Dynamo engine.
 const list=f.repositories.collections.list;f.repositories.collections.list=async()=>({items:[]});
 const rows=await f.store.listCreatorCollections('instance','creator');assert.equal(rows.length,2);assert.ok(rows.every(c=>!c.managementReady));assert.deepEqual(rows.find(c=>c.id==='imported').opaque,{retain:true});f.repositories.collections.list=list;
 assert.deepEqual((await f.service.list({tenantId:'instance',creatorId:'creator'})).map(c=>[c.id,c.workIds]),[['one',['b','a']],['imported',['a']]]);
 const current=await f.service.get('instance','one');await assert.rejects(f.service.update({...current,title:'Unsafe'},undefined,current.revision),e=>e.code==='collection_migration_required');
});
