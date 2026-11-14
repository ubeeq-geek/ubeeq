import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createLocalAdapterSet} from '@ubeeq/adapter-local';
import {CreatorCollectionError} from '@ubeeq/core';
import {createCoreRuntime} from '../dist/index.js';
import {invalidateCollectionDirectoryForImport} from '../dist/creator-collections.js';

async function fixture(t,options={}){
 const directory=await mkdtemp(join(tmpdir(),'collection-http-')),local=createLocalAdapterSet({databasePath:join(directory,'data.sqlite'),dataDirectory:directory,cellId:'cell',publicBaseUrl:'http://localhost'});
 const runtime=createCoreRuntime({instanceId:'instance',cellId:'cell',region:'local',publicBaseUrl:'http://localhost',adapters:{repositories:local.repositories,storage:local.storage,uploads:local.storage,delivery:local.storage,jobs:local.jobs,identity:local.identity,localIdentity:local.identity},...options});
 await new Promise(resolve=>runtime.server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{await runtime.close();local.database.close();await rm(directory,{recursive:true,force:true});});
 let token,creatorId;
 const request=async(path,method='GET',body,overrides={})=>{
  const r=await fetch(`http://127.0.0.1:${runtime.server.address().port}${path}`,{method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{}),...(creatorId?{'x-creator-id':creatorId}:{}),...overrides},...(body?{body:JSON.stringify(body)}:{})});return{status:r.status,body:await r.json()};
 };
 const credentials={email:'owner@example.test',password:'Synthetic password 123!'};
 assert.equal((await request('/v1/auth/sign-up','POST',credentials)).status,201);
 token=(await request('/v1/auth/sign-in','POST',credentials)).body.token;
 const created=await request('/v1/creators','POST',{handle:'owner',displayName:'Owner'});assert.equal(created.status,201);creatorId=created.body.creator.id;
 const create=async(body={})=>{const result=await request('/v1/collections','POST',{title:'A collection',...body});assert.equal(result.status,201,JSON.stringify(result.body));return result.body.collection;};
 return{local,request,create,get creatorId(){return creatorId;},select:id=>{creatorId=id;}};
}
test('HTTP collection creation, retry recovery and metadata edits use current durable records',async t=>{
 const f=await fixture(t),c=await f.create({title:'My Gallery',idempotencyKey:'same-intent',type:'gallery',visibility:'unlisted'});
 assert.equal(c.slug,'my-gallery');assert.equal(c.managementReady,true);assert.deepEqual(c.workIds,[]);assert.equal(c.permissions.canEdit,true);assert.equal((await f.request('/v1/collections')).body.capabilities.canCreate,true);
 const saved=await f.request('/v1/collections/'+c.id,'PATCH',{revision:c.revision,title:'Edited later',slug:'New alias'});assert.equal(saved.status,200);assert.equal(saved.body.collection.slug,'new-alias');
 const replay=await f.create({title:'My Gallery',idempotencyKey:'same-intent',type:'gallery',visibility:'unlisted'});assert.equal(replay.id,c.id);assert.equal(replay.title,'Edited later');assert.deepEqual(replay.slugHistory,['my-gallery','new-alias']);
 assert.equal((await f.request('/v1/collections','POST',{title:'Changed request',idempotencyKey:'same-intent'})).status,409);
 assert.equal((await f.request('/v1/collections')).body.collections.length,1);
 assert.equal((await f.request('/v1/collections','POST',{title:'Duplicate alias',slug:'my-gallery'})).status,409);
 assert.equal((await f.request('/v1/collections/'+c.id,'PATCH',{revision:c.revision,title:'Stale'})).status,409);
});
test('HTTP ordering requires revision and previous order, rejects foreign Works and survives an ABA order change',async t=>{
 const f=await fixture(t),c=await f.create(),path='/v1/collections/'+c.id;
 const a=(await f.request('/v1/works','POST',{title:'First'})).body.work,b=(await f.request('/v1/works','POST',{title:'Second'})).body.work;
 assert.equal((await f.request(path+'/works','PUT',{workIds:[a.id],expectedWorkIds:[]})).status,400);
 let saved=await f.request(path+'/works','PUT',{revision:c.revision,workIds:[a.id,b.id],expectedWorkIds:[]});assert.equal(saved.status,200);assert.deepEqual(saved.body.collection.workIds,[a.id,b.id]);const stale=saved.body.collection;
 saved=await f.request(path+'/works','PUT',{revision:stale.revision,workIds:[],expectedWorkIds:stale.workIds});assert.equal(saved.status,200);
 saved=await f.request(path+'/works','PUT',{revision:saved.body.collection.revision,workIds:stale.workIds,expectedWorkIds:[]});assert.equal(saved.status,200);
 assert.equal((await f.request(path+'/works','PUT',{revision:stale.revision,workIds:[b.id,a.id],expectedWorkIds:stale.workIds})).status,409);
 const creator=await f.local.repositories.creators.get(f.creatorId);
 await f.local.repositories.works.create({id:'foreign',instanceId:'instance',homeCellId:'cell',dataHomeRegion:'local',dataHomeAssignedAt:creator.dataHomeAssignedAt,routingRevision:1,creatorId:'other',title:'Foreign',status:'draft'});
 assert.equal((await f.request(path+'/works','PUT',{revision:saved.body.collection.revision,workIds:['foreign'],expectedWorkIds:stale.workIds})).status,400);
 assert.equal((await f.request('/v1/works/'+a.id,'DELETE',{revision:a.revision})).status,200);
 assert.equal((await f.request(path+'/works','PUT',{revision:saved.body.collection.revision,workIds:[a.id],expectedWorkIds:stale.workIds})).status,400);
});
test('HTTP lifecycle prevents client-forged history, preserves archive history and requires revisions',async t=>{
 const f=await fixture(t),c=await f.create(),path='/v1/collections/'+c.id;
 assert.equal((await f.request(path,'DELETE',{})).status,400);
 assert.equal((await f.request(path,'PATCH',{revision:c.revision,workPublicationHistoryAt:'2026-01-01T00:00:00Z'})).status,400);
 assert.equal((await f.request(path,'PATCH',{revision:c.revision,status:'published'})).status,409);
 assert.equal((await f.request(path,'PATCH',{revision:c.revision,status:'archived'})).status,409);
 await f.local.repositories.collections.update(c.id,c.revision,{workPublicationHistoryAt:'2026-01-01T00:00:00Z',opaqueAdvancedData:{retain:true}});
 let current=(await f.request(path)).body.collection;
 assert.equal((await f.request(path,'DELETE',{revision:current.revision})).status,409);
 let result=await f.request(path,'PATCH',{revision:current.revision,status:'archived'});assert.equal(result.status,200);assert.ok(result.body.collection.archivedAt);
 result=await f.request(path,'PATCH',{revision:result.body.collection.revision,status:'draft'});assert.equal(result.status,200);assert.equal(result.body.collection.workPublicationHistoryAt,'2026-01-01T00:00:00Z');
 assert.deepEqual((await f.local.repositories.collections.get(c.id)).opaqueAdvancedData,{retain:true});assert.equal(result.body.collection.opaqueAdvancedData,undefined);
 const unused=await f.create({title:'Unused'});result=await f.request('/v1/collections/'+unused.id,'DELETE',{revision:unused.revision});assert.equal(result.status,200);assert.equal(result.body.collection.status,'deleted');
 assert.equal((await f.request('/v1/collections')).body.collections.length,1);
 assert.equal((await f.request('/v1/collections/'+unused.id,'PATCH',{revision:result.body.collection.revision,status:'draft'})).status,409);
});
test('imported and legacy collections remain visible and opaque data survives without automatic adoption',async t=>{
 const f=await fixture(t),managed=await f.create(),creator=await f.local.repositories.creators.get(f.creatorId),home={homeCellId:creator.homeCellId,dataHomeRegion:creator.dataHomeRegion,dataHomeAssignedAt:creator.dataHomeAssignedAt,routingRevision:creator.routingRevision};
 await f.local.repositories.collections.create({id:'untracked',instanceId:'instance',...home,creatorId:creator.id,title:'Legacy',visibility:'private',remoteConfiguration:{retain:true}});
 let rows=(await f.request('/v1/collections')).body.collections;assert.equal(rows.length,2);assert.equal(rows.find(c=>c.id==='untracked').managementReady,false);
 await f.local.repositories.transaction(async transaction=>{
  await f.local.repositories.collections.create({id:'imported',instanceId:'instance',...home,creatorId:creator.id,title:'Imported',visibility:'private',collectionManagement:{schemaVersion:1,members:[]}},{transaction});
  await invalidateCollectionDirectoryForImport(f.local.repositories,creator,['imported'],transaction);
 });
 const listing=(await f.request('/v1/collections')).body;rows=listing.collections;assert.equal(rows.length,3);assert.ok(rows.every(c=>c.managementReady===false&&c.permissions.canEdit===false));assert.equal(listing.capabilities.canCreate,false);
 assert.equal((await f.request('/v1/collections/'+managed.id,'PATCH',{revision:managed.revision,title:'Unsafe'})).body.error.code,'collection_migration_required');
 assert.deepEqual((await f.local.repositories.collections.get('untracked')).remoteConfiguration,{retain:true});
});
test('trusted host mutation authorization is enforced even when a role preflight remains permissive',async t=>{
 let allowed=true,calls=0;
 const f=await fixture(t,{collectionAuthorization:{authorizeMutation:async({creator,repositories,transaction,actorUserId})=>{
  calls++;assert.equal(Object.isFrozen(creator),true);if(!allowed||creator.subjectId!==actorUserId)throw new CreatorCollectionError('access_denied','Current membership is required.');
  await repositories.creators.checkRevision(creator.id,creator.revision,{transaction});
 }}}),c=await f.create();allowed=false;
 const result=await f.request('/v1/collections/'+c.id,'PATCH',{revision:c.revision,title:'Revoked'});assert.equal(result.status,403);assert.equal(calls,2);assert.equal((await f.local.repositories.collections.get(c.id)).title,'A collection');
});
