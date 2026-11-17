import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {retainedSourceHttpFixture} from './retained-source-http-fixture.mjs';
const bytes=Buffer.from('An actual retained original before any Work'),sha=createHash('sha256').update(bytes).digest('hex');
const input={creatorId:'creator',originalFilename:'Original.txt',mimeType:'text/plain',sizeBytes:bytes.length,checksumSha256:sha};
const begin=f=>f.request('/studio/files/uploads',{method:'POST',body:input});
const transfer=(f,upload)=>f.request(upload.uploadPath,{method:'PUT',body:bytes,headers:upload.requiredHeaders});
test('Core mounts actual retained original upload/list/download routes before Work creation and reopens exact streamed bytes',async t=>{
 const f=await retainedSourceHttpFixture(t),prepared=await begin(f);assert.equal(prepared.status,201,JSON.stringify(prepared.body));const file=prepared.body.file;assert.equal(file.checksumSha256,sha);assert.equal(file.uploadState,'pending');assert.match(file.storageKey,/originals\/instance-/);assert.equal((await transfer(f,prepared.body)).status,204);
 const completed=await f.request(`/studio/files/${file.fileId}/complete`,{method:'POST'});assert.equal(completed.status,200,JSON.stringify(completed.body));assert.equal(completed.body.uploadState,'ready');assert.equal(completed.body.metadata.verifiedOriginal,true);assert.deepEqual(completed.body.opaque,{retained:true});assert.equal(f.settlements.size,1);
 const object=await f.uploads.readPhysicalReceipt(file.fileId);assert.ok(object.versionId);await f.restart();const listed=await f.request('/api/studio/files?creatorId=creator');assert.equal(listed.body.length,1);assert.equal(listed.body[0].fileId,file.fileId);
 const downloaded=await f.request(`/studio/files/${file.fileId}/download`);assert.equal(downloaded.status,200);assert.deepEqual(downloaded.bytes,bytes);assert.match(downloaded.headers.get('content-disposition'),/Original.txt/);assert.deepEqual(await f.uploads.readPhysicalReceipt(file.fileId),object);assert.equal((await f.repositories.works.list({limit:100})).items.length,0);
});
test('verified identity, precommit checksum, fixed storage and current safety hold are required before source transfer',async t=>{
 const f=await retainedSourceHttpFixture(t);assert.equal((await f.request('/studio/files/uploads',{method:'POST',body:input,token:null})).status,401);assert.equal((await f.request('/studio/files/uploads',{method:'POST',body:input,token:f.buyerToken})).status,403);
 assert.equal((await f.request('/studio/files/uploads',{method:'POST',body:{...input,checksumSha256:undefined}})).status,400);assert.equal((await f.request('/studio/files/uploads',{method:'POST',body:{...input,bucket:'another'}})).status,400);assert.deepEqual((await f.request('/studio/files')).body,[]);
 const hold=await f.repositories.moderationHolds.create({id:'hold',instanceId:'instance',homeCellId:'cell',dataHomeRegion:f.scope.region,dataHomeAssignedAt:new Date().toISOString(),routingRevision:1,subjectType:'creator',subjectId:'creator',state:'active',reason:'review'});assert.equal((await begin(f)).status,423);await f.repositories.moderationHolds.update(hold.id,hold.revision,{state:'released'});assert.equal((await begin(f)).status,201);
});
test('workflow upload intent persists hash and full pending source transaction before issuing its actual capability',async t=>{
 const f=await retainedSourceHttpFixture(t),base='/studio/content',start=await f.request(base+'/workflows?creatorId=creator',{method:'POST',body:{operationId:'begin',entry:{intent:'new'}}});assert.equal(start.status,200,JSON.stringify(start.body));const draft=start.body;
 const staged=await f.request(base+`/workflows/${draft.id}/uploads?creatorId=creator`,{method:'POST',body:{operationId:'upload',expectedRevision:draft.revision,upload:input}});assert.equal(staged.status,200,JSON.stringify(staged.body));assert.equal(staged.body.upload.file.checksumSha256,sha);assert.equal(staged.body.draft.objects[0].sourceFileId,staged.body.upload.file.fileId);assert.equal((await f.repositories.works.list({limit:100})).items.length,0);
 assert.equal((await transfer(f,staged.body.upload)).status,204);assert.equal((await f.request(`/studio/files/${staged.body.upload.file.fileId}/complete`,{method:'POST'})).status,200);
 const done=await f.request(base+`/workflows/${draft.id}/objects/${staged.body.objectId}/complete?creatorId=creator`,{method:'POST',body:{operationId:'complete',expectedRevision:staged.body.draft.revision}});assert.equal(done.status,200,JSON.stringify(done.body));assert.equal(done.body.objects[0].checksum,sha);assert.equal(done.body.objects[0].state,'ready');assert.equal((await f.repositories.works.list({limit:100})).items.length,0);
});
test('wrong retry checksum cannot retarget pending bytes; cancellation seals or truthfully retains charged originals',async t=>{
 const f=await retainedSourceHttpFixture(t),prepared=await begin(f),id=prepared.body.file.fileId;
 assert.equal((await f.request(`/studio/files/${id}/upload-url`,{method:'POST',body:{...input,checksumSha256:'0'.repeat(64)}})).status,409);
 const cancelled=await f.request(`/studio/files/${id}/cancel`,{method:'POST',body:{expectedRevision:1}});assert.equal(cancelled.status,200);assert.equal(cancelled.body.cleanup,'sealed');assert.equal(f.closed.size,1);assert.equal((await transfer(f,prepared.body)).status,409);
 const second=await begin(f);assert.equal((await transfer(f,second.body)).status,204);const retained=await f.request(`/studio/files/${second.body.file.fileId}/cancel`,{method:'POST',body:{expectedRevision:1}});assert.equal(retained.body.cleanup,'retained');assert.equal(f.settlements.size,1);assert.equal((await f.request(`/studio/files/${second.body.file.fileId}/download`)).status,409);
});
test('failed actual finalization retains physical ownership and current-principal revocation prevents later source completion',async t=>{
 const f=await retainedSourceHttpFixture(t),prepared=await begin(f);await transfer(f,prepared.body);f.setFinalizerFailure(true);assert.equal((await f.request(`/studio/files/${prepared.body.file.fileId}/complete`,{method:'POST'})).status,503);assert.equal((await f.files.getSourceFileById(prepared.body.file.fileId)).uploadState,'pending');assert.equal(f.settlements.size,1);f.setFinalizerFailure(false);
 f.local.database.database.prepare('UPDATE ubeeq_accounts SET account_scope = ?, roles_json = ? WHERE id = ?').run('customer_account','["customer_account"]',f.account.subjectId);await f.restart();assert.equal((await f.request(`/studio/files/${prepared.body.file.fileId}/complete`,{method:'POST'})).status,401,'the token issued for the old account scope is invalid');const recovered=await f.uploads.recover(prepared.body.file.fileId);assert.equal(recovered.state,'retained');assert.equal(recovered.file.uploadState,'pending');
});

// This is real Core HTTP, authenticated with its actual Local password session.
// A separate Local repository writer advances a genuine snapshot's global root;
// the actual Source read guard, not a manufactured named error, must reject.
async function sourceHttpPreflightRace(t,f,fileId,{fileRead=1,limit=1,always=false,transition}={}){
 const {createLocalAdapterSet}=await import('@ubeeq/adapter-local');
 const independent=createLocalAdapterSet({...f.local.database.configuration});let opened=true;
 const closeIndependent=()=>{if(opened){opened=false;independent.database.close();}},close=f.local.database.close.bind(f.local.database);
 f.local.database.close=()=>{closeIndependent();return close();};t.after(closeIndependent);
 const creator=await f.repositories.creators.get(f.scope.creatorId),home={homeCellId:creator.homeCellId,dataHomeRegion:creator.dataHomeRegion,dataHomeAssignedAt:creator.dataHomeAssignedAt,routingRevision:creator.routingRevision};
 const probe=await independent.repositories.hostRecords.create({id:'http-preflight-observation',instanceId:f.scope.instanceId,...home,namespace:'test-source-http-preflight',scopeId:f.account.subjectId,key:'observation',value:{fileId,observations:0,opaque:{preserved:['future',17]}}});
 const get=f.files.getSourceFileById.bind(f.files),snapshot=f.repositories.hostRecords.snapshot.bind(f.repositories.hostRecords),complete=f.uploads.complete.bind(f.uploads),verify=f.local.identity.verifySession.bind(f.local.identity),physicalComplete=f.local.storage.complete.bind(f.local.storage);
 let reads=0,depth=0,target=false,classStarted=false,collisions=0,classCalls=0,authentications=0,physicalCompletions=0;const options=[];
 t.mock.method(f.files,'getSourceFileById',async(...args)=>{if(depth)return get(...args);depth++;const prior=target;target=!classStarted&&(always||++reads===fileRead);try{return await get(...args);}finally{target=prior;depth--;}});
 t.mock.method(f.repositories.hostRecords,'snapshot',async()=>{const actual=await snapshot();if(target&&collisions<limit){const number=++collisions,current=await independent.repositories.hostRecords.get(probe.id);await independent.repositories.hostRecords.update(current.id,current.revision,{value:{...current.value,observations:number}});await transition?.({independent,number});}return actual;});
 t.mock.method(f.uploads,'complete',async(...args)=>{classStarted=true;classCalls++;options.push(args[1]);return complete(...args);});
 t.mock.method(f.local.identity,'verifySession',async(...args)=>{authentications++;return verify(...args);});
 t.mock.method(f.local.storage,'complete',async(...args)=>{physicalCompletions++;return physicalComplete(...args);});
 return {independent,options,get collisions(){return collisions;},get reads(){return reads;},get classCalls(){return classCalls;},get authentications(){return authentications;},get physicalCompletions(){return physicalCompletions;},disarm(){target=false;classStarted=true;}};
}
function httpCurrentOriginalPolicy(f,decision=()=>true){
 f.quota.checkCurrentPolicy=async value=>{assert.equal(value.creatorId,f.scope.creatorId);assert.equal(value.operation,'upload.original');const allowed=decision();return {allowed,...(allowed?{}:{reasonCode:'HTTP_CURRENT_ORIGINAL_POLICY_DENIED'})};};
}
async function assertHttpOriginalFact(f,prepared,response){
 assert.equal(response.status,200,JSON.stringify(response.body));assert.equal(response.body.fileId,prepared.body.file.fileId);assert.equal(response.body.uploadState,'ready');assert.equal(response.body.checksumSha256,sha);assert.equal(response.body.metadata.verifiedOriginal,true);assert.deepEqual(response.body.opaque,{retained:true});
 assert.equal(f.reservations.size,1);assert.equal(f.settlements.size,1);assert.equal(f.closed.size,0);assert.equal((await f.repositories.auditEvents.list({limit:100})).items.filter(row=>row.action==='source_file.upload.completed').length,1);
 assert.equal(f.local.database.database.prepare("SELECT COUNT(*) AS n FROM ubeeq_upload_completions WHERE state='completed'").get().n,1);const receipt=await f.uploads.readPhysicalReceipt(response.body.fileId);assert.ok(receipt.versionId);assert.equal(receipt.checksum,sha);assert.equal(receipt.byteLength,bytes.length);
 const [settled]=f.settlements.values();assert.equal(settled.operation,'upload.original');assert.equal(settled.storageBytesDelta,bytes.length);assert.equal(settled.observedAt,receipt.writtenAt);
 const downloaded=await f.request(`/studio/files/${response.body.fileId}/download`);assert.equal(downloaded.status,200);assert.deepEqual(downloaded.bytes,bytes);return receipt;
}

for(const [phase,fileRead]of [['resolve',1],['file-read',2]])test(`COMPLETE HTTP recaptures a real ${phase} snapshot conflict once before exactly one class/physical/audit/charge path`,async t=>{
 const f=await retainedSourceHttpFixture(t),prepared=await begin(f);assert.equal(prepared.status,201);assert.equal((await transfer(f,prepared.body)).status,204);httpCurrentOriginalPolicy(f);const race=await sourceHttpPreflightRace(t,f,prepared.body.file.fileId,{fileRead});
 const response=await f.request(`/studio/files/${prepared.body.file.fileId}/complete`,{method:'POST',body:{}});assert.equal(race.collisions,1);assert.equal(race.classCalls,1);assert.equal(race.authentications,1,'Authentication remains outside the metadata retry loop.');assert.equal(race.physicalCompletions,1);assert.equal(race.options[0]?.requireCurrentPolicy,true);race.disarm();
 const object=await assertHttpOriginalFact(f,prepared,response);await f.restart();assert.deepEqual(await f.uploads.readPhysicalReceipt(response.body.fileId),object);assert.equal(f.settlements.size,1);assert.equal((await f.repositories.auditEvents.list({limit:100})).items.filter(row=>row.action==='source_file.upload.completed').length,1);
});

for(const policy of ['denied','absent'])test(`an observed HTTP preflight conflict requires real original policy ${policy} even on the first class attempt, regardless of JSON flags`,async t=>{
 const f=await retainedSourceHttpFixture(t),prepared=await begin(f);assert.equal((await transfer(f,prepared.body)).status,204);if(policy==='denied')httpCurrentOriginalPolicy(f,()=>false);const race=await sourceHttpPreflightRace(t,f,prepared.body.file.fileId);
 const response=await f.request(`/studio/files/${prepared.body.file.fileId}/complete`,{method:'POST',body:{requireCurrentPolicy:false,recovery:{requireCurrentPolicy:false},actorId:'not-the-real-session',fileId:'not-the-path-original'}});
 assert.equal(response.status,policy==='denied'?403:503,JSON.stringify(response.body));assert.equal(response.body.code,policy==='denied'?'HTTP_CURRENT_ORIGINAL_POLICY_DENIED':'upload_accounting_unavailable');assert.equal(race.collisions,1);assert.equal(race.classCalls,1);assert.equal(race.options[0]?.requireCurrentPolicy,true);assert.equal(race.authentications,1);assert.equal(race.physicalCompletions,0);race.disarm();
 assert.equal((await f.files.getSourceFileById(prepared.body.file.fileId)).uploadState,'pending');assert.equal(f.settlements.size,0);assert.equal(f.closed.size,0);assert.equal((await f.repositories.auditEvents.list({limit:100})).items.filter(row=>row.action==='source_file.upload.completed').length,0);
});

test('COMPLETE JSON cannot manufacture the server-only observed-conflict policy marker',async t=>{
 const f=await retainedSourceHttpFixture(t),prepared=await begin(f);assert.equal((await transfer(f,prepared.body)).status,204);assert.equal(f.quota.checkCurrentPolicy,undefined);const complete=f.uploads.complete.bind(f.uploads);let calls=0,serverOptions;
 t.mock.method(f.uploads,'complete',async(...args)=>{calls++;serverOptions=args[1];return complete(...args);});
 const response=await f.request(`/studio/files/${prepared.body.file.fileId}/complete`,{method:'POST',body:{requireCurrentPolicy:true,recovery:{requireCurrentPolicy:true},observedConflict:true}});assert.equal(calls,1);assert.notEqual(serverOptions?.requireCurrentPolicy,true);await assertHttpOriginalFact(f,prepared,response);
});

test('COMPLETE HTTP fresh access refuses an actual Creator-owner change after a genuine preflight conflict',async t=>{
 const f=await retainedSourceHttpFixture(t),prepared=await begin(f);assert.equal((await transfer(f,prepared.body)).status,204);httpCurrentOriginalPolicy(f);const replacement=await f.local.identity.register({email:'replacement-source-owner@unit.test',password:'Actual replacement source owner password123!'});
 const race=await sourceHttpPreflightRace(t,f,prepared.body.file.fileId,{transition:async({independent})=>{const creator=await independent.repositories.creators.get(f.scope.creatorId);await independent.repositories.creators.update(creator.id,creator.revision,{subjectId:replacement.subjectId});}});
 const response=await f.request(`/studio/files/${prepared.body.file.fileId}/complete`,{method:'POST'});assert.equal(response.status,403,JSON.stringify(response.body));assert.equal(race.collisions,1);assert.equal(race.classCalls,0);assert.equal(race.physicalCompletions,0);assert.equal(race.authentications,1);race.disarm();assert.equal(f.settlements.size,0);assert.equal((await f.repositories.auditEvents.list({limit:100})).items.filter(row=>row.action==='source_file.upload.completed').length,0);
});

test('COMPLETE HTTP rechecks actual current safety hold after metadata recapture before invoking the class',async t=>{
 const f=await retainedSourceHttpFixture(t),prepared=await begin(f);assert.equal((await transfer(f,prepared.body)).status,204);httpCurrentOriginalPolicy(f);const race=await sourceHttpPreflightRace(t,f,prepared.body.file.fileId,{transition:async({independent})=>{const creator=await independent.repositories.creators.get(f.scope.creatorId);await independent.repositories.moderationHolds.create({id:'actual-completion-hold',instanceId:f.scope.instanceId,homeCellId:creator.homeCellId,dataHomeRegion:creator.dataHomeRegion,dataHomeAssignedAt:creator.dataHomeAssignedAt,routingRevision:creator.routingRevision,subjectType:'creator',subjectId:creator.id,state:'active',reason:'Actual current review hold'});}});
 const response=await f.request(`/studio/files/${prepared.body.file.fileId}/complete`,{method:'POST'});assert.equal(response.status,423,JSON.stringify(response.body));assert.equal(response.body.code,'safety_hold');assert.equal(race.collisions,1);assert.equal(race.classCalls,0);assert.equal(race.physicalCompletions,0);assert.equal(race.authentications,1);race.disarm();assert.equal(f.settlements.size,0);
});

test('five genuine COMPLETE HTTP preflight collisions exhaust the metadata budget without class/provider work or reauthentication',async t=>{
 const f=await retainedSourceHttpFixture(t),prepared=await begin(f);assert.equal((await transfer(f,prepared.body)).status,204);httpCurrentOriginalPolicy(f);const race=await sourceHttpPreflightRace(t,f,prepared.body.file.fileId,{always:true,limit:20});
 const response=await f.request(`/studio/files/${prepared.body.file.fileId}/complete`,{method:'POST'});assert.equal(response.status,409,JSON.stringify(response.body));assert.equal(race.collisions,5);assert.equal(race.classCalls,0);assert.equal(race.physicalCompletions,0);assert.equal(race.authentications,1);race.disarm();assert.equal(f.settlements.size,0);assert.equal(f.closed.size,0);assert.equal((await f.files.getSourceFileById(prepared.body.file.fileId)).uploadState,'pending');
});

test('upload-url keeps its original one-shot metadata behavior when a real Source read snapshot conflicts',async t=>{
 const f=await retainedSourceHttpFixture(t),prepared=await begin(f);httpCurrentOriginalPolicy(f);const race=await sourceHttpPreflightRace(t,f,prepared.body.file.fileId,{always:true,limit:20});
 const response=await f.request(`/studio/files/${prepared.body.file.fileId}/upload-url`,{method:'POST',body:input});assert.equal(response.status,409,JSON.stringify(response.body));assert.equal(race.collisions,1);assert.equal(race.classCalls,0);assert.equal(race.physicalCompletions,0);assert.equal(race.authentications,1);race.disarm();assert.equal(f.reservations.size,1);assert.equal(f.settlements.size,0);
});

for(const named of [false,true])test(`COMPLETE metadata ${named?'spoofed-name':'unknown'} errors remain one-shot failures rather than repository retries`,async t=>{
 const f=await retainedSourceHttpFixture(t),prepared=await begin(f);assert.equal((await transfer(f,prepared.body)).status,204);httpCurrentOriginalPolicy(f);const get=f.files.getSourceFileById.bind(f.files),failure=Error('An actual metadata callback failed after its real Source read');if(named)failure.name='OptimisticConcurrencyError';let reads=0,classCalls=0;
 t.mock.method(f.files,'getSourceFileById',async(...args)=>{reads++;await get(...args);throw failure;});const complete=f.uploads.complete.bind(f.uploads);t.mock.method(f.uploads,'complete',async(...args)=>{classCalls++;return complete(...args);});
 const response=await f.request(`/studio/files/${prepared.body.file.fileId}/complete`,{method:'POST'});assert.equal(response.status,500,JSON.stringify(response.body));assert.equal(reads,1);assert.equal(classCalls,0);assert.equal(f.settlements.size,0);assert.equal(f.closed.size,0);
});
