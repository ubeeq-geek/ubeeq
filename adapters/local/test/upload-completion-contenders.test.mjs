import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,rm,stat,readFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setImmediate as turn} from 'node:timers/promises';
import {createLocalAdapterSet} from '../dist/index.js';
import {LocalUploadStreamCustody} from '../dist/upload-stream-custody.js';
import {removeOwnedLocalVersion} from '../dist/owned-version-removal.js';
import {validateOwnedVersionAbsence} from '@ubeeq/storage';
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
async function fixture(t,{independent=false,legacy=false}={}){
 const directory=await mkdtemp(join(tmpdir(),'local-completion-contenders-')),config={databasePath:join(directory,'core.sqlite'),dataDirectory:directory,cellId:'cell',publicBaseUrl:'http://127.0.0.1'},first=createLocalAdapterSet(config),second=independent?createLocalAdapterSet(config):first,pending=[],releases=[];
 t.after(async()=>{for(const release of releases)release();await Promise.allSettled(pending);first.database.close();if(second!==first)second.database.close();await rm(directory,{recursive:true,force:true});});
 const body=Buffer.from('Actual concurrent Local original bytes '+randomUUID()),checksum=createHash('sha256').update(body).digest('hex'),object={bucket:'cell',key:'cells/cell/creators/creator/originals/concurrent-'+randomUUID(),scope:'private',contentType:'application/octet-stream',byteLength:body.byteLength,checksum},upload=await first.storage.initiate({object,checksumAlgorithm:'sha256',expiresAt:new Date(Date.now()+60_000).toISOString()}),scope={uploadId:upload.uploadId,cellId:'cell',creatorId:'creator'},completion={...scope,checksum,byteLength:body.byteLength};
 if(legacy){
  // Actual persisted historical BLOB compatibility input. New accept(bytes)
  // already uses stream custody and is tested separately below.
  first.database.database.prepare('UPDATE ubeeq_uploads SET body=? WHERE id=?').run(body,upload.uploadId);
 }else await first.storage.accept({...scope,operation:'upload_content',body});
 const path=join(directory,'objects','cell',object.key,'upload-'+upload.uploadId);
 const track=promise=>{pending.push(promise);void promise.catch(()=>{});return promise;};
 return {directory,first,second,body,upload,scope,completion,path,track,releases};
}
function pauseVerifiedTemp(t,f){const entered=deferred(),release=deferred(),real=LocalUploadStreamCustody.prototype.verify;let armed=true;f.releases.push(release.resolve);
 t.mock.method(LocalUploadStreamCustody.prototype,'verify',async function(path,object){const result=await real.call(this,path,object);if(armed&&this.local===f.first.database&&path.includes('/.upload-content/')){armed=false;entered.resolve();await release.promise;}return result;});return {entered,release};
}
async function exact(f,object){assert.deepEqual(await readFile(f.path),f.body);assert.deepEqual(JSON.parse(await readFile(f.path+'.json','utf8')),object);assert.equal(object.checksum,f.completion.checksum);assert.equal(object.byteLength,f.body.byteLength);assert.ok(object.writtenAt);const row=await f.first.database.transaction(async()=>f.first.database.database.prepare('SELECT state,object_payload FROM ubeeq_upload_completions WHERE id=?').get(f.scope.uploadId));assert.equal(row.state,'completed');assert.deepEqual(JSON.parse(row.object_payload),object);assert.deepEqual(await readdir(join(f.directory,'.upload-content',createHash('sha256').update(f.scope.uploadId).digest('hex'))),[]);}
for(const independent of [false,true])test(`actual ${independent?'independent':'same'} Local connection contenders return one physically verified winning receipt after custody disappears`,{timeout:30000},async t=>{
 const f=await fixture(t,{independent}),gate=pauseVerifiedTemp(t,f),stale=f.track(f.first.storage.complete(f.completion));await gate.entered.promise;
 const winner=await f.second.storage.complete(f.completion);await exact(f,winner);gate.release.resolve();assert.deepEqual(await stale,winner);await exact(f,winner);
 assert.equal(await f.first.database.transaction(async()=>f.first.database.database.prepare('SELECT COUNT(*) AS n FROM ubeeq_upload_completions WHERE id=?').get(f.scope.uploadId).n),1);assert.deepEqual(await f.first.storage.recoverCompletion(f.completion),winner);
 await assert.rejects(f.first.storage.complete(f.completion),/already completed/,'an initial historical complete call keeps its original recover-only contract');
});
test('same Local connection historical BLOB contenders join actual receiving custody rather than treating prepared state as completion',{timeout:30000},async t=>{
 const f=await fixture(t,{legacy:true}),entered=deferred(),release=deferred(),real=LocalUploadStreamCustody.prototype.directory;let armed=true;f.releases.push(release.resolve);
 t.mock.method(LocalUploadStreamCustody.prototype,'directory',async function(path){const result=await real.call(this,path);if(armed&&this.local===f.first.database&&path.includes('/.upload-content/')){armed=false;entered.resolve();await release.promise;}return result;});
 const first=f.track(f.first.storage.complete(f.completion));await entered.promise;let settled=false;const other=f.track(f.second.storage.complete(f.completion));void other.then(()=>{settled=true;},()=>{settled=true;});await turn();assert.equal(settled,false,'receiving custody has not produced a successful or failed completion');const state=await f.first.database.transaction(async()=>({custody:f.first.database.database.prepare('SELECT state FROM ubeeq_upload_stream_custody WHERE id=?').get(f.scope.uploadId).state,receipt:f.first.database.database.prepare('SELECT state FROM ubeeq_upload_completions WHERE id=?').get(f.scope.uploadId).state}));assert.deepEqual(state,{custody:'receiving',receipt:'prepared'});
 release.resolve();const [a,b]=await Promise.all([first,other]);assert.deepEqual(a,b);await exact(f,a);
});
test('an admitted loser cannot recreate a winning completed version sidecar which was actually removed',{timeout:30000},async t=>{
 const f=await fixture(t,{independent:true}),gate=pauseVerifiedTemp(t,f),stale=f.track(f.first.storage.complete(f.completion));await gate.entered.promise;const winner=await f.second.storage.complete(f.completion);await exact(f,winner);await rm(f.path+'.json');gate.release.resolve();await assert.rejects(stale,{code:'ENOENT'});await assert.rejects(stat(f.path+'.json'),{code:'ENOENT'});assert.deepEqual(await readFile(f.path),f.body);assert.equal(f.first.database.database.prepare('SELECT state FROM ubeeq_upload_completions WHERE id=?').get(f.scope.uploadId).state,'completed');
});
test('an admitted loser cannot return prepared success or republish after exact owned removal permanently sealed the winner',{timeout:30000},async t=>{
 const f=await fixture(t,{independent:true}),gate=pauseVerifiedTemp(t,f),stale=f.track(f.first.storage.complete(f.completion));await gate.entered.promise;const winner=await f.second.storage.complete(f.completion),request={object:winner,upload:f.upload,cellId:'cell',creatorId:'creator'},proof=await removeOwnedLocalVersion(f.second.database,request);validateOwnedVersionAbsence(request,proof);
 gate.release.resolve();await assert.rejects(stale,/permanently sealed/);await assert.rejects(stat(f.path),{code:'ENOENT'});await assert.rejects(stat(f.path+'.json'),{code:'ENOENT'});await assert.rejects(f.first.storage.recoverCompletion(f.completion),{code:'ENOENT'});assert.deepEqual(await removeOwnedLocalVersion(f.second.database,request),proof);assert.equal(f.first.database.database.prepare('SELECT state FROM ubeeq_upload_completions WHERE id=?').get(f.scope.uploadId).state,'completed');
});
