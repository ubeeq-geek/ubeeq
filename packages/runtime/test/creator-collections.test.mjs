import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createLocalAdapterSet} from '@ubeeq/adapter-local';
import {CreatorCollectionService} from '@ubeeq/core';
import {RepositoryCreatorCollectionStore,prepareNewCreatorCollectionDirectory,withCollectionWorkLifecycleFence} from '../dist/creator-collections.js';

async function fixture(t){
 const directory=await mkdtemp(join(tmpdir(),'runtime-collections-')),options={databasePath:join(directory,'data.sqlite'),dataDirectory:directory,cellId:'cell',publicBaseUrl:'http://localhost'};
 let local=createLocalAdapterSet(options);t.after(async()=>{local.database.close();await rm(directory,{recursive:true,force:true});});
 const home={homeCellId:'cell',dataHomeRegion:'local',dataHomeAssignedAt:new Date().toISOString(),routingRevision:1};
 await local.repositories.transaction(async transaction=>{
  const creator=await local.repositories.creators.create({id:'creator',instanceId:'instance',...home,subjectId:'owner',handle:'creator',displayName:'Creator'},{transaction});
  await prepareNewCreatorCollectionDirectory(local.repositories,creator,transaction);
 });
 await local.repositories.creators.create({id:'other',instanceId:'instance',...home,subjectId:'outsider',handle:'other',displayName:'Other'});
 const scoped={instanceId:'instance',cellId:'cell',region:'local'};
 const connect=(actor='owner')=>{
  const repositories=local.repositories;
  const store=new RepositoryCreatorCollectionStore(repositories,scoped,async(creator,transaction)=>{
   if(creator.subjectId!==actor)throw Error('Current owner required');
   await repositories.creators.checkRevision(creator.id,creator.revision,{transaction});
  });
  const service=new CreatorCollectionService(store,async scope=>scope.tenantId==='instance'&&(await repositories.creators.get(scope.creatorId))?.subjectId===actor);
  return{store,service};
 };
 const collection=(id,slug=id)=>({id,collectionId:id,tenantId:'instance',creatorId:'creator',title:id,type:'collection',slug,slugHistory:[slug],status:'draft',visibility:'private',revision:1,managementReady:true,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
 const work=(id,creatorId='creator')=>local.repositories.works.create({id,instanceId:'instance',...home,creatorId,title:id,status:'draft'});
 return{get local(){return local;},home,scope:scoped,collection,work,connect,...connect(),reopen:()=>{local.database.close();local=createLocalAdapterSet(options);return connect();}};
}
test('existing collection domain service uses durable runtime records and retains ordered membership across restart',async t=>{
 const f=await fixture(t);await f.service.create(f.collection('gallery','gallery'));
 await f.work('second');await f.work('first');
 await f.service.replaceWorks('instance','gallery',['second','first'],[]);
 const rows=await f.service.list({tenantId:'instance',creatorId:'creator'});assert.deepEqual(rows[0].workIds,['second','first']);assert.equal(rows[0].managementReady,true);
 const originalMembers=await f.store.listCollectionWorks('instance','gallery');const restarted=f.reopen();
 await restarted.service.replaceWorks('instance','gallery',['first','second'],['second','first']);
 const ordered=await restarted.store.listCollectionWorks('instance','gallery');assert.equal(ordered[0].addedAt,originalMembers[1].addedAt);assert.equal(ordered[1].addedAt,originalMembers[0].addedAt);
 assert.deepEqual((await restarted.service.list({tenantId:'instance',creatorId:'creator'}))[0].workIds,['first','second']);
});
test('historical slugs remain reserved, stale metadata/order writes fail and failed writes leave no phantom reservation',async t=>{
 const f=await fixture(t);await f.service.create(f.collection('one','original'));const initial=await f.service.get('instance','one');
 await f.service.update({...initial,slug:'renamed'},'draft',initial.revision);
 const renamed=await f.service.get('instance','one');assert.deepEqual(renamed.slugHistory,['original','renamed']);
 await assert.rejects(f.service.update({...initial,title:'Stale'},undefined,initial.revision),e=>e.code==='revision_conflict');
 await assert.rejects(f.service.create(f.collection('two','original')),e=>e.code==='slug_conflict');
 await f.work('a');await f.work('b');await f.service.replaceWorks('instance','one',['a'],[]);
 await assert.rejects(f.service.replaceWorks('instance','one',['b'],[]),e=>e.code==='revision_conflict');
 await assert.rejects(f.service.create({...f.collection('bad','available'),coverAssetId:'missing'}),e=>e.code==='invalid_cover');
 await f.service.create(f.collection('good','available'));assert.equal((await f.service.get('instance','good')).slug,'available');
});
test('ownership, cover custody and membership scope are rechecked inside mutations',async t=>{
 const f=await fixture(t);await f.service.create(f.collection('one'));await f.work('foreign','other');
 await assert.rejects(f.service.replaceWorks('instance','one',['foreign'],[]),e=>e.code==='invalid_works');
 const image=await f.local.repositories.assets.create({id:'image',instanceId:'instance',...f.home,creatorId:'creator',mimeType:'image/png',checksum:'a'.repeat(64),objectVersion:'v1',status:'ready',storage:{scope:'public'},originalStorage:{scope:'private',bucket:'private',key:'cells/cell/creators/creator/original/image.png',byteLength:12}});
 const c=await f.service.get('instance','one');await f.service.update({...c,coverAssetId:image.id},'draft',c.revision);
 await assert.rejects(f.connect('outsider').service.get('instance','one'),e=>e.code==='access_denied');
 const current=await f.service.get('instance','one');await assert.rejects(f.store.updateCreatorCollection({...current,creatorId:'other'},undefined,current.revision),e=>e.code==='immutable_owner');
 const creator=await f.local.repositories.creators.get('creator');await f.local.repositories.creators.update(creator.id,creator.revision,{subjectId:'outsider'});
 await assert.rejects(f.store.updateCreatorCollection({...current,title:'Revoked'},undefined,current.revision),/Current owner required/);
 assert.equal((await f.local.repositories.collections.get('one')).title,'one');
});
test('lifecycle retains recorded publication history and provides archive/restore instead of deletion',async t=>{
 const f=await fixture(t);await f.service.create(f.collection('history'));
 let c=await f.service.get('instance','history');await assert.rejects(f.service.update({...c,status:'archived'},'draft',c.revision),e=>e.code==='collection_state_invalid');
 // Represents a trusted publication writer's durable positive history, not client input.
 await f.local.repositories.collections.update(c.id,c.revision,{workPublicationHistoryAt:'2026-01-01T00:00:00.000Z'});
 c=await f.service.get('instance','history');await assert.rejects(f.service.remove('instance','history',c.revision),e=>e.code==='collection_history_requires_archive');
 await f.service.update({...c,status:'archived',workPublicationHistoryAt:undefined},'draft',c.revision);
 c=await f.service.get('instance','history');assert.equal(c.status,'archived');assert.equal(c.workPublicationHistoryAt,'2026-01-01T00:00:00.000Z');assert.ok(c.archivedAt);
 await f.service.update({...c,status:'draft'},'archived',c.revision);assert.equal((await f.service.get('instance','history')).status,'draft');
 await f.service.create(f.collection('unused'));c=await f.service.get('instance','unused');await f.service.remove('instance','unused',c.revision);
 c=await f.service.get('instance','unused');await assert.rejects(f.service.update({...c,status:'draft'},'deleted',c.revision),/cannot be restored/);
});
test('libraries without a trusted directory remain readable and require explicit migration for new management writes',async t=>{
 const f=await fixture(t);await f.local.repositories.collections.create({id:'legacy',instanceId:'instance',...f.home,creatorId:'other',title:'Legacy',visibility:'private',opaqueAdvancedField:{retain:true}});
 const old=await f.connect('outsider').service.get('instance','legacy');assert.equal(old.managementReady,false);assert.deepEqual(old.opaqueAdvancedField,{retain:true});
 await assert.rejects(f.connect('outsider').store.updateCreatorCollection({...old,title:'Unreviewed'},undefined,old.revision),e=>e.code==='collection_migration_required');
});
test('ordering over 100 members is one aggregate change and deletion participates in the same library fence',async t=>{
 const f=await fixture(t);await f.service.create(f.collection('many'));const ids=Array.from({length:120},(_,i)=>'work-'+i);
 for(const id of ids)await f.work(id);
 await f.service.replaceWorks('instance','many',ids,[]);assert.equal((await f.store.listCollectionWorks('instance','many')).length,120);
 const work=await f.local.repositories.works.get(ids[0]);
 await withCollectionWorkLifecycleFence(f.local.repositories,f.scope,'creator',transaction=>f.local.repositories.works.update(work.id,work.revision,{status:'deleted'},{transaction}));
 await assert.rejects(f.service.replaceWorks('instance','many',[...ids].reverse(),ids),e=>e.code==='invalid_works');
 assert.deepEqual((await f.store.listCollectionWorks('instance','many')).map(m=>m.workId),ids);
});
