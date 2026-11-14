import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {createLocalAdapterSet} from '@ubeeq/adapter-local';
import {createCoreRuntime} from '../dist/index.js';
import {createDefaultOpenCorePorts} from '@ubeeq/extension-sdk';
import {creatorAssetObjectInventory} from '@ubeeq/portability';
// Tests output persistence with a synthetic trusted processor, not codec validity.
test('the runtime delivers declared processed audio bytes and preserves the original',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'processed-media-regression-'));
 const local=createLocalAdapterSet({databasePath:join(directory,'state.sqlite'),dataDirectory:directory,cellId:'cell',publicBaseUrl:'http://localhost'});
 const source=Buffer.from('RIFF0000WAVEoriginal-source'),encoded=Buffer.from('ID3processed-audio');
 const runtime=createCoreRuntime({instanceId:'instance',cellId:'cell',publicBaseUrl:'http://localhost',
  adapters:{repositories:local.repositories,storage:local.storage,uploads:local.storage,delivery:local.storage,jobs:local.jobs,identity:local.identity,localIdentity:local.identity},
  mediaProcessor:{async process(input){assert.deepEqual(Array.from(input.source),Array.from(source));return {metadata:{decoded:true},measuredUnits:1,
   renditions:[{id:'encoded-audio',sourceVersionId:input.sourceVersionId,role:'preview',contentType:'audio/mpeg',byteLength:encoded.length,body:new Uint8Array(encoded)}]};}}});
 t.after(async()=>{await runtime.close();local.database.close();await rm(directory,{recursive:true,force:true});});
 const storage={bucket:'local',key:'cells/cell/creators/creator/source/asset',versionId:'v1',contentType:'audio/wav',byteLength:source.length,checksum:createHash('sha256').update(source).digest('hex'),scope:'private'};
 await local.storage.put({object:storage,body:source});
 await local.repositories.assets.create({id:'asset',instanceId:'instance',creatorId:'creator',mimeType:'audio/wav',checksum:storage.checksum,objectVersion:'v1',status:'pending',storage,
  homeCellId:'cell',dataHomeRegion:'local',dataHomeAssignedAt:new Date().toISOString(),routingRevision:1});
 await local.jobs.enqueue({cellId:'cell',type:'asset.process',payload:{assetId:'asset'},idempotencyKey:'asset-job',maxAttempts:1});
 await runtime.runNextJob('worker');const ready=await local.repositories.assets.get('asset');assert.equal(ready.status,'ready');
 const delivery=await local.storage.get(ready.storage);assert.equal(delivery.object.contentType,'audio/mpeg');assert.deepEqual(Array.from(delivery.body),Array.from(encoded));
 assert.deepEqual(Array.from((await local.storage.get(ready.originalStorage)).body),Array.from(source));
});

async function fixture(t,process,options={}){
 const directory=await mkdtemp(join(tmpdir(),'processed-output-recovery-'));
 const config={databasePath:join(directory,'state.sqlite'),dataDirectory:directory,cellId:'cell',publicBaseUrl:'http://localhost'};
 let local,runtime,calls=0,writes=0,failReady=false,failJournal=false;
 const reservations=new Map(),settlements=new Map();
 const quota={async checkAndReserveQuota(input){const previous=reservations.get(input.idempotencyKey);if(previous)assert.deepEqual(input,previous);reservations.set(input.idempotencyKey,structuredClone(input));return {allowed:true};},
  async recordUsageSettlement(input){const previous=settlements.get(input.idempotencyKey);if(previous)assert.deepEqual(input,previous);settlements.set(input.idempotencyKey,structuredClone(input));},async closeStorageReservation(){}};
 const start=()=>{
  local=createLocalAdapterSet(config);
  const update=local.repositories.assets.update.bind(local.repositories.assets),complete=local.storage.complete.bind(local.storage),save=local.repositories.hostRecords.update.bind(local.repositories.hostRecords);
  local.repositories.assets.update=async(...args)=>{if(failReady&&args[2]?.status==='ready'){failReady=false;throw Error('Ready commit unavailable');}return update(...args);};
  local.storage.complete=async input=>{writes++;return complete(input);};
  local.repositories.hostRecords.update=async(...args)=>{const row=await local.repositories.hostRecords.get(args[0]);if(failJournal&&row?.namespace==='runtime-processed-outputs'&&Object.keys(args[2]?.value?.objects??{}).length){failJournal=false;throw Error('Output journal commit unavailable');}return save(...args);};
  runtime=createCoreRuntime({instanceId:'instance',...config,...options,adapters:{repositories:local.repositories,storage:local.storage,uploads:local.storage,delivery:local.storage,jobs:local.jobs,identity:local.identity},
   requireUploadAccounting:true,hostPorts:createDefaultOpenCorePorts({usageQuota:quota}),mediaProcessor:{async process(input){calls++;return process(input);}}});
 };
 start();const stop=async()=>{await runtime.close();local.database.close();};
 t.after(async()=>{await stop();await rm(directory,{recursive:true,force:true});});
 const source=Buffer.from('original WAV source bytes'),storage={bucket:'cell',key:'cells/cell/creators/creator/source/asset',versionId:'physical-v2',contentType:'audio/wav',byteLength:source.length,checksum:createHash('sha256').update(source).digest('hex'),scope:'private'};
 await local.storage.put({object:storage,body:source});
 await local.repositories.assets.create({id:'asset',instanceId:'instance',creatorId:'creator',mimeType:'audio/wav',checksum:storage.checksum,objectVersion:'logical-source-v1',status:'pending',storage,
  homeCellId:'cell',dataHomeRegion:'local',dataHomeAssignedAt:'2026-01-01T00:00:00.000Z',routingRevision:1});
 const job=await local.jobs.enqueue({cellId:'cell',type:'asset.process',payload:{assetId:'asset'},idempotencyKey:'asset-job',maxAttempts:3});
 return {source,storage,settlements,reservations,get local(){return local;},get runtime(){return runtime;},get calls(){return calls;},get writes(){return writes;},failReady(){failReady=true;},failJournal(){failJournal=true;},async restart(){await stop();start();},async retry(){await local.jobs.recover({id:job.id,availableAt:new Date(0).toISOString()});return runtime.runNextJob('retry');}};
}
const output=(input,id,body,role='preview',contentType='audio/mpeg')=>({id,role,body:Buffer.from(body),contentType,byteLength:Buffer.byteLength(body),sourceVersionId:input.sourceVersionId});
const result=(renditions,extra={})=>({metadata:{decoded:true},renditions,measuredUnits:1,...extra});
test('several outputs retain aliases, private posters and the explicit primary without duplicating identical private bytes',async t=>{
 const f=await fixture(t,input=>result([output(input,'playback','encoded MP3'),output(input,'poster','poster','poster','image/png'),output(input,'poster-alias','poster','poster','image/png')],{primaryRenditionId:'playback'}));
 await f.runtime.runNextJob('worker');const asset=await f.local.repositories.assets.get('asset');
 assert.equal(asset.mimeType,'audio/wav');assert.equal(asset.deliveryMimeType,'audio/mpeg');assert.equal(asset.originalStorage.versionId,'physical-v2');assert.equal(asset.objectVersion,'logical-source-v1');
 assert.equal(asset.processedRenditions.length,3);assert.equal(f.writes,2);assert.equal(asset.storage.scope,'public');
 assert.deepEqual(asset.processedRenditions[1].storage,asset.processedRenditions[2].storage);assert.equal(asset.processedRenditions[1].storage.scope,'private');
 assert.equal([...f.settlements.values()].filter(value=>value.processingCreditsUsed===1).length,1);
 assert.equal([...f.settlements.values()].reduce((n,value)=>n+(value.storageBytesDelta??0),0),Buffer.byteLength('encoded MP3poster'));
 const inventory=creatorAssetObjectInventory(asset);assert.equal(inventory.checksum,asset.storage.checksum);assert.notEqual(inventory.checksum,asset.checksum);assert.equal(inventory.objects.length,4);
});
for(const fault of ['failReady','failJournal'])test(`${fault}: an accepted output set survives restart without re-encoding or another physical charge`,async t=>{
 const f=await fixture(t,input=>result([output(input,'audio','encoded audio'),output(input,'poster','poster','poster','image/png')]));f[fault]();
 await assert.rejects(()=>f.runtime.runNextJob('worker'),/commit unavailable/);const priorWrites=f.writes;
 await f.restart();await f.retry();const asset=await f.local.repositories.assets.get('asset');
 assert.equal(asset.status,'ready');assert.equal(f.writes,2);assert.equal(f.calls,fault==='failReady'?1:2);
 assert.equal([...f.settlements.values()].reduce((n,value)=>n+(value.storageBytesDelta??0),0),Buffer.byteLength('encoded audioposter'));
 assert.equal([...f.settlements.values()].filter(value=>value.processingCreditsUsed===1).length,1);assert.ok(priorWrites>=1);
 assert.deepEqual(Array.from((await f.local.storage.get(asset.originalStorage)).body),Array.from(f.source));
});
for(const [label,change]of [
 ['wrong source version',value=>({...value,sourceVersionId:'other-version'})],
 ['wrong length',value=>({...value,byteLength:value.byteLength+1})],
 ['invalid body',value=>({...value,body:'not bytes'})],
])test(`${label} is rejected before writing an output`,async t=>{
 const f=await fixture(t,input=>result([change(output(input,'audio','encoded audio'))]));
 await assert.rejects(()=>f.runtime.runNextJob('worker'),/Invalid processed rendition/);assert.equal(f.writes,0);
});
test('duplicate output IDs are rejected before any physical output',async t=>{
 const f=await fixture(t,input=>result([output(input,'audio','one'),output(input,'audio','two')]));
 await assert.rejects(()=>f.runtime.runNextJob('worker'),/Invalid processed rendition/);assert.equal(f.writes,0);
});
test('a changed recipe cannot replace outputs accepted before a journal failure',async t=>{
 let body='first encoding';const f=await fixture(t,input=>result([output(input,'audio',body),output(input,'poster','poster','poster','image/png')]));f.failJournal();
 await assert.rejects(()=>f.runtime.runNextJob('worker'),/journal commit unavailable/);assert.equal(f.writes,1);body='different encoding';
 await f.restart();await assert.rejects(()=>f.retry(),/recipe or bytes changed/);assert.equal(f.writes,1);assert.notEqual((await f.local.repositories.assets.get('asset')).status,'ready');
});
test('a missing output-set journal cannot downgrade new receipts to the legacy single-output path',async t=>{
 const f=await fixture(t,input=>result([output(input,'audio','encoded audio'),output(input,'poster','poster','poster','image/png')]));f.failReady();
 await assert.rejects(()=>f.runtime.runNextJob('worker'),/Ready commit unavailable/);
 const journal=(await f.local.repositories.hostRecords.list({limit:100})).items.find(row=>row.namespace==='runtime-processed-outputs');
 await f.local.repositories.hostRecords.remove(journal.id,journal.revision);await f.restart();
 await assert.rejects(()=>f.retry(),/journal is missing/);assert.equal(f.calls,1);assert.equal(f.writes,2);assert.notEqual((await f.local.repositories.assets.get('asset')).status,'ready');
});
test('a cancelled or changed asset is fenced after decoding and before output storage',async t=>{
 let resume,started;const waiting=new Promise(resolve=>{started=resolve;}),pause=new Promise(resolve=>{resume=resolve;});
 const f=await fixture(t,async input=>{started();await pause;return result([output(input,'audio','encoded')]);});
 const processing=f.runtime.runNextJob('worker');await waiting;const asset=await f.local.repositories.assets.get('asset');
 await f.local.repositories.assets.update(asset.id,asset.revision,{status:'deleted'});resume();
 await assert.rejects(()=>processing,/no longer current/);assert.equal(f.writes,0);assert.equal((await f.local.repositories.assets.get('asset')).status,'deleted');
});
test('multiple previews preserve the full source delivery unless a primary is explicitly selected',async t=>{
 const f=await fixture(t,input=>result([output(input,'small','small'),output(input,'large','large')]));await f.runtime.runNextJob('worker');
 const asset=await f.local.repositories.assets.get('asset');assert.equal(asset.deliveryMimeType,'audio/wav');assert.equal(f.writes,3);
 assert.deepEqual(Array.from((await f.local.storage.get(asset.storage)).body),Array.from(f.source));
 assert.ok(asset.processedRenditions.every(value=>value.storage.scope==='private'));
});
for(const seconds of [60,180])test(`bounded native processing uses the configured ${seconds}-second lease`,async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.now()});
 const f=await fixture(t,input=>{t.mock.timers.tick(65_000);return result([output(input,'audio','encoded')]);},{processingLeaseSeconds:seconds});
 if(seconds===60){await assert.rejects(()=>f.runtime.runNextJob('worker'),/no longer current|lease is no longer valid/);assert.equal(f.writes,0);}
 else{await f.runtime.runNextJob('worker');assert.equal((await f.local.repositories.assets.get('asset')).status,'ready');assert.equal(f.writes,1);}
});
test('invalid processing leases reject before constructing a local database',()=>{
 for(const value of [0,29,901,1.5,NaN,Infinity,'180'])assert.throws(()=>createCoreRuntime({publicBaseUrl:'http://localhost',processingLeaseSeconds:value}),/Processing leases/);
});
