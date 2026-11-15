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
