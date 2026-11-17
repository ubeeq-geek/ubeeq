import test from 'node:test';
import assert from 'node:assert/strict';
import {AsyncLocalStorage} from 'node:async_hooks';
import {defaultContentPreparation} from '@ubeeq/core';
import {publicationIdentityHash} from '@ubeeq/persistence';
import {ContentWorkflowService} from '../dist/content-preparations.js';

// Tests coordinator behavior only. Consuming hosts verify durable storage;
// this map is not a production adapter or evidence of database isolation.
function fixture(destination='native') {
 const context=new AsyncLocalStorage();
 let rows=new Map(),works=new Map(),permission=true,permissionRevision=1,afterCommit,failWrite=false;
 const calls=[],actors=[],copy=v=>v===undefined?undefined:structuredClone(v),key=(kind,id)=>JSON.stringify([kind,id]);
 const atomic={supportsConditionalTransactions:true,
  async run(operation){
   if(context.getStore())return operation(context.getStore());
   const beforeRows=copy(rows),beforeWorks=copy(works),beforePermission=permissionRevision;
   try {
    const result=await context.run({id:'test'},()=>operation({id:'test'}));
    if(permissionRevision!==beforePermission)throw Error('Conditional authorization read changed');
    const hook=afterCommit;afterCommit=undefined;if(hook)hook();return result;
   }catch(error){rows=beforeRows;works=beforeWorks;throw error;}
  },
  async get(kind,id){return copy(rows.get(key(kind,id)));},
  async list(kind){return [...rows].filter(([entry])=>JSON.parse(entry)[0]===kind).map(([,value])=>copy(value));},
  async put(kind,id,value){rows.set(key(kind,id),copy(value));}
 };
 const store={publicationAtomic:atomic,
  async getCreatorById(id){return id==='creator'?{creatorId:id,status:'active'}:null;},
  async listCreators(){return [{creatorId:'creator',status:'active'}];},
  async getWork(tenant,id){const value=works.get(id);return value?.tenantId===tenant?copy(value):null;},
  async listWorksByCreator(tenant,creator){return [...works.values()].filter(w=>w.tenantId===tenant&&w.creatorId===creator).map(copy);},
  async createWork(work){assert.ok(context.getStore());assert.equal(works.has(work.workId),false);works.set(work.workId,copy(work));},
  async commitWorkRevision(work,expected){assert.ok(context.getStore());if(failWrite){failWrite=false;throw Error('Synthetic worker interruption');}assert.equal(works.get(work.workId)?.revision,expected);works.set(work.workId,copy(work));},
  async getAnnouncementOrchestration(){return null;},async getWorkDiscoveryParticipation(){return null;}
 };
 class Host {
  destination=destination;
  async authorizeCreator(id){calls.push({actor:'request',inside:!!context.getStore()});return id==='creator'&&permission;}
  async canManageCollections(id){return this.authorizeCreator(id);}
  recoveryAuthorization(actor){assert.equal(this.destination,destination);actors.push(actor);const check=async id=>{calls.push({actor,inside:!!context.getStore()});return actor==='owner'&&id==='creator'&&permission;};return {authorizeCreator:check,canManageCollections:check};}
  defaultSettings(){return {...defaultContentPreparation(),access:'free',publishDestinations:[{destination:this.destination,representation:'full',required:true}]};}
  async inspectOriginal(){throw Error('Unexpected uploaded-original read');}
  async captureSetup(){throw Error('Unexpected setup capture');}
  async contentMetadataWork(){throw Error('Unexpected metadata operation');}
  validateCollectionVolumes(){throw Error('Unexpected hierarchy operation');}
  async resolvedCollectionMembers(){throw Error('Unexpected collection operation');}
  async recordImageCompatibility(){throw Error('Unexpected image operation');}
 }
 const host=new Host(),service=new ContentWorkflowService(store,{tenantId:'tenant'},host,()=> '2026-11-14T00:00:00.000Z');
 const f={store,host,service,atomic,calls,actors,get works(){return [...works.values()].map(copy);},get rows(){return copy(rows);},
  revoke(){permission=false;permissionRevision++;},allow(){permission=true;permissionRevision++;},interrupt(){failWrite=true;},afterCommit(hook){afterCommit=hook;},
  worker(){const systemHost=Object.create(host);systemHost.authorizeCreator=async()=>true;systemHost.canManageCollections=async()=>true;return new ContentWorkflowService(store,{tenantId:'tenant'},systemHost);},
  async authored(intent='work',count=1){let d=await service.begin('creator','owner','begin',{intent});for(let i=0;i<count;i++)d=await service.addObject('creator',d.id,d.revision,`write-${i}`,{media:'article',title:`Article ${i}`,text:`Original ${i}`});return d;}
 };return f;
}

test('host capabilities and conditional transactions are required before any write',async()=>{
 const f=fixture();assert.throws(()=>new ContentWorkflowService(f.store,{tenantId:'tenant'},{}),e=>e.code==='unsupported_operation');f.atomic.supportsConditionalTransactions=false;
 await assert.rejects(f.service.begin('creator','owner','begin',{intent:'work'}),e=>e.code==='unsupported_operation');assert.equal(f.rows.size,0);assert.equal(f.works.length,0);
});
test('hosts supply fresh product defaults without cross-product mutation',async()=>{
 const first=fixture('one'),second=fixture('two'),a=await first.service.begin('creator','owner','a',{intent:'work'}),b=await second.service.begin('creator','owner','b',{intent:'work'});
 assert.equal(a.settings.publishDestinations[0].destination,'one');assert.equal(b.settings.publishDestinations[0].destination,'two');a.settings.publishDestinations[0].destination='changed';assert.equal((await first.service.get('creator',a.id)).settings.publishDestinations[0].destination,'one');
});
test('assembly preserves one private Work, body order and child receipt replay',async()=>{
 const f=fixture(),d=await f.authored('work',2),saved=await f.service.saveDraft('creator',d.id,d.revision,'save');assert.equal(f.works.length,1);assert.equal(f.works[0].status,'draft');assert.deepEqual(f.works[0].body.map(b=>b.text),['Original 0','Original 1']);const before=f.works;
 assert.deepEqual(await f.service.saveDraft('creator',d.id,d.revision,'save'),saved);assert.deepEqual(f.works,before);assert.equal(saved.checkpoint,'review');
});
test('denied recovery keeps accepted progress and later resumes once as the saved actor',async()=>{
 const f=fixture(),d=await f.authored();f.interrupt();await assert.rejects(f.service.saveDraft('creator',d.id,d.revision,'save'),/Synthetic worker interruption/);assert.equal((await f.service.get('creator',d.id)).state,'accepted');assert.equal(f.works.length,0);const accepted=f.rows;
 f.revoke();const worker=f.worker();await worker.recover();assert.equal(f.works.length,0);assert.deepEqual(f.rows,accepted);assert.deepEqual(f.actors,['owner']);assert.ok(f.calls.filter(c=>c.actor==='owner').every(c=>c.inside));
 f.allow();await worker.recover();assert.equal(f.works.length,1);const saved=await f.service.get('creator',d.id);assert.equal(saved.state,'draft');await worker.recover();assert.equal(f.works.length,1);assert.deepEqual(await f.service.saveDraft('creator',d.id,d.revision,'save'),saved);
});
test('recovery cannot use editor permission to finish an accepted collection after manager access is lost',async()=>{
 const f=fixture(),d=await f.authored('collection',2);f.interrupt();await assert.rejects(f.service.saveDraft('creator',d.id,d.revision,'save'),/Synthetic worker interruption/);
 const accepted=f.rows,auth=f.host.recoveryAuthorization.bind(f.host);
 f.host.recoveryAuthorization=actor=>({...auth(actor),canManageCollections:async()=>false});
 await f.worker().recover();assert.equal(f.works.length,0);assert.deepEqual(f.rows,accepted);
});
test('revocation after a recovered child retains it and blocks the next child until access returns',async()=>{
 const f=fixture(),d=await f.authored('new',2),separate=await f.service.revise('creator',d.id,d.revision,'separate',{arrangement:'separate_works',arrangementConfirmed:true});f.interrupt();await assert.rejects(f.service.saveDraft('creator',d.id,separate.revision,'save'),/Synthetic worker interruption/);
 const worker=f.worker(),put=f.atomic.put.bind(f.atomic);f.atomic.put=async(kind,id,value)=>{await put(kind,id,value);if(kind===f.service.kind('creator','receipt')&&value.result?.kind==='work')f.afterCommit(()=>f.revoke());};
 await worker.recover();assert.equal(f.works.length,1);assert.equal((await worker.get('creator',d.id)).state,'accepted');const first=f.works[0];f.atomic.put=put;f.allow();await worker.recover();assert.equal(f.works.length,2);assert.deepEqual(f.works.find(w=>w.workId===first.workId),first);assert.equal((await f.service.get('creator',d.id)).state,'draft');
});
test('a changed permission guard rolls back the child, progress and receipt',async()=>{
 const f=fixture(),d=await f.authored(),put=f.atomic.put.bind(f.atomic);f.atomic.put=async(kind,id,value)=>{await put(kind,id,value);if(kind===f.service.kind('creator','receipt')&&value.result?.kind==='work')f.revoke();};await assert.rejects(f.service.saveDraft('creator',d.id,d.revision,'save'),/Conditional authorization read changed/);assert.equal(f.works.length,0);
 assert.equal(await f.atomic.get(f.service.kind('creator','receipt'),publicationIdentityHash(['save',d.objects[0].id])),undefined);f.atomic.put=put;f.allow();await f.service.recover();assert.equal(f.works.length,1);
});
test('tenant and live access guard receipt replay; stale revisions cannot overwrite',async()=>{
 const f=fixture(),d=await f.authored(),changed=await f.service.revise('creator',d.id,d.revision,'rename',{title:'Renamed'});await assert.rejects(f.service.revise('creator',d.id,d.revision,'stale',{title:'Lost update'}),e=>e.code==='revision_conflict');const other=new ContentWorkflowService(f.store,{tenantId:'other'},f.host);await assert.rejects(other.get('creator',d.id),e=>e.code==='not_found');
 f.revoke();await assert.rejects(f.service.revise('creator',d.id,d.revision,'rename',{title:'Renamed'}),e=>e.code==='access_denied');f.allow();assert.deepEqual(await f.service.get('creator',d.id),changed);
});
