import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {setImmediate as turn} from 'node:timers/promises';
import {createLocalAdapterSet} from '@ubeeq/adapter-local';
import {UploadLifecycle} from '../dist/upload-lifecycle.js';
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
async function fixture(t){
 const directory=await mkdtemp(join(tmpdir(),'upload-participating-records-')),local=createLocalAdapterSet({databasePath:join(directory,'core.sqlite'),dataDirectory:directory,cellId:'cell',publicBaseUrl:'http://127.0.0.1'}),pending=[],releases=[];
 t.after(async()=>{for(const release of releases)release();await Promise.allSettled(pending);local.database.close();await rm(directory,{recursive:true,force:true});});
 const home={homeCellId:'cell',dataHomeRegion:'local',dataHomeAssignedAt:new Date().toISOString(),routingRevision:1};
 await local.repositories.creators.create({id:'creator',instanceId:'instance',subjectId:'owner',handle:'actual-creator',displayName:'Actual Creator',...home});const work=await local.repositories.works.create({id:'work',instanceId:'instance',creatorId:'creator',title:'Actual upload Work',status:'draft',...home});
 const lifecycle=new UploadLifecycle(local.repositories,local.storage,local.jobs,'instance','cell','http://127.0.0.1'),body=Buffer.from('Actual participating upload original '+randomUUID()),checksum=createHash('sha256').update(body).digest('hex'),expected={mimeType:'application/octet-stream',byteLength:body.byteLength,checksum},issued=await lifecycle.initiate(work,'owner',expected,'original-upload');await lifecycle.accept(issued.uploadId,'creator',body);
 // An independent genuine physical upload holds the same provider writer while
 // the lifecycle under test participates from another root async context.
 const object={bucket:'cell',key:'cells/cell/creators/creator/uploads/provider-holder-'+randomUUID(),scope:'private',contentType:'application/octet-stream',byteLength:body.byteLength,checksum},provider=await local.storage.initiate({object,checksumAlgorithm:'sha256',expiresAt:new Date(Date.now()+60_000).toISOString()});await local.storage.accept({uploadId:provider.uploadId,cellId:'cell',creatorId:'creator',operation:'upload_content',body});
 const tracked=promise=>{pending.push(promise);void promise.catch(()=>{});return promise;};
 const holdProvider=async()=>{
  // Real fs directory synchronization occurs in the actual finalization writer.
  // Pause after it actually fsyncs; no successful receipt/effect is fabricated.
  const entered=deferred(),release=deferred();let armed=true;
  // Capture the actual custody instance through storage; TS private fields are
  // ordinary runtime properties, as in the accepted Local finalization tests.
  const custody=local.storage.uploadCustody,sync=custody.syncDirectory.bind(custody);
  t.mock.method(custody,'syncDirectory',async path=>{const result=await sync(path);if(armed&&path.includes(provider.object.key)){armed=false;entered.resolve();await release.promise;}return result;});
  releases.push(release.resolve);const completing=tracked(local.storage.complete({uploadId:provider.uploadId,cellId:'cell',creatorId:'creator',byteLength:body.byteLength,checksum}));await entered.promise;return {release,completing};
 };
 const row=()=>local.repositories.transaction(async transaction=>(await local.repositories.hostRecords.list({limit:100},{transaction})).items.find(row=>row.namespace==='runtime-upload'&&row.key===issued.uploadId));
 return {directory,local,work,lifecycle,body,checksum,expected,issued,holdProvider,tracked,row};
}
async function pendingBehindWriter(promise){let settled=false;void promise.then(()=>{settled=true;},()=>{settled=true;});await turn();assert.equal(settled,false,'the admitted repository operation waits for the actual provider writer');}
test('completion record read queues behind genuine provider filesystem finalization while nonparticipant raw access still rejects',{timeout:30000},async t=>{
 const f=await fixture(t),before=await f.row(),hold=await f.holdProvider(),completing=f.tracked(f.lifecycle.complete(f.issued.uploadId,f.work,'owner',{checksum:f.checksum,byteLength:f.body.byteLength}));
 await pendingBehindWriter(completing);await assert.rejects(f.local.repositories.hostRecords.get(before.id),/owned by another transaction/,'global unparticipating access remains forbidden');hold.release.resolve();await hold.completing;const result=await completing;
 assert.equal(result.asset.workId,f.work.id);assert.equal(result.asset.creatorId,'creator');assert.equal(result.asset.checksum,f.checksum);assert.ok(result.job.id);assert.equal(result.queuePending,false);assert.equal((await f.local.jobs.get(result.job.id)).payload.assetId,result.asset.id);assert.equal((await f.local.repositories.assets.list({limit:100})).items.length,1);
});
test('new initiation participates for its get/create/CAS receipt without carrying Raw across actual provider initiation',{timeout:30000},async t=>{
 const f=await fixture(t),original=f.local.storage.initiate.bind(f.local.storage);t.mock.method(f.local.storage,'initiate',async input=>{f.local.database.assertOutsideProviderTransaction();return original(input);});const hold=await f.holdProvider(),initiating=f.tracked(f.lifecycle.initiate(f.work,'owner',f.expected,'second-owned-upload'));
 await pendingBehindWriter(initiating);hold.release.resolve();await hold.completing;const result=await initiating;assert.equal(result.completed,false);assert.notEqual(result.uploadId,f.issued.uploadId);assert.equal((await f.lifecycle.initiate(f.work,'owner',f.expected,'second-owned-upload')).uploadId,result.uploadId);const rows=(await f.local.repositories.hostRecords.list({limit:100})).items.filter(row=>row.namespace==='runtime-upload');assert.equal(rows.length,2);assert.equal(rows.find(row=>row.key===result.uploadId).value.phase,'issued');
});
test('repair queues its real paginated scan then recovers the original failed queue acknowledgement with one genuine job',{timeout:30000},async t=>{
 const f=await fixture(t),real=f.local.jobs.enqueue.bind(f.local.jobs);let unavailable=true;t.mock.method(f.local.jobs,'enqueue',async input=>{if(unavailable)throw Error('Actual queue unavailable before acknowledgement');return real(input);});const original=await f.lifecycle.complete(f.issued.uploadId,f.work,'owner',{checksum:f.checksum,byteLength:f.body.byteLength});assert.equal(original.queuePending,true);assert.equal(original.job,null);assert.equal((await f.row()).value.queueState,'pending');unavailable=false;
 const hold=await f.holdProvider(),repairing=f.tracked(f.lifecycle.repair());await pendingBehindWriter(repairing);hold.release.resolve();await hold.completing;assert.equal(await repairing,1);const saved=await f.row();assert.equal(saved.value.queueState,'queued');const job=await f.local.jobs.get(saved.value.jobId);assert.equal(job.payload.assetId,original.asset.id);assert.equal(job.idempotencyKey,'asset-process:'+original.asset.id+':'+original.asset.objectVersion);assert.equal(await f.lifecycle.repair(),0);
});
test('queueing completion reads preserves the accepting current Work deletion guard and retains the exact physical original',{timeout:30000},async t=>{
 const f=await fixture(t),hold=await f.holdProvider(),completing=f.tracked(f.lifecycle.complete(f.issued.uploadId,f.work,'owner',{checksum:f.checksum,byteLength:f.body.byteLength})),denied=assert.rejects(completing,{code:'upload_work_unavailable',status:409});await pendingBehindWriter(completing);
 const deleting=f.tracked(f.local.repositories.transaction(transaction=>f.local.repositories.works.update(f.work.id,f.work.revision,{status:'deleted'},{transaction})));hold.release.resolve();await hold.completing;await deleting;await denied;assert.equal((await f.local.repositories.assets.list({limit:100})).items.length,0);const saved=await f.row(),physical=await f.local.storage.recoverCompletion({uploadId:saved.value.provider.uploadId,cellId:'cell',creatorId:'creator',checksum:f.checksum,byteLength:f.body.byteLength});assert.ok(physical);assert.equal(physical.checksum,f.checksum);assert.equal((await f.local.repositories.works.get(f.work.id)).status,'deleted');
});
