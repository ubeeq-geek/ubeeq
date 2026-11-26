import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {setImmediate as turn} from 'node:timers/promises';
import {createLocalAdapterSet} from '@ubeeq/adapter-local';
import {withRepositoryRead} from '@ubeeq/persistence';
import {createUnmeteredUsageQuotaPort} from '@ubeeq/extension-sdk';
import {persistProcessedOutputs} from '@ubeeq/runtime/processed-outputs';
import {OwnedObjectWrites} from '@ubeeq/runtime/owned-object-writes';
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
const observe=promise=>{let settled=false;const result=promise.then(value=>{settled=true;return{value};},error=>{settled=true;return{error};});return{result,get settled(){return settled;}};};
// A deterministic trusted processor tests journal/storage ownership, not codecs.
async function fixture(t){
 const directory=await mkdtemp(join(tmpdir(),'ubeeq-processed-metadata-scope-')),local=createLocalAdapterSet({databasePath:join(directory,'state.sqlite'),dataDirectory:directory,cellId:'cell',publicBaseUrl:'http://127.0.0.1'}),releases=[],pending=[],hooks={};
 const track=promise=>{pending.push(promise);void promise.catch(()=>{});return promise;};
 t.after(async()=>{for(const release of releases)release();await Promise.allSettled(pending);local.database.close();await rm(directory,{recursive:true,force:true});});
 const home={instanceId:'instance',homeCellId:'cell',dataHomeRegion:'local',dataHomeAssignedAt:'2026-01-01T00:00:00.000Z',routingRevision:1},bytes=Buffer.from('actual retained source'),encoded=Buffer.from('actual trusted processor derivative'),source={bucket:'cell',key:'cells/cell/creators/creator/source/asset',versionId:'physical-source',contentType:'application/octet-stream',byteLength:bytes.byteLength,checksum:createHash('sha256').update(bytes).digest('hex'),scope:'private'};
 await local.storage.put({object:source,body:bytes});const asset=await local.repositories.assets.create({...home,id:'asset',creatorId:'creator',mimeType:source.contentType,checksum:source.checksum,objectVersion:'logical-original',status:'pending',storage:source});
 const quota=createUnmeteredUsageQuotaPort();let settlements=0,produced=0,writes=0;const settle=quota.recordUsageSettlement.bind(quota);quota.recordUsageSettlement=async input=>{assert.equal(local.database.currentTransactionId(),undefined,'Quota IO stays outside metadata transactions.');settlements++;return settle(input);};
 for(const method of ['initiate','acceptStream','complete']){const original=local.storage[method].bind(local.storage);t.mock.method(local.storage,method,async input=>{assert.equal(local.database.currentTransactionId(),undefined,'Physical upload entry stays outside metadata transactions.');if(method==='complete')writes++;return original(input);});}
 const owned=new OwnedObjectWrites(local.repositories,local.storage,quota,'instance','cell'),write=owned.write.bind(owned);t.mock.method(owned,'write',async input=>{const value=await write(input);if(hooks.afterOwned)await hooks.afterOwned(value);return value;});
 const options={repositories:local.repositories,storage:local.storage,owned,asset,source,usageKey:'actual-private-output-set',primaryScope:'private',
  async assertCurrent(){assert.equal(local.database.currentTransactionId(),undefined,'Current-domain validation stays outside journal writes.');const current=await withRepositoryRead(local.repositories,transaction=>local.repositories.assets.get(asset.id,{transaction}));assert.equal(current.revision,asset.revision);},
  async produce(){assert.equal(local.database.currentTransactionId(),undefined,'Processing stays outside SQL.');produced++;if(hooks.produce)await hooks.produce();return{result:{metadata:{decoded:true},measuredUnits:1,renditions:[{id:'preview',sourceVersionId:asset.objectVersion,role:'preview',contentType:'image/png',byteLength:encoded.byteLength,body:encoded}]},async fallback(){throw Error('The genuine encoded primary does not use fallback.');}};},
  async transform(body,mimeType){assert.equal(local.database.currentTransactionId(),undefined,'Transforming stays outside SQL.');return{bytes:body,mimeType};}};
 const rows=async()=>withRepositoryRead(local.repositories,async transaction=>(await local.repositories.hostRecords.list({limit:100},{transaction})).items);
 const journal=async()=>(await rows()).find(row=>row.namespace==='runtime-processed-outputs');
 const hold=async(operation=async transaction=>{await local.repositories.hostRecords.create({...home,id:'unrelated-'+randomUUID(),namespace:'actual-processing-writer',scopeId:'creator',key:'marker',value:{actual:true}},{transaction});},rollback=false)=>{const entered=deferred(),release=deferred();releases.push(release.resolve);const writer=observe(track(local.repositories.transaction(async transaction=>{await operation(transaction);entered.resolve();await release.promise;if(rollback)throw Error('actual-processing-writer-rollback');})));await entered.promise;return{release,writer};};
 const run=()=>track(persistProcessedOutputs(options));
 const verify=async output=>{assert.equal(output.storage.scope,'private');assert.deepEqual(Buffer.from((await local.storage.get(output.storage)).body),encoded);assert.deepEqual(Buffer.from((await local.storage.get(source)).body),bytes);assert.equal(output.storage.checksum,createHash('sha256').update(encoded).digest('hex'));assert.equal(output.renditions.length,1);};
 return{...local,home,asset,source,encoded,options,hooks,owned,run,verify,journal,rows,hold,track,releases,get produced(){return produced;},get writes(){return writes;},get settlements(){return settlements;}};
}
for(const rollback of [false,true])test(`processed-output recovery queues behind a real ${rollback?'rolled-back':'committed'} journal writer and never observes its uncommitted row`,{timeout:20000},async t=>{
 const f=await fixture(t),first=await f.run(),row=await f.journal(),counts=[f.produced,f.writes,f.settlements];
 const held=await f.hold(transaction=>f.repositories.hostRecords.update(row.id,row.revision,{value:rollback?{...row.value,plan:{...row.value.plan,binding:'uncommitted-invalid-binding'}}:{...row.value,unknownActualField:{retained:['full','JSON']}}},{transaction}),rollback),pending=observe(f.run());
 try{await turn();await turn();assert.equal(pending.settled,false,'An outside journal read must queue behind its actual owner.');}finally{held.release.resolve();await held.writer.result;await pending.result;}
 const result=await pending.result;if(result.error)throw result.error;assert.deepEqual(result.value,first);await f.verify(result.value);assert.deepEqual([f.produced,f.writes,f.settlements],counts);assert.equal((await f.repositories.auditEvents.list({limit:100})).items.length,0);const current=await f.journal();assert.deepEqual(current.value.plan,row.value.plan);if(!rollback)assert.deepEqual(current.value.unknownActualField,{retained:['full','JSON']});else assert.deepEqual(current,row);
});
test('new output-set journal creation queues after real processing and before any physical output',{timeout:20000},async t=>{
 const f=await fixture(t),producing=deferred(),resume=deferred();f.releases.push(resume.resolve);f.hooks.produce=async()=>{producing.resolve();await resume.promise;};const pending=observe(f.run());await producing.promise;const held=await f.hold();resume.resolve();
 try{await turn();await turn();assert.equal(pending.settled,false,'Journal creation must queue instead of borrowing a foreign connection.');assert.equal(f.writes,0);}finally{held.release.resolve();await held.writer.result;await pending.result;}
 const result=await pending.result;if(result.error)throw result.error;await f.verify(result.value);assert.equal(f.produced,1);assert.equal(f.writes,1);assert.equal((await f.rows()).filter(row=>row.namespace==='runtime-processed-outputs').length,1);
});
test('an actual completed owned receipt waits for a foreign journal writer before its factual output append',{timeout:20000},async t=>{
 const f=await fixture(t),completed=deferred(),resume=deferred();f.releases.push(resume.resolve);f.hooks.afterOwned=async()=>{completed.resolve();await resume.promise;};const pending=observe(f.run());await completed.promise;const row=await f.journal();assert.deepEqual(row.value.objects,{});const held=await f.hold(transaction=>f.repositories.hostRecords.update(row.id,row.revision,{value:{...row.value,opaqueUnknown:{keep:'exact full original DTO'}}},{transaction}));resume.resolve();
 try{await turn();await turn();assert.equal(pending.settled,false,'The completed object cannot bypass a current metadata writer.');assert.equal(f.writes,1);}finally{held.release.resolve();await held.writer.result;await pending.result;}
 const result=await pending.result;if(result.error)throw result.error;await f.verify(result.value);assert.deepEqual((await f.journal()).value.opaqueUnknown,{keep:'exact full original DTO'});assert.equal(Object.keys((await f.journal()).value.objects).length,1);assert.equal(f.writes,1);
});
test('save point read, immutable comparison and CAS share one actual metadata transaction without exposing a writer gap',{timeout:20000},async t=>{
 const f=await fixture(t),owned=deferred(),resumeOwned=deferred(),read=deferred(),resumeRead=deferred();f.releases.push(resumeOwned.resolve,resumeRead.resolve);f.hooks.afterOwned=async()=>{owned.resolve();await resumeOwned.promise;};
 const originalGet=f.repositories.hostRecords.get.bind(f.repositories.hostRecords),originalUpdate=f.repositories.hostRecords.update.bind(f.repositories.hostRecords);let armed=false,readTransaction,updates=0;
 t.mock.method(f.repositories.hostRecords,'get',async(id,options)=>{const row=await originalGet(id,options);if(armed&&id.startsWith('processed-outputs-')){armed=false;readTransaction=f.database.currentTransactionId();read.resolve();await resumeRead.promise;}return row;});
 t.mock.method(f.repositories.hostRecords,'update',async(id,revision,patch,options)=>{if(id.startsWith('processed-outputs-')){updates++;assert.ok(readTransaction,'The actual save read owns a real transaction.');assert.equal(f.database.currentTransactionId(),readTransaction);assert.equal(options?.transaction?.id,readTransaction);}return originalUpdate(id,revision,patch,options);});
 const pending=observe(f.run());await owned.promise;armed=true;resumeOwned.resolve();await read.promise;let foreignEntered=false;const foreign=observe(f.track(f.repositories.transaction(async transaction=>{foreignEntered=true;await f.repositories.hostRecords.create({...f.home,id:'queued-between-read-and-update',namespace:'actual-processing-writer',scopeId:'creator',key:'queued',value:{actual:true}},{transaction});})));
 try{await turn();await turn();assert.equal(foreignEntered,false,'The same writer excludes another transaction between journal read and CAS.');}finally{resumeRead.resolve();await pending.result;await foreign.result;}
 const result=await pending.result;if(result.error)throw result.error;const queued=await foreign.result;if(queued.error)throw queued.error;assert.equal(foreignEntered,true);assert.equal(updates,1);await f.verify(result.value);assert.equal(f.writes,1);
});
test('a lost journal after a genuine completed object fails closed and cannot recreate or recharge the output set',{timeout:20000},async t=>{
 const f=await fixture(t);f.hooks.afterOwned=async()=>{const row=await f.journal();await f.repositories.transaction(transaction=>f.repositories.hostRecords.remove(row.id,row.revision,{transaction}));};await assert.rejects(f.run());assert.equal(await f.journal(),undefined);assert.equal(f.writes,1);const counts=[f.writes,f.settlements];f.hooks.afterOwned=undefined;await assert.rejects(f.run(),/journal is missing/);assert.deepEqual([f.writes,f.settlements],counts);assert.equal(await f.journal(),undefined);assert.equal((await f.rows()).filter(row=>row.namespace==='runtime-owned-object'&&row.value.phase==='completed').length,1);
});
