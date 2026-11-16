// AUTHORED UNRUN. Real Local SQL queue, actual owned versions and filesystem
// bytes; quota is an explicit idempotent unit protocol, not cloud acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {setImmediate} from 'node:timers/promises';
import {createLocalAdapterSet} from '@ubeeq/adapter-local';
import {OwnedObjectWrites} from '../dist/owned-object-writes.js';
import {OwnedWebsiteBlobs} from '../dist/owned-website-blobs.js';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const gate=()=>{let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve};};
const home={homeCellId:'cell',dataHomeRegion:'local',dataHomeAssignedAt:'2026-01-01T00:00:00.000Z',routingRevision:1};
async function fixture(t){
 const directory=await mkdtemp(join(tmpdir(),'owned-metadata-scopes-')),local=createLocalAdapterSet({databasePath:join(directory,'runtime.sqlite'),dataDirectory:directory,cellId:'cell',publicBaseUrl:'http://localhost'}),grants=new Map(),settlements=new Map(),closures=new Map();
 const quota={async checkAndReserveQuota(input){const old=grants.get(input.idempotencyKey);if(old)assert.deepEqual(old,input);grants.set(input.idempotencyKey,structuredClone(input));return{allowed:true};},async recordUsageSettlement(input){const old=settlements.get(input.idempotencyKey);if(old)assert.deepEqual(old,input);settlements.set(input.idempotencyKey,structuredClone(input));},async closeStorageReservation(input){const old=closures.get(input.idempotencyKey);if(old)assert.deepEqual(old,input);closures.set(input.idempotencyKey,structuredClone(input));}};
 const actor=await local.identity.register({email:'owned-metadata@unit.test',password:'Synthetic actual Local password 123!'});
 await local.repositories.creators.create({id:'creator',instanceId:'instance',...home,subjectId:actor.subjectId,displayName:'Actual storage unit owner',handle:'owned-metadata'});
 const writer=new OwnedObjectWrites(local.repositories,local.storage,quota,'instance','cell'),blobs=new OwnedWebsiteBlobs(local.repositories,writer,local.storage,'instance','cell','cell'),body=Buffer.from('Actual immutable website source bytes'),input={creatorId:'creator',operation:'unit.actual-derivative',idempotencyKey:'actual-output',home,bucket:'cell',kind:'renditions',scope:'private',contentType:'application/octet-stream',body,metadata:{source:'actual-local-bytes'}};
 t.after(async()=>{local.database.close();await rm(directory,{recursive:true,force:true});});return{local,quota,grants,settlements,closures,writer,blobs,body,input};
}
async function independentHolder(local){const entered=gate(),release=gate(),pending=local.repositories.transaction(async()=>{entered.resolve();await release.promise;});await entered.promise;return{release,pending};}
async function waitsForHolder(pending,holder){let settled=false;const observed=pending.then(value=>{settled=true;return value;},error=>{settled=true;throw error;});observed.catch(()=>{});try{await setImmediate();assert.equal(settled,false,'independent metadata cannot acknowledge or reject through another owner');}finally{holder.release.resolve();await holder.pending;}return observed;}

test('parallel website reads and owned receipt recovery wait for a real independent Local writer',async t=>{
 const f=await fixture(t),checksum=hash(f.body);await f.blobs.put('creator',checksum,f.body);const receipt=await f.writer.recover({creatorId:'creator',operation:'website.blob',idempotencyKey:checksum+':0'}),holder=await independentHolder(f.local);
 const pending=Promise.all([f.blobs.get('creator',checksum),f.blobs.getRange('creator',checksum,0,7),f.writer.recover({creatorId:'creator',operation:'website.blob',idempotencyKey:checksum+':0'})]);
 const [body,range,recovered]=await waitsForHolder(pending,holder);assert.deepEqual(Buffer.from(body),f.body);assert.deepEqual(Buffer.from(range),f.body.subarray(0,7));assert.deepEqual(recovered,receipt);assert.equal(f.settlements.size,1);
});

test('website physical byte IO holds no new repository read transaction',async t=>{
 const f=await fixture(t),checksum=hash(f.body);await f.blobs.put('creator',checksum,f.body);const entered=gate(),release=gate(),get=f.local.storage.get.bind(f.local.storage);let held=false;
 f.local.storage.get=async input=>{if(!held){held=true;entered.resolve();await release.promise;}return get(input);};
 const reading=f.blobs.get('creator',checksum);await entered.promise;
 let committed=false;const writing=f.local.repositories.transaction(async transaction=>{await f.local.repositories.hostRecords.create({id:'independent-real-metadata',instanceId:'instance',...home,namespace:'unit-metadata',scopeId:'creator',key:'independent',value:{actual:true}},{transaction});committed=true;});
 try{await setImmediate();assert.equal(committed,true,'the metadata writer can commit while actual physical IO is explicitly paused');}finally{release.resolve();}
 await writing;assert.deepEqual(Buffer.from(await reading),f.body);
});

test('an actual issued upload capability may return during another SQL writer and its owned metadata continuation queues',async t=>{
 const f=await fixture(t),issued=gate(),resume=gate(),initiate=f.local.storage.initiate.bind(f.local.storage);
 f.local.storage.initiate=async input=>{const result=await initiate(input);issued.resolve();await resume.promise;return result;};
 const output=f.writer.write(f.input);await issued.promise;const holder=await independentHolder(f.local);resume.resolve();const saved=await waitsForHolder(output,holder);
 assert.equal(saved.object.checksum,hash(f.body));assert.deepEqual(Buffer.from((await f.local.storage.get(saved.object)).body),f.body);assert.equal(f.settlements.size,1);
});

test('a genuine empty-upload seal drains quota outside SQL and queues the later closure metadata write',async t=>{
 const f=await fixture(t),accept=f.local.storage.accept.bind(f.local.storage);f.local.storage.accept=async()=>{throw Error('Unit fault before any actual body acceptance');};
 await assert.rejects(f.writer.write(f.input),/before any actual body/);f.local.storage.accept=accept;
 const closing=gate(),resume=gate(),close=f.quota.closeStorageReservation.bind(f.quota);f.quota.closeStorageReservation=async input=>{await close(input);closing.resolve();await resume.promise;};
 const recovered=f.writer.recover(f.input);await closing.promise;const holder=await independentHolder(f.local);resume.resolve();assert.equal(await waitsForHolder(recovered,holder),undefined);assert.equal(f.closures.size,1);
 const rows=(await f.local.repositories.hostRecords.list({limit:100})).items,original=rows.find(row=>row.namespace==='runtime-owned-object'),closure=rows.find(row=>row.namespace==='runtime-storage-closure');assert.equal(original.value.phase,'sealed');assert.equal(closure.value.state,'closed');assert.ok(original.value.seal.proofId);
});
