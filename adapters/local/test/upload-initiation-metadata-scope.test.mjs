import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {setImmediate as turn} from 'node:timers/promises';
import {createLocalAdapterSet} from '../dist/index.js';
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
const observe=promise=>{let settled=false;const result=promise.then(value=>{settled=true;return{value};},error=>{settled=true;return{error};});return{result,get settled(){return settled;}};};
async function fixture(t){
 const directory=await mkdtemp(join(tmpdir(),'ubeeq-upload-admission-scope-')),local=createLocalAdapterSet({databasePath:join(directory,'state.sqlite'),dataDirectory:directory,cellId:'cell',publicBaseUrl:'http://127.0.0.1'}),releases=[],pending=[];
 t.after(async()=>{for(const release of releases)release();await Promise.allSettled(pending);local.database.close();await rm(directory,{recursive:true,force:true});});
 const bytes=Buffer.from('actual upload capability scope bytes'),input={object:{bucket:'cell',key:'cells/cell/creators/creator/originals/metadata-scope',contentType:'application/octet-stream',scope:'private',byteLength:bytes.byteLength,checksum:createHash('sha256').update(bytes).digest('hex')},checksumAlgorithm:'sha256',idempotencyKey:'actual-upload-admission',expiresAt:new Date(Date.now()+60_000).toISOString()};
 const track=promise=>{pending.push(promise);void promise.catch(()=>{});return promise;};
 const count=()=>local.database.transaction(async()=>local.database.database.prepare('SELECT COUNT(*) AS n FROM ubeeq_uploads').get().n);
 const hold=async()=>{const entered=deferred(),release=deferred();releases.push(release.resolve);const writer=track(local.repositories.transaction(async transaction=>{await local.repositories.hostRecords.create({id:'actual-unrelated-writer',instanceId:'instance',homeCellId:'cell',dataHomeRegion:'local',dataHomeAssignedAt:'2026-01-01T00:00:00.000Z',routingRevision:1,namespace:'upload-admission-test',scopeId:'creator',key:'unrelated',value:{actual:true}},{transaction});entered.resolve();await release.promise;}));await entered.promise;return{release,writer};};
 return{...local,input,bytes,track,count,hold,releases};
}
test('actual Local upload initiation waits for a foreign repository writer then returns the exact idempotent capability',{timeout:15000},async t=>{
 const f=await fixture(t),held=await f.hold(),pending=observe(f.track(f.storage.initiate(f.input)));
 try{await turn();await turn();assert.equal(pending.settled,false,'Metadata admission must queue before reading or writing the owned SQLite connection.');}finally{held.release.resolve();await held.writer;await pending.result;}
 const result=await pending.result;if(result.error)throw result.error;const upload=result.value;
 assert.deepEqual(upload.object,f.input.object);assert.equal(upload.expiresAt,f.input.expiresAt);assert.equal(upload.completeUrl,'http://127.0.0.1/v1/uploads/'+upload.uploadId+'/complete');assert.deepEqual(await f.storage.initiate(f.input),upload);assert.equal(await f.count(),1);
 const accepted={uploadId:upload.uploadId,cellId:'cell',creatorId:'creator'};await f.storage.accept({...accepted,operation:'upload_content',body:f.bytes});const receipt=await f.storage.complete({...accepted,checksum:f.input.object.checksum,byteLength:f.bytes.byteLength});assert.deepEqual(Buffer.from((await f.storage.get(receipt)).body),f.bytes);assert.equal(receipt.checksum,f.input.object.checksum);
});
test('upload admission joins the actual owner and caught nested idempotency failure rolls back its capability',{timeout:15000},async t=>{
 const f=await fixture(t);
 await assert.rejects(f.repositories.transaction(async()=>{const upload=await f.storage.initiate(f.input);assert.equal(await f.count(),1);assert.deepEqual(await f.storage.initiate(f.input),upload);throw Error('actual-upload-admission-rollback');}),/actual-upload-admission-rollback/);assert.equal(await f.count(),0);
 await assert.rejects(f.repositories.transaction(async()=>{await f.storage.initiate(f.input);await assert.rejects(f.storage.initiate({...f.input,object:{...f.input.object,byteLength:f.bytes.byteLength+1}}),/idempotency conflict/);}),/rollback-only after a nested failure/);assert.equal(await f.count(),0);
 const upload=await f.storage.initiate(f.input);assert.equal(await f.count(),1);assert.deepEqual(await f.storage.initiate(f.input),upload);
});
test('queued admission retains permanent seal and invalid-object denials without inserting another capability',{timeout:15000},async t=>{
 const f=await fixture(t),upload=await f.storage.initiate(f.input);assert.equal((await f.storage.seal({uploadId:upload.uploadId,cellId:'cell',creatorId:'creator'})).state,'sealed');assert.equal(await f.count(),0);
 const held=await f.hold(),sealed=observe(f.track(f.storage.initiate(f.input))),invalid=observe(f.track(f.storage.initiate({...f.input,object:{...f.input.object,key:'not-creator-scoped'}})));
 try{await turn();await turn();assert.equal(sealed.settled,false);assert.equal(invalid.settled,false);}finally{held.release.resolve();await held.writer;await Promise.all([sealed.result,invalid.result]);}
 assert.match(String((await sealed.result).error),/permanently sealed/);assert.match(String((await invalid.result).error),/not creator-scoped/);assert.equal(await f.count(),0);assert.equal((await f.storage.seal({uploadId:upload.uploadId,cellId:'cell',creatorId:'creator'})).state,'sealed');
});
test('a continuation from an ended Local transaction cannot mint an upload capability',{timeout:15000},async t=>{
 const f=await fixture(t),release=deferred();f.releases.push(release.resolve);let late;
 await f.repositories.transaction(async()=>{late=observe(f.track(release.promise.then(()=>f.storage.initiate(f.input))));});release.resolve();const result=await late.result;assert.match(String(result.error),/transaction context has ended/);assert.equal(await f.count(),0);
});
