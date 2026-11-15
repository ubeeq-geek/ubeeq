import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createLocalAdapterSet} from '../dist/index.js';
const block=Buffer.alloc(64*1024,0x6d);
function digest(size){const value=createHash('sha256');for(let remaining=size;remaining>0;remaining-=Math.min(remaining,block.length))value.update(block.subarray(0,Math.min(remaining,block.length)));return value.digest('hex');}
async function* content(size){for(let remaining=size;remaining>0;remaining-=Math.min(remaining,block.length))yield block.subarray(0,Math.min(remaining,block.length));}
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
async function fixture(t,{size=block.length*3,checksum=digest(size),scope='private'}={}){
 const directory=await mkdtemp(join(tmpdir(),'real-upload-stream-')),configuration={databasePath:join(directory,'provider.sqlite'),dataDirectory:directory,cellId:'cell',publicBaseUrl:'http://127.0.0.1'};let local=createLocalAdapterSet(configuration);
 t.after(async()=>{local.database.close();await rm(directory,{recursive:true,force:true});});
 const upload=await local.storage.initiate({object:{bucket:'cell',key:'cells/cell/creators/creator/originals/stream',contentType:'video/mp4',scope,byteLength:size,...(checksum?{checksum}:{})},checksumAlgorithm:'sha256',expiresAt:new Date(Date.now()+15*60_000).toISOString()}),input={uploadId:upload.uploadId,cellId:'cell',creatorId:'creator'},completion={...input,checksum:digest(size),byteLength:size};
 return {directory,upload,input,completion,size,get local(){return local;},get db(){return local.database.database;},accept:body=>local.storage.acceptStream({...input,operation:'upload_content',body}),restart(){local.database.close();local=createLocalAdapterSet(configuration);}};
}
async function verify(storage,object){const opened=await storage.openReadStream(object),hash=createHash('sha256');let size=0;try{for await(const chunk of opened.body){assert.ok(chunk.length<=64*1024);size+=chunk.length;hash.update(chunk);}}finally{await opened.close();}return {size,checksum:hash.digest('hex')};}
test('actual 129 MiB stream is file-backed, preserves exact receipt and reopens without BLOB or whole-object get',async t=>{
 const f=await fixture(t,{size:129*1024*1024+17});await f.accept(content(f.size));
 assert.equal(f.db.prepare('SELECT body FROM ubeeq_uploads').get().body,null);const custody=f.db.prepare('SELECT * FROM ubeeq_upload_stream_custody').get();assert.equal(custody.state,'accepted');assert.equal(custody.byte_length,f.size);
 f.restart();f.local.storage.get=async()=>{throw Error('Whole-object get is forbidden in the stream contract.');};const object=await f.local.storage.complete(f.completion);assert.equal(object.byteLength,f.size);assert.equal(object.versionId,'upload-'+f.input.uploadId);assert.ok(object.writtenAt);
 assert.deepEqual(await verify(f.local.storage,object),{size:f.size,checksum:f.completion.checksum});assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM ubeeq_upload_stream_custody').get().n,0);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM ubeeq_uploads').get().n,0);
 const tempRoot=join(f.directory,'.upload-content',createHash('sha256').update(f.input.uploadId).digest('hex'));assert.deepEqual(await readdir(tempRoot),[]);
 f.restart();assert.deepEqual(await f.local.storage.recoverCompletion(f.completion),object);assert.deepEqual(await verify(f.local.storage,object),{size:f.size,checksum:f.completion.checksum});assert.equal((await stat(join(f.directory,'objects','cell',object.key,object.versionId))).mode&0o077,0);
});
test('corrupt, truncated, oversized or disconnected streams leave no accepted custody and permit a truthful retry',async t=>{
 const cases=[async function*(){yield Buffer.alloc(block.length*3);},()=>content(1),()=>content(block.length*4),async function*(){yield block;throw Error('Actual incoming connection ended.');}];
 for(const body of cases){const f=await fixture(t);await assert.rejects(f.accept(body()));assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM ubeeq_upload_stream_custody').get().n,0);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM ubeeq_upload_completions').get().n,0);assert.equal(f.db.prepare('SELECT body FROM ubeeq_uploads').get().body,null);await f.accept(content(f.size));assert.equal((await f.local.storage.complete(f.completion)).checksum,f.completion.checksum);}
});
test('actual concurrent seal unlinks in-flight custody and permanently rejects a resumed old writer across restart',async t=>{
 const f=await fixture(t),started=deferred(),resume=deferred();const pending=f.accept((async function*(){yield block;started.resolve();await resume.promise;yield block;yield block;})());const rejected=assert.rejects(pending,/closed|scope|expired|replaced/);await started.promise;
 const sealed=await f.local.storage.seal(f.input);assert.equal(sealed.state,'sealed');assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM ubeeq_upload_stream_custody').get().n,0);resume.resolve();await rejected;
 f.restart();assert.deepEqual(await f.local.storage.seal(f.input),sealed);await assert.rejects(f.accept(content(f.size)));assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM ubeeq_upload_completions').get().n,0);
});
test('an expired actual receiving lease can be replaced but the former descriptor cannot overwrite new custody',async t=>{
 const f=await fixture(t),started=deferred(),resume=deferred();const pending=f.accept((async function*(){yield block;started.resolve();await resume.promise;yield block;yield block;})());const rejected=assert.rejects(pending,/closed|scope|expired|replaced/);await started.promise;
 const old=f.db.prepare('SELECT lease_id FROM ubeeq_upload_stream_custody').get().lease_id;f.db.prepare('UPDATE ubeeq_upload_stream_custody SET lease_expires_at=? WHERE id=?').run(Date.now()-1,f.input.uploadId);
 await f.accept(content(f.size));assert.notEqual(f.db.prepare('SELECT lease_id FROM ubeeq_upload_stream_custody').get().lease_id,old);resume.resolve();await rejected;assert.equal(f.db.prepare('SELECT state FROM ubeeq_upload_stream_custody').get().state,'accepted');assert.equal((await f.local.storage.complete(f.completion)).checksum,f.completion.checksum);
});
test('an idle receiver retains its real issued expiry when no competing writer replaced its expired lease',async t=>{
 const f=await fixture(t),started=deferred(),resume=deferred(),pending=f.accept((async function*(){yield block;started.resolve();await resume.promise;yield block;yield block;})());await started.promise;
 f.db.prepare('UPDATE ubeeq_upload_stream_custody SET lease_expires_at=? WHERE id=?').run(Date.now()-1,f.input.uploadId);resume.resolve();await pending;assert.equal((await f.local.storage.complete(f.completion)).checksum,f.completion.checksum);
});
test('streaming queues its short provider transactions behind an actual concurrent repository acceptance',async t=>{
 const f=await fixture(t),started=deferred(),resume=deferred(),entered=deferred(),release=deferred();
 const receiving=f.accept((async function*(){yield block;started.resolve();await resume.promise;yield block;yield block;})());await started.promise;
 const accepted=f.local.repositories.transaction(async transaction=>{await f.local.repositories.hostRecords.create({id:'actual-concurrent-row',instanceId:'instance',namespace:'stream-test',scopeId:'creator',key:'record',homeCellId:'cell',dataHomeRegion:'ca-central-1',dataHomeAssignedAt:new Date().toISOString(),routingRevision:1,value:{retained:true}},{transaction});entered.resolve();await release.promise;});
 await entered.promise;resume.resolve();await new Promise(resolve=>setImmediate(resolve));release.resolve();await accepted;await receiving;assert.equal((await f.local.repositories.hostRecords.get('actual-concurrent-row')).value.retained,true);assert.equal((await f.local.storage.complete(f.completion)).checksum,f.completion.checksum);
});
test('accepted cancellation returns the real immutable completion instead of an absence proof',async t=>{
 const f=await fixture(t);await f.accept(content(f.size));f.restart();const result=await f.local.storage.seal(f.input);assert.equal(result.state,'completed');assert.deepEqual(await verify(f.local.storage,result.object),{size:f.size,checksum:f.completion.checksum});f.restart();assert.deepEqual(await f.local.storage.seal(f.input),result);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM ubeeq_upload_seals').get().n,0);
});
test('actual SQLite failure after physical link rolls back receipt closure; independent reopen recovers the same version',async t=>{
 const f=await fixture(t);await f.accept(content(f.size));f.db.exec("CREATE TRIGGER fail_stream_completion BEFORE DELETE ON ubeeq_uploads BEGIN SELECT RAISE(ABORT,'actual closure SQL failure'); END;");
 await assert.rejects(f.local.storage.complete(f.completion),/actual closure SQL failure/);assert.equal(f.db.prepare('SELECT state FROM ubeeq_upload_completions').get().state,'prepared');assert.equal(f.db.prepare('SELECT state FROM ubeeq_upload_stream_custody').get().state,'accepted');await assert.rejects(f.local.storage.abort(f.input),/reconciliation/);
 f.db.exec('DROP TRIGGER fail_stream_completion');f.restart();const object=await f.local.storage.recoverCompletion(f.completion);assert.equal(object.versionId,'upload-'+f.input.uploadId);assert.deepEqual(await verify(f.local.storage,object),{size:f.size,checksum:f.completion.checksum});assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM ubeeq_upload_stream_custody').get().n,0);
});
test('historical completed receipt never recreates a removed sidecar or immutable version',async t=>{
 const f=await fixture(t);await f.accept(content(f.size));const object=await f.local.storage.complete(f.completion),path=join(f.directory,'objects',object.bucket,object.key,object.versionId);
 await rm(path+'.json');await assert.rejects(f.local.storage.recoverCompletion(f.completion),{code:'ENOENT'});await assert.rejects(stat(path+'.json'),{code:'ENOENT'});assert.equal((await stat(path)).size,f.size);
 await f.local.storage.remove(object);f.restart();await assert.rejects(f.local.storage.recoverCompletion(f.completion),{code:'ENOENT'});await assert.rejects(f.local.storage.complete(f.completion),/already completed/);await assert.rejects(f.accept(content(f.size)));await assert.rejects(stat(path),{code:'ENOENT'});await assert.rejects(stat(path+'.json'),{code:'ENOENT'});assert.equal(f.db.prepare('SELECT state FROM ubeeq_upload_completions').get().state,'completed');
});
test('generic Local public/restricted uploads and historical checksum-optional BLOB completion retain their actual contracts',async t=>{
 for(const scope of ['public','restricted']){const f=await fixture(t,{scope});await f.accept(content(f.size));assert.equal((await f.local.storage.complete(f.completion)).scope,scope);}
 const f=await fixture(t,{size:block.length,checksum:null});f.db.prepare('UPDATE ubeeq_uploads SET body=? WHERE id=?').run(block,f.input.uploadId);const object=await f.local.storage.complete(f.completion);assert.deepEqual(await verify(f.local.storage,object),{size:f.size,checksum:f.completion.checksum});assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM ubeeq_upload_stream_custody').get().n,0);
});
