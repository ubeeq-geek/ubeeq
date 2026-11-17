import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {request as nodeRequest} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {inspectStoredObjectStream} from '@ubeeq/storage';
import {sourceFileStreamFixture} from './source-file-stream-fixture.mjs';
const block=Buffer.alloc(64*1024,0x2c);
function sha(size){const hash=createHash('sha256');for(let remaining=size;remaining>0;remaining-=Math.min(remaining,block.length))hash.update(block.subarray(0,Math.min(remaining,block.length)));return hash.digest('hex');}
async function* body(size){for(let remaining=size;remaining>0;remaining-=Math.min(remaining,block.length))yield block.subarray(0,Math.min(remaining,block.length));}
const input=size=>({creatorId:'creator',originalFilename:'Actual original.mp4',mimeType:'video/mp4',sizeBytes:size,checksumSha256:sha(size)});
const begin=(f,size)=>f.request('/studio/files/uploads',{method:'POST',body:input(size)});
const transfer=(f,upload,size,stream=body(size))=>f.request(upload.uploadPath,{method:'PUT',stream,headers:{...upload.requiredHeaders,'content-length':String(size)}});
test('actual authenticated 129 MiB Local HTTP original streams before any Work and completes/reopens the same receipt',async t=>{
 const size=129*1024*1024+9,f=await sourceFileStreamFixture(t),prepared=await begin(f,size);assert.equal(prepared.status,201,JSON.stringify(prepared.body));assert.equal(prepared.body.requiresAuth,true);assert.equal((await transfer(f,prepared.body,size)).status,204);
 assert.equal(f.local.database.database.prepare('SELECT body FROM ubeeq_uploads').get().body,null);await f.restart();
 const completed=await f.request(`/studio/files/${prepared.body.file.fileId}/complete`,{method:'POST'});assert.equal(completed.status,200,JSON.stringify(completed.body));assert.equal(completed.body.uploadState,'ready');assert.equal(completed.body.metadata.streamVerified,true);assert.deepEqual(completed.body.opaque,{retained:['full','source','JSON']});
 const receipt=await f.uploads.readPhysicalReceipt(prepared.body.file.fileId);assert.deepEqual(await inspectStoredObjectStream(f.local.storage,receipt,size),{checksumSha256:sha(size),sizeBytes:size});assert.equal(f.settlements.size,1);assert.equal([...f.settlements.values()][0].storageBytesDelta,size);assert.equal(f.closures.size,0);
 assert.deepEqual((await f.local.repositories.works.list({limit:100})).items,[]);assert.deepEqual((await f.local.repositories.assets.list({limit:100})).items,[]);await f.restart();assert.deepEqual(await f.uploads.readPhysicalReceipt(prepared.body.file.fileId),receipt);assert.equal((await f.request(`/studio/files/${prepared.body.file.fileId}/complete`,{method:'POST'})).status,200);assert.equal(f.settlements.size,1);
});
test('configured genuine Local metadata allowance may exceed managed single-PUT while both actual host bounds stay enforced',async t=>{
 // Descriptor/metadata acceptance only: no claim that a synthetic 6 GiB body
 // was transferred. Actual large transfer is covered above with 129 MiB.
 const size=6*1024**3,largeInput=input(size),f=await sourceFileStreamFixture(t,{maximumUploadBytes:size,maximumProxyUploadBytes:size}),prepared=await f.request('/studio/files/uploads',{method:'POST',body:largeInput});assert.equal(prepared.status,201,JSON.stringify(prepared.body));
 assert.equal(prepared.body.file.sizeBytes,size);assert.equal((await f.request(`/studio/files/${prepared.body.file.fileId}/cancel`,{method:'POST',body:{expectedRevision:1}})).body.cleanup,'sealed');
 const limited=await sourceFileStreamFixture(t,{maximumUploadBytes:1024,maximumProxyUploadBytes:512}),admitted=await begin(limited,768);assert.equal(admitted.status,201);assert.equal((await transfer(limited,admitted.body,768)).status,413);assert.equal((await begin(limited,1025)).status,400);
 const managed=await sourceFileStreamFixture(t,{maximumUploadBytes:5*1024**3,maximumProxyUploadBytes:size,localMode:false});assert.equal((await managed.request('/studio/files/uploads',{method:'POST',body:largeInput})).status,400);
});
test('real HTTP checksum failure never marks source ready, creates physical receipt or charges nonexistent accepted bytes',async t=>{
 const f=await sourceFileStreamFixture(t),size=block.length*2,prepared=await begin(f,size),wrong=(async function*(){yield Buffer.alloc(block.length);yield Buffer.alloc(block.length);})();
 const result=await transfer(f,prepared.body,size,wrong);assert.equal(result.status,409,JSON.stringify(result.body));assert.equal(result.body.code,'upload_content_conflict');assert.equal((await f.files.getSourceFileById(prepared.body.file.fileId)).uploadState,'pending');assert.equal(await f.uploads.readPhysicalReceipt(prepared.body.file.fileId),undefined);assert.equal(f.settlements.size,0);assert.equal(f.local.database.database.prepare('SELECT COUNT(*) AS n FROM ubeeq_upload_stream_custody').get().n,0);
 assert.equal((await transfer(f,prepared.body,size)).status,204);assert.equal((await f.request(`/studio/files/${prepared.body.file.fileId}/complete`,{method:'POST'})).status,200);
});
test('a real disconnected HTTP sender leaves no accepted original and can retry its same issued session',async t=>{
 const f=await sourceFileStreamFixture(t),size=block.length*3,prepared=await begin(f,size),pending=nodeRequest(f.origin+prepared.body.uploadPath,{method:'PUT',headers:{authorization:'Bearer '+f.token,...prepared.body.requiredHeaders,'content-length':String(size)}});
 pending.on('error',()=>{});pending.flushHeaders();pending.write(block);
 for(let i=0;i<100&&!f.local.database.database.prepare('SELECT id FROM ubeeq_upload_stream_custody').get();i++)await delay(10);
 assert.equal(f.local.database.database.prepare('SELECT state FROM ubeeq_upload_stream_custody').get()?.state,'receiving');
 const closed=new Promise(resolve=>pending.once('close',resolve));pending.destroy();await closed;
 for(let i=0;i<100&&f.local.database.database.prepare('SELECT id FROM ubeeq_upload_stream_custody').get();i++)await delay(10);
 assert.equal(f.local.database.database.prepare('SELECT COUNT(*) AS n FROM ubeeq_upload_stream_custody').get().n,0);assert.equal((await f.files.getSourceFileById(prepared.body.file.fileId)).uploadState,'pending');assert.equal(await f.uploads.readPhysicalReceipt(prepared.body.file.fileId),undefined);assert.equal(f.settlements.size,0);
 assert.equal((await transfer(f,prepared.body,size)).status,204);assert.equal((await f.request(`/studio/files/${prepared.body.file.fileId}/complete`,{method:'POST'})).status,200);
});
test('failed finalization and actual identity revocation retain and charge the exact stream receipt across restart',async t=>{
 const f=await sourceFileStreamFixture(t),size=block.length*3,prepared=await begin(f,size);assert.equal((await transfer(f,prepared.body,size)).status,204);f.setFinalizerFailure(true);
 assert.equal((await f.request(`/studio/files/${prepared.body.file.fileId}/complete`,{method:'POST'})).status,503);const receipt=await f.uploads.readPhysicalReceipt(prepared.body.file.fileId);assert.ok(receipt);assert.equal((await f.files.getSourceFileById(prepared.body.file.fileId)).uploadState,'pending');assert.equal(f.settlements.size,1);
 await f.revoke();await f.restart();assert.equal((await f.request(`/studio/files/${prepared.body.file.fileId}/complete`,{method:'POST'})).status,401);const recovered=await f.uploads.recover(prepared.body.file.fileId);assert.equal(recovered.state,'retained');assert.equal(recovered.file.uploadState,'pending');assert.deepEqual(recovered.object,receipt);assert.equal(f.settlements.size,1);assert.equal(f.closures.size,0);
});
test('cancel after actual streamed acceptance preserves charged original custody and denies ready/download',async t=>{
 const f=await sourceFileStreamFixture(t),size=block.length*2,prepared=await begin(f,size);assert.equal((await transfer(f,prepared.body,size)).status,204);
 const cancelled=await f.request(`/studio/files/${prepared.body.file.fileId}/cancel`,{method:'POST',body:{expectedRevision:1}});assert.equal(cancelled.status,200);assert.equal(cancelled.body.cleanup,'retained');assert.equal(cancelled.body.file.uploadState,'cancelled');assert.equal(f.settlements.size,1);assert.equal(f.closures.size,0);
 const receipt=await f.uploads.readPhysicalReceipt(prepared.body.file.fileId);await f.restart();assert.deepEqual((await f.uploads.recover(prepared.body.file.fileId)).object,receipt);assert.equal((await f.request(`/studio/files/${prepared.body.file.fileId}/download`)).status,409);assert.equal((await f.files.getSourceFileById(prepared.body.file.fileId)).uploadState,'cancelled');
});
