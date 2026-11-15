import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {MemoryCreatorContentStore} from '@ubeeq/persistence';
import {createLocalAdapterSet,installSqliteRetainedContentAtomic} from '@ubeeq/adapter-local';
import {defaultContentPreparation} from '@ubeeq/core';
import {ContentWorkflowService,ContentPreparationError} from '../dist/content-preparations.js';
import {createCoreRuntime} from '../dist/index.js';

const unavailable=()=>{throw new ContentPreparationError('unsupported_operation','This intake fixture does not install a release or media provider.',503);};
class RichStore extends MemoryCreatorContentStore {
 creators=[];
 async getCreatorById(id){return this.creators.find(c=>c.creatorId===id)??null;}
 async listCreators(){return this.creators;}
 async getAnnouncementOrchestration(){return null;}
}
async function fixture(t){
 const directory=await mkdtemp(join(tmpdir(),'retained-worker-http-')),path=join(directory,'state.sqlite');
 const local=createLocalAdapterSet({databasePath:path,dataDirectory:directory,cellId:'cell',publicBaseUrl:'http://localhost'});
 const credentials={email:'owner@example.test',password:'Synthetic password 123!'},account=await local.identity.register(credentials),signed=await local.identity.authenticate(credentials);
 const store=new RichStore(),atomic=installSqliteRetainedContentAtomic(store,path,{fields:['creators','works','canonicalAssets','workAssets','publications','publicationIntents','creatorCollections','collectionWorks','workDiscovery'],savePublication:p=>store.upsertPublication(p)});
 await atomic.run(async()=>{store.creators=[{creatorId:'creator',status:'active',owner:account.subjectId}];});
 const host=actor=>{
  const allowed=async id=>(await store.getCreatorById(id))?.owner===actor;
  return {authorizeCreator:allowed,canManageCollections:allowed,recoveryAuthorization:host,defaultSettings:()=>({...defaultContentPreparation(),access:'private'}),inspectOriginal:unavailable,captureSetup:unavailable,contentMetadataWork:unavailable,validateCollectionVolumes:unavailable,resolvedCollectionMembers:unavailable,recordImageCompatibility:unavailable};
 };
 const recovery=new ContentWorkflowService(store,{tenantId:'tenant'},host('worker-has-no-creator-permission'));
 let workerFailure;
 const runtime=createCoreRuntime({instanceId:'instance',cellId:'cell',region:'local',publicBaseUrl:'http://localhost',adapters:{repositories:local.repositories,storage:local.storage,uploads:local.storage,delivery:local.storage,jobs:local.jobs,identity:local.identity,localIdentity:local.identity},
  tenancy:{mode:'single_operator',assertCanCreateCreatorUser:unavailable,assertCanCreateCustomerAccount:async()=>{},listAccessibleCreatorIds:async actor=>(await host(actor).authorizeCreator('creator'))?['creator']:[],resolveCreatorRole:async(actor,id)=>(await host(actor).authorizeCreator(id))?'owner':null,isContributorManagementEnabled:()=>false,isOrganizationManagementEnabled:()=>false},
  contentPreparation:()=>({access:async(req,_res,id)=>host(req.session.subject.id).authorizeCreator(id),createService:req=>new ContentWorkflowService(store,{tenantId:'tenant'},host(req.session.subject.id)),createRelease:unavailable,enabled:()=>true,durableDrafts:()=>atomic.supportsConditionalTransactions,offerings:async()=>[],announcementDestinations:async()=>[],destinations:async()=>[],managementUrl:()=>'/works',runNextJob:async()=>{if(workerFailure)throw workerFailure;return recovery.recoverNext();}})});
 await new Promise(resolve=>runtime.server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{await runtime.close();atomic.close();local.database.close();await rm(directory,{recursive:true,force:true});});
 const request=async(suffix,body)=>{const response=await fetch(`http://127.0.0.1:${runtime.server.address().port}/api/studio/content${suffix}?creatorId=creator`,{method:body?'POST':'GET',headers:{authorization:'Bearer '+signed.token,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,body:await response.json()};};
 const acceptInterrupted=async key=>{
  let result=await request('/workflows',{operationId:'begin-'+key,entry:{intent:'work'}});assert.equal(result.status,200);let draft=result.body;
  result=await request(`/workflows/${draft.id}/objects`,{expectedRevision:draft.revision,operationId:'write-'+key,object:{media:'article',title:'Retained '+key,text:'Original authored text'}});assert.equal(result.status,200);draft=result.body;
  const create=store.createWork;store.createWork=async()=>{throw Error('Synthetic interruption after acceptance');};
  try{assert.equal((await request(`/workflows/${draft.id}/save`,{expectedRevision:draft.revision,operationId:'save-'+key})).status,500);}finally{store.createWork=create;}
  assert.equal((await atomic.get(recovery.kind('creator'),draft.id)).state,'accepted');
  return draft;
 };
 return {runtime,local,store,atomic,recovery,request,acceptInterrupted,failWorker:value=>{workerFailure=value;}};
}

test('actual shared HTTP acceptance is resumed by the host worker under the saved actor, without compact-model copies',async t=>{
 const f=await fixture(t),draft=await f.acceptInterrupted('recover');
 assert.equal(f.store.works.length,0);
 const result=await f.runtime.runNextJob('an-unprivileged-worker');assert.equal(result.kind,'content-preparation');assert.equal(result.id,draft.id);assert.equal(result.state,'draft');
 assert.equal(f.store.works.length,1);assert.equal(f.store.works[0].body[0].text,'Original authored text');
 assert.equal((await f.request(`/workflows/${draft.id}`)).body.draft.state,'draft');
 assert.deepEqual((await f.local.repositories.works.list({limit:100})).items,[]);
 assert.equal(await f.runtime.runNextJob('retry'),undefined);assert.equal(f.store.works.length,1);
});

test('revoked saved authority cannot be replaced by the worker identity',async t=>{
 const f=await fixture(t),draft=await f.acceptInterrupted('revoked');
 await f.atomic.run(async()=>{f.store.creators[0].owner='the-new-owner';});
 await assert.rejects(f.runtime.runNextJob('the-new-owner'),/access denied/i);
 assert.equal(f.store.works.length,0);assert.equal((await f.atomic.get(f.recovery.kind('creator'),draft.id)).state,'accepted');
 assert.ok((await f.local.repositories.auditEvents.list({limit:100})).items.some(row=>row.action==='content.preparation.worker_deferred'));
});

test('a fresh host skips a denied old actor before resuming another eligible accepted draft',async t=>{
 const f=await fixture(t),draft=await f.acceptInterrupted('eligible');
 const accepted=await f.atomic.get(f.recovery.kind('creator'),draft.id);
 const operation=(await f.atomic.list(f.recovery.kind('creator','operation'))).find(row=>row.state==='accepted'&&row.draft?.id===draft.id);
 await f.atomic.run(async()=>{
  await f.atomic.put(f.recovery.kind('creator'),'0',{...accepted,id:'0',actorId:'revoked-actor'});
  await f.atomic.put(f.recovery.kind('creator','operation'),'denied-operation',{...operation,id:'denied-operation',draft:{...operation.draft,id:'0',actorId:'revoked-actor'}});
 });
 const result=await f.runtime.runNextJob('a-fresh-unprivileged-worker');assert.equal(result.id,draft.id);assert.equal(f.store.works.length,1);
 assert.equal((await f.atomic.get(f.recovery.kind('creator'),'0')).state,'accepted');
});

test('a deferred retained worker cannot starve an actual queued processing-recovery job',async t=>{
 const f=await fixture(t);f.failWorker(Error('Retained authority temporarily unavailable'));
 const asset=await f.local.repositories.assets.create({id:'already-processed',instanceId:'instance',homeCellId:'cell',dataHomeRegion:'local',dataHomeAssignedAt:new Date().toISOString(),routingRevision:1,creatorId:'creator',mimeType:'text/plain',checksum:'a'.repeat(64),objectVersion:'source-v1',status:'ready'});
 const job=await f.local.jobs.enqueue({cellId:'cell',type:'asset.process',payload:{assetId:asset.id},idempotencyKey:'accepted-processing-recovery',maxAttempts:3});
 const result=await f.runtime.runNextJob('shared-worker');assert.equal(result.job.id,job.id);assert.equal(result.job.state,'completed');
 assert.equal((await f.local.jobs.get(job.id)).state,'completed');
 await assert.rejects(f.runtime.runNextJob('retry'),/temporarily unavailable/);
 f.failWorker(undefined);assert.equal(await f.runtime.runNextJob('recovered'),undefined);
});
