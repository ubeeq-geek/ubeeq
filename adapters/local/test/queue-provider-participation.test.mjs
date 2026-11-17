import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {setImmediate as turn} from 'node:timers/promises';
import {createLocalAdapterSet} from '../dist/index.js';
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
async function fixture(t){
 const directory=await mkdtemp(join(tmpdir(),'queue-provider-participant-')),local=createLocalAdapterSet({databasePath:join(directory,'core.sqlite'),dataDirectory:directory,cellId:'cell',publicBaseUrl:'http://127.0.0.1'}),pending=[],releases=[];
 t.after(async()=>{for(const release of releases)release();await Promise.allSettled(pending);local.database.close();await rm(directory,{recursive:true,force:true});});const track=promise=>{pending.push(promise);void promise.catch(()=>{});return promise;};
 async function hold(){const body=Buffer.from('Actual provider writer '+randomUUID()),checksum=createHash('sha256').update(body).digest('hex'),upload=await local.storage.initiate({object:{bucket:'cell',key:'cells/cell/creators/creator/uploads/queue-'+randomUUID(),scope:'private',contentType:'application/octet-stream',byteLength:body.byteLength,checksum},checksumAlgorithm:'sha256',expiresAt:new Date(Date.now()+60_000).toISOString()}),scope={uploadId:upload.uploadId,cellId:'cell',creatorId:'creator'};await local.storage.accept({...scope,operation:'upload_content',body});const custody=local.storage.uploadCustody,real=custody.syncDirectory.bind(custody),entered=deferred(),release=deferred();let armed=true;t.mock.method(custody,'syncDirectory',async path=>{const result=await real(path);if(armed&&path.includes(upload.object.key)){armed=false;entered.resolve();await release.promise;}return result;});releases.push(release.resolve);const completing=track(local.storage.complete({...scope,checksum,byteLength:body.byteLength}));await entered.promise;return {release,completing};}
 return {local,track,hold};
}
async function waits(promise){let settled=false;void promise.then(()=>{settled=true;},()=>{settled=true;});await turn();assert.equal(settled,false,'real async queue operation waits behind the actual provider writer');}
test('actual async enqueue/get/list wait behind provider fsync and retain one idempotent job while raw synchronous access still rejects',{timeout:30000},async t=>{
 const f=await fixture(t),queue=f.local.jobs,seed=await queue.enqueue({cellId:'cell',type:'seed',payload:{actual:true},idempotencyKey:'seed',maxAttempts:2}),hold=await f.hold(),input={cellId:'cell',type:'shared-content',payload:{assetId:'actual-asset'},idempotencyKey:'one-shared-job',maxAttempts:3};
 const first=f.track(queue.enqueue(input)),second=f.track(queue.enqueue(input)),get=f.track(queue.get(seed.id)),list=f.track(queue.list({cellId:'cell',limit:20}));await waits(Promise.all([first,second,get,list]));assert.throws(()=>queue.enqueueSync({...input,idempotencyKey:'forbidden-nonparticipant'}),/owned by another transaction/);
 hold.release.resolve();await hold.completing;const [a,b,found,listed]=await Promise.all([first,second,get,list]);assert.equal(a.id,b.id);assert.equal(found.id,seed.id);assert.ok(listed.some(job=>job.id===seed.id));assert.equal((await queue.list({cellId:'cell',limit:20})).filter(job=>job.idempotencyKey===input.idempotencyKey).length,1);
});
test('queued Local transitions retain real lease/CAS states and explicit enqueueSync remains atomic with its caller',{timeout:30000},async t=>{
 const f=await fixture(t),queue=f.local.jobs,job=await queue.enqueue({cellId:'cell',type:'transition',payload:{actual:true},idempotencyKey:'transition',maxAttempts:3});
 const behind=async operation=>{const hold=await f.hold(),pending=f.track(operation());await waits(pending);hold.release.resolve();await hold.completing;return pending;};
 const lease=await behind(()=>queue.lease({cellId:'cell',types:['transition'],leaseDurationSeconds:60,workerId:'actual-worker'}));assert.equal(lease.job.id,job.id);assert.equal(lease.job.attempt,1);
 await behind(()=>queue.retry({id:job.id,leaseToken:lease.leaseToken,error:{code:'actual-retry',message:'Actual retry'},retryAt:new Date(Date.now()-1000).toISOString()}));assert.equal((await queue.get(job.id)).state,'retry_scheduled');
 await behind(()=>queue.recover({id:job.id}));const next=await queue.lease({cellId:'cell',types:['transition'],leaseDurationSeconds:60,workerId:'actual-worker'});await assert.rejects(queue.complete({id:job.id,leaseToken:lease.leaseToken}),/no longer valid/);await behind(()=>queue.deadLetter({id:job.id,leaseToken:next.leaseToken,error:{code:'actual-stop',message:'Actual stop'}}));assert.equal((await queue.get(job.id)).state,'dead_lettered');
 await queue.recover({id:job.id});const final=await queue.lease({cellId:'cell',types:['transition'],leaseDurationSeconds:60,workerId:'actual-worker'});await behind(()=>queue.complete({id:job.id,leaseToken:final.leaseToken}));assert.equal((await queue.get(job.id)).state,'completed');
 await behind(()=>queue.schedule({cellId:'cell',type:'scheduled',payload:{actual:true},idempotencyKey:'schedule',runAt:new Date().toISOString()}));await behind(()=>queue.cancelSchedule({cellId:'cell',idempotencyKey:'schedule'}));const scheduled=(await queue.list({cellId:'cell',limit:20})).find(row=>row.idempotencyKey==='schedule');assert.equal(scheduled.state,'cancelled');
 const cancel=await queue.enqueue({cellId:'cell',type:'cancel',payload:{actual:true},idempotencyKey:'cancel',maxAttempts:1});await behind(()=>queue.cancel({id:cancel.id,reason:'Actual cancellation'}));assert.equal((await queue.get(cancel.id)).state,'cancelled');
 let uncommitted;await assert.rejects(f.local.repositories.transaction(async()=>{uncommitted=queue.enqueueSync({cellId:'cell',type:'atomic',payload:{actual:true},idempotencyKey:'rolled-back',maxAttempts:1});throw Error('actual caller rollback');}),/actual caller rollback/);assert.equal(await queue.get(uncommitted.id),undefined);const committed=await f.local.repositories.transaction(async()=>queue.enqueueSync({cellId:'cell',type:'atomic',payload:{actual:true},idempotencyKey:'committed',maxAttempts:1}));assert.equal((await queue.get(committed.id)).id,committed.id);
});
