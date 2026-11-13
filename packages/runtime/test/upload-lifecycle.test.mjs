import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createLocalAdapterSet } from '@ubeeq/adapter-local';
import { createCoreRuntime } from '../dist/index.js';
import {createDefaultOpenCorePorts,createSingleOperatorTenancyPort} from '@ubeeq/extension-sdk';
async function fixture(t,quota) {
 const directory=await mkdtemp(join(tmpdir(),'durable-upload-'));
 const config={databasePath:join(directory,'data.sqlite'),dataDirectory:directory,cellId:'cell',publicBaseUrl:'http://127.0.0.1'};
 let local,runtime,providerCalls=0,processCalls=0,loseReply=false,failAsset=false,queueUnavailable=false,verifyCommitted=false;
 const start=async()=>{
  local=createLocalAdapterSet(config);
  const complete=local.storage.complete.bind(local.storage),create=local.repositories.assets.create.bind(local.repositories.assets),enqueue=local.jobs.enqueue.bind(local.jobs);
  local.storage.complete=async input=>{providerCalls++;const object=await complete(input);if(loseReply){loseReply=false;throw Error('Lost provider completion response');}return object;};
  local.repositories.assets.create=async(...args)=>{if(failAsset){failAsset=false;throw Error('Asset commit unavailable');}return create(...args);};
  local.jobs.enqueue=async input=>{
   if(queueUnavailable)throw Error('Queue unavailable');
   if(verifyCommitted){const observer=createLocalAdapterSet(config);try{assert.ok(await observer.repositories.assets.get(input.payload.assetId),'queue dispatch must observe an already committed asset from another connection');}finally{observer.database.close();}}
   return enqueue(input);
  };
  const creators=async()=>(await local.repositories.creators.list({limit:100})).items;
  runtime=createCoreRuntime({instanceId:'instance',...config,adapters:{repositories:local.repositories,storage:local.storage,uploads:local.storage,delivery:local.storage,jobs:local.jobs,identity:local.identity,localIdentity:local.identity},...(quota ? {requireUploadAccounting:true,hostPorts:createDefaultOpenCorePorts({usageQuota:quota,tenancyAndAccess:createSingleOperatorTenancyPort({getOperatorUserId:async()=>(await creators())[0]?.subjectId??null,listOperatorCreatorIds:async actor=>(await creators()).filter(c=>c.subjectId===actor).map(c=>c.id)})})} : {}),mediaProcessor:{async process(){processCalls++;return {metadata:{processed:true},renditions:[],measuredUnits:1};}}});
  await new Promise(resolve=>runtime.server.listen(0,'127.0.0.1',resolve));
 };
 const stop=async()=>{await runtime.close();local.database.close();};await start();
 t.after(async()=>{await stop();await rm(directory,{recursive:true,force:true});});
 await local.identity.register({email:'operator@example.test',password:'Synthetic upload password 123!'});
 const {token}=await local.identity.authenticate({email:'operator@example.test',password:'Synthetic upload password 123!'});
 const request=async(path,body,method=body?'POST':'GET')=>{
  const response=await fetch(`http://127.0.0.1:${runtime.server.address().port}${path}`,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  return {status:response.status,body:response.status===204?null:await response.json()};
 };
 const creator=(await request('/v1/creators',{handle:'creator',displayName:'Creator'})).body.creator;
 const work=(await request('/v1/works',{creatorId:creator.id,title:'Upload Work'})).body.work;
 const bytes=Buffer.from('Synthetic immutable upload source'),checksum=createHash('sha256').update(bytes).digest('hex');
 const init={workId:work.id,mimeType:'text/plain',byteLength:bytes.length,checksum,idempotencyKey:'file-request'};
 const upload=async()=>{const result=await request('/v1/uploads',init);assert.equal(result.status,201);return result.body.upload;};
 const content=upload=>request(`/v1/uploads/${upload.uploadId}/content`,{base64:bytes.toString('base64')},'PUT');
 const finish=(upload,patch={})=>request(`/v1/uploads/${upload.uploadId}/complete`,{workId:work.id,checksum,byteLength:bytes.length,...patch});
 return {request,work,creator,init,upload,content,finish,get local(){return local;},get runtime(){return runtime;},get providerCalls(){return providerCalls;},get processCalls(){return processCalls;},loseReply(){loseReply=true;},failAsset(){failAsset=true;},queueUnavailable(v){queueUnavailable=v;},verifyCommitted(){verifyCommitted=true;},async restart(){await stop();await start();}};
}
test('owned upload initiation and completion replay after restart retain one provider version, asset and job',async t=>{
 const f=await fixture(t),upload=await f.upload();
 assert.equal((await f.upload()).uploadId,upload.uploadId);
 assert.equal(f.local.database.database.prepare('SELECT COUNT(*) AS n FROM ubeeq_uploads').get().n,1);
 assert.equal((await f.content(upload)).status,204);f.loseReply();f.verifyCommitted();
 const first=await f.finish(upload);assert.equal(first.status,202);assert.ok(first.body.job.id);assert.equal(first.body.queuePending,false);assert.equal(first.body.job.correlationId,first.body.requestId);
 await f.restart();const again=await f.finish(upload);assert.equal(again.status,202);assert.equal(again.body.asset.id,first.body.asset.id);assert.equal(again.body.asset.objectVersion,first.body.asset.objectVersion);assert.equal(again.body.job.id,first.body.job.id);assert.equal(again.body.job.correlationId,first.body.requestId);assert.equal(f.providerCalls,1);
 assert.equal((await f.local.repositories.assets.list({limit:100})).items.length,1);
 const audits=(await f.local.repositories.auditEvents.list({limit:100})).items.filter(r=>r.action==='asset.upload_completed');assert.equal(audits.length,1);
});

test('the HTTP upload use site reserves storage before issuing a provider session and settles its physical write time',async t=>{
 const calls=[];const quota={async checkAndReserveQuota(input){calls.push(['reserve',input]);return {allowed:true};},async recordUsageSettlement(input){calls.push(['settle',input]);},async closeStorageReservation(input){calls.push(['close',input]);}};
 const f=await fixture(t,quota),upload=await f.upload();
 assert.equal(calls[0][0],'reserve');assert.equal(calls[0][1].storageBytesDelta,f.init.byteLength);assert.equal(calls[0][1].processingCreditsDelta,undefined);
 await f.content(upload);const completed=await f.finish(upload);assert.equal(completed.status,202);
 const settlement=calls.find(([kind])=>kind==='settle')[1];assert.equal(settlement.storageBytesDelta,f.init.byteLength);assert.equal(settlement.observedAt,completed.body.asset.storage.writtenAt);
 assert.equal(settlement.idempotencyKey,calls[0][1].idempotencyKey);assert.equal(settlement.operation,'upload.original');
});

test('a current admission denial after reserve closes the unused grant before any provider session is issued',async t=>{
 const closed=[];const quota={async checkAndReserveQuota(){return {allowed:true};},async checkCurrentAdmission(){return {allowed:false,reasonCode:'ACCOUNT_SUSPENDED'};},async recordUsageSettlement(){throw Error('No physical body was accepted');},async closeStorageReservation(input){closed.push(input);}};
 const f=await fixture(t,quota),result=await f.request('/v1/uploads',f.init);
 assert.equal(result.status,403);assert.equal(result.body.error.code,'ACCOUNT_SUSPENDED');
 assert.equal(f.local.database.database.prepare('SELECT COUNT(*) AS n FROM ubeeq_uploads').get().n,0);
 assert.equal(closed.length,1);assert.equal(closed[0].reservedBytes,f.init.byteLength);
 const journal=(await f.local.repositories.hostRecords.list({limit:100})).items.find(row=>row.namespace==='runtime-upload');
 assert.equal(journal.value.phase,'sealed');assert.equal(journal.value.provider,undefined);
});

test('expired unused uploads persist their closure proof and outbox before releasing the reservation',async t=>{
 const closes=[];const quota={async checkAndReserveQuota(){return {allowed:true};},async recordUsageSettlement(){throw Error('No physical body should be charged');},async closeStorageReservation(input){closes.push(input);}};
 const f=await fixture(t,quota),upload=await f.upload();
 const row=(await f.local.repositories.hostRecords.list({limit:100})).items.find(r=>r.namespace==='runtime-upload');
 await f.local.repositories.hostRecords.update(row.id,row.revision,{value:{...row.value,expiresAt:'2000-01-01T00:00:00.000Z'}});
 await f.runtime.runNextJob('sealer');const saved=await f.local.repositories.hostRecords.get(row.id);
 assert.equal(saved.value.phase,'sealed');assert.ok(saved.value.closureIntentId);assert.equal(closes[0].proofId,saved.value.seal.proofId);
 assert.equal(closes[0].reservedBytes,f.init.byteLength);assert.equal((await f.content(upload)).body.error.code,'upload_closed');
 assert.equal((await f.request('/v1/uploads',f.init)).body.error.code,'upload_closed');
});

test('required upload accounting rejects an adapter without physical closure before serving requests',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'upload-required-')),local=createLocalAdapterSet({databasePath:join(directory,'data.sqlite'),dataDirectory:directory,cellId:'cell',publicBaseUrl:'http://localhost'});
 t.after(async()=>{local.database.close();await rm(directory,{recursive:true,force:true});});
 local.storage.seal=undefined;
 assert.throws(()=>createCoreRuntime({instanceId:'instance',cellId:'cell',publicBaseUrl:'http://localhost',requireUploadAccounting:true,adapters:{repositories:local.repositories,storage:local.storage,uploads:local.storage,delivery:local.storage,jobs:local.jobs,identity:local.identity,localIdentity:local.identity}}),/Physical upload closure/);
});
test('failed asset transaction recovers the already written original without consuming the upload twice',async t=>{
 const f=await fixture(t),upload=await f.upload();await f.content(upload);f.failAsset();
 assert.equal((await f.finish(upload)).status,500);assert.equal((await f.local.repositories.assets.list({limit:100})).items.length,0);
 await f.restart();const recovered=await f.finish(upload);assert.equal(recovered.status,202);assert.equal(f.providerCalls,1);assert.ok(recovered.body.asset.storage.versionId);
 assert.equal((await f.local.repositories.assets.list({limit:100})).items.length,1);
});
test('queue outage commits a recoverable upload intent and restart repairs it before processing once',async t=>{
 const f=await fixture(t),upload=await f.upload();await f.content(upload);f.queueUnavailable(true);
 const accepted=await f.finish(upload);assert.equal(accepted.status,202);assert.equal(accepted.body.job,null);assert.equal(accepted.body.queuePending,true);
 assert.equal((await f.local.repositories.assets.get(accepted.body.asset.id)).status,'pending');
 f.queueUnavailable(false);f.verifyCommitted();await f.restart();await f.runtime.runNextJob('recovered-worker');await f.runtime.runNextJob('idle-worker');
 assert.equal((await f.local.repositories.assets.get(accepted.body.asset.id)).status,'ready');assert.equal(f.processCalls,1);
 const repeated=await f.finish(upload);assert.equal(repeated.body.asset.id,accepted.body.asset.id);assert.equal(repeated.body.queuePending,false);assert.equal(repeated.body.job.correlationId,accepted.body.requestId);
});
test('changed initiation/completion and a different Work cannot retarget an owned upload',async t=>{
 const f=await fixture(t),upload=await f.upload();await f.content(upload);
 assert.equal((await f.request('/v1/uploads',{...f.init,byteLength:1})).status,409);
 const other=(await f.request('/v1/works',{creatorId:f.creator.id,title:'Other Work'})).body.work;
 assert.equal((await f.finish(upload,{workId:other.id})).status,409);
 assert.equal((await f.finish(upload,{byteLength:1})).status,409);assert.equal(f.providerCalls,0);
 const providerId=f.local.database.database.prepare('SELECT id FROM ubeeq_uploads').get().id;assert.notEqual(providerId,upload.uploadId);
 assert.equal((await f.finish({uploadId:providerId})).status,404);assert.equal(f.providerCalls,0);
 assert.equal((await f.finish(upload)).status,202);
 assert.equal((await f.finish(upload,{checksum:'0'.repeat(64)})).status,409);
});
test('concurrent completion requests commit one asset and return the same processing job',async t=>{
 const f=await fixture(t),upload=await f.upload();await f.content(upload);
 const results=await Promise.all([f.finish(upload),f.finish(upload)]);
 assert.deepEqual(results.map(r=>r.status),[202,202]);assert.equal(results[0].body.asset.id,results[1].body.asset.id);assert.equal(results[0].body.job.id,results[1].body.job.id);
 assert.equal((await f.local.repositories.assets.list({limit:100})).items.length,1);
});

test('provider-neutral receipt hashes survive unordered document-store map fields',async t=>{
 const f=await fixture(t),get=f.local.repositories.hostRecords.get.bind(f.local.repositories.hostRecords);
 f.local.repositories.hostRecords.get=async(...args)=>{
  const row=await get(...args); if(!row || row.namespace!=='runtime-upload')return row;
  const value={...row.value};
  for(const key of ['expected','completion'])if(value[key])value[key]=Object.fromEntries(Object.entries(value[key]).reverse());
  return {...row,value};
 };
 const upload=await f.upload();await f.content(upload);const result=await f.finish(upload);assert.equal(result.status,202);
 assert.equal((await f.finish(upload)).body.asset.id,result.body.asset.id);
});

test('premature completion does not prevent the matching content from arriving later',async t=>{
 const f=await fixture(t),upload=await f.upload();
 assert.equal((await f.finish(upload)).status,500);
 assert.equal((await f.content(upload)).status,204);
 const result=await f.finish(upload);assert.equal(result.status,202);
 assert.equal((await f.local.repositories.assets.list({limit:100})).items.length,1);
});
test('completed initiation and content retries reuse the existing object without another provider write',async t=>{
 const f=await fixture(t),upload=await f.upload();assert.equal(upload.completed,false);await f.content(upload);
 const first=await f.finish(upload),replayed=await f.upload();assert.equal(replayed.completed,true);
 assert.equal((await f.content(replayed)).status,204);
 const bad=await f.request(`/v1/uploads/${upload.uploadId}/content`,{base64:Buffer.from('wrong').toString('base64')},'PUT');assert.equal(bad.status,400);
 const repeated=await f.finish(replayed);assert.equal(repeated.body.asset.id,first.body.asset.id);assert.equal(f.providerCalls,1);
});
