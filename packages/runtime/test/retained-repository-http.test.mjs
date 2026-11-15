import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createLocalAdapterSet} from '@ubeeq/adapter-local';
import {defaultContentPreparation} from '@ubeeq/core';
import {createCoreRuntime} from '../dist/index.js';
import {ContentWorkflowService,ContentPreparationError} from '../dist/content-preparations.js';
import {createRetainedRepositoryCreator} from '../dist/retained-repository-store.js';
import {retainedStore,scope} from './retained-repository-fixture.mjs';

const unavailable=()=>{throw new ContentPreparationError('unsupported_operation','This article recovery test does not install a media or publication provider.',503);};
test('actual HTTP Creator birth accepts rich preparation and a cold worker resumes it from the same guarded repository authority',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'retained-repository-http-')),path=join(directory,'state.sqlite');let local,runtime,store,creatorId;
 let births=0,preparations=0;
 const open=()=>createLocalAdapterSet({databasePath:path,dataDirectory:directory,cellId:'cell',publicBaseUrl:'http://localhost'});
 const boot=async()=>{
  const existing=(await local.repositories.creators.list({limit:100})).items.find(row=>row.contentAuthority==='retained-v1');
  creatorId=existing?.id;
  const select=id=>{creatorId=id;store=retainedStore(local.repositories,{}, {...scope,creatorId:id});};
  if(creatorId)select(creatorId);
  const host=actor=>({authorizeCreator:id=>id===creatorId&&store?store.authorizeActor(actor):Promise.resolve(false),canManageCollections:id=>id===creatorId&&store?store.authorizeActor(actor,'manage'):Promise.resolve(false),recoveryAuthorization:host,defaultSettings:()=>({...defaultContentPreparation(),access:'private'}),inspectOriginal:unavailable,captureSetup:unavailable,contentMetadataWork:unavailable,validateCollectionVolumes:unavailable,resolvedCollectionMembers:unavailable,recordImageCompatibility:unavailable});
  const recovery=()=>new ContentWorkflowService(store,{tenantId:'tenant'},host('worker-has-no-creator-authority'));
  runtime=createCoreRuntime({instanceId:'instance',cellId:'cell',region:'ca-central-1',publicBaseUrl:'http://localhost',adapters:{repositories:local.repositories,storage:local.storage,uploads:local.storage,delivery:local.storage,jobs:local.jobs,identity:local.identity,localIdentity:local.identity},
   creatorLifecycle:{prepare:async input=>{preparations++;assert.equal(input.creator.contentAuthority,'retained-v1');assert.equal(input.creator.subjectId,input.actorUserId);assert.equal((await input.repositories.creators.get(input.creator.id,{transaction:input.transaction})).contentAuthority,'retained-v1');}},
   contentPreparation:()=>({createCreator:async input=>{births++;assert.equal(Object.isFrozen(input.record),true);const creator=await createRetainedRepositoryCreator(input.repositories,input.record,'tenant',input.transaction);select(creator.id);return creator;},access:(req,_res,id)=>id===creatorId&&store?store.authorizeActor(req.session.subject.id,'read'):Promise.resolve(false),createService:req=>new ContentWorkflowService(store,{tenantId:'tenant'},host(req.session.subject.id)),createRelease:unavailable,enabled:()=>true,durableDrafts:()=>true,offerings:async()=>[],announcementDestinations:async()=>[],destinations:async()=>[],managementUrl:()=>'/works',runNextJob:()=>store?recovery().recoverNext():Promise.resolve(undefined)})});
  await new Promise(resolve=>runtime.server.listen(0,'127.0.0.1',resolve));
 };
 t.after(async()=>{await runtime?.close();local?.database.close();await rm(directory,{recursive:true,force:true});});
 local=open();const credentials={email:'owner@example.test',password:'Synthetic local password 123!'},account=await local.identity.register(credentials),signed=await local.identity.authenticate(credentials);
 await boot();
 const birthBody={handle:'retained-http-owner',displayName:'Retained Owner',idempotencyKey:'retained-http-birth'};
 const createCreator=async()=>{const response=await fetch(`http://127.0.0.1:${runtime.server.address().port}/v1/creators`,{method:'POST',headers:{authorization:'Bearer '+signed.token,'content-type':'application/json'},body:JSON.stringify(birthBody)});return {status:response.status,body:await response.json()};};
 const born=await createCreator();assert.equal(born.status,202,JSON.stringify(born.body));assert.equal(born.body.creator.id,creatorId);assert.equal(born.body.creator.subjectId,account.subjectId);assert.equal(born.body.creator.contentAuthority,'retained-v1');
 assert.equal((await createCreator()).body.creator.id,creatorId);assert.equal(births,1);assert.equal(preparations,1);
 const call=async(suffix,body)=>{const response=await fetch(`http://127.0.0.1:${runtime.server.address().port}/api/studio/content${suffix}?creatorId=${creatorId}`,{method:body?'POST':'GET',headers:{authorization:'Bearer '+signed.token,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,body:await response.json()};};
 let response=await call('/workflows',{operationId:'begin-durable',entry:{intent:'work'}});assert.equal(response.status,200,JSON.stringify(response.body));let draft=response.body;
 response=await call(`/workflows/${draft.id}/objects`,{expectedRevision:draft.revision,operationId:'write-durable',object:{media:'article',title:'Full retained subject',text:'Original text survives the process boundary.'}});assert.equal(response.status,200);draft=response.body;
 const create=store.createWork;Object.defineProperty(store,'createWork',{value:async()=>{throw Error('Synthetic interruption after durable acceptance');}});
 try{assert.equal((await call(`/workflows/${draft.id}/save`,{expectedRevision:draft.revision,operationId:'save-durable'})).status,500);}finally{Object.defineProperty(store,'createWork',{value:create});}
 assert.equal((await store.publicationAtomic.get(`content-workflow:tenant:${creatorId}:draft`,draft.id)).state,'accepted');assert.deepEqual(await store.listWorksByCreator('tenant',creatorId),[]);
 await runtime.close();local.database.close();local=open();await boot();
 const result=await runtime.runNextJob('fresh-unprivileged-worker');assert.equal(result.kind,'content-preparation');assert.equal(result.id,draft.id);assert.equal(result.state,'draft');
 const works=await store.listWorksByCreator('tenant',creatorId);assert.equal(works.length,1);assert.equal(works[0].body[0].text,'Original text survives the process boundary.');assert.equal((await call(`/workflows/${draft.id}`)).body.draft.state,'draft');assert.equal(await runtime.runNextJob('retry'),undefined);
 assert.deepEqual((await local.repositories.works.list({limit:100})).items,[],'no compact-model copy or second writer');
 for(const path of ['/v1/works','/v1/collections','/v1/exports/me']){
  const response=await fetch(`http://127.0.0.1:${runtime.server.address().port}${path}?creatorId=${creatorId}`,{headers:{authorization:'Bearer '+signed.token}}),body=await response.json();assert.equal(response.status,503,JSON.stringify(body));assert.equal(body.error.code,'retained_content_routes_unavailable','compact readers never fabricate an empty retained history');
 }
 assert.equal((await local.repositories.exportManifests.list({limit:100})).items.length,0);
 assert.equal((await createCreator()).body.creator.id,creatorId);assert.equal(births,1);assert.equal(preparations,1);
});
