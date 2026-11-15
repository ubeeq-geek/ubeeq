import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createLocalAdapterSet} from '@ubeeq/adapter-local';
import {createReferenceApi} from '../dist/server.js';

test('ready Works stay editable through destination withdrawal; live receipts alone prevent deletion',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'ubeeq-work-readiness-'));
 const local=createLocalAdapterSet({databasePath:join(directory,'state.sqlite'),dataDirectory:directory,publicBaseUrl:'http://localhost',cellId:'cell'});
 const api=createReferenceApi({publicBaseUrl:'http://127.0.0.1:0',cellId:'cell',adapters:{repositories:local.repositories,storage:local.storage,uploads:local.storage,delivery:local.storage,jobs:local.jobs,identity:local.identity,localIdentity:local.identity}});
 await new Promise(resolve=>api.server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${api.server.address().port}`;
 let token;
 const call=async(path,method='GET',body,key)=>{
  const response=await fetch(base+path,{method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{}),...(key?{'idempotency-key':key}:{})},...(body?{body:JSON.stringify(body)}:{})});
  return {status:response.status,body:await response.json()};
 };
 try{
  assert.equal((await call('/v1/auth/sign-up','POST',{email:'owner@example.test',password:'safe-local-password'})).status,201);
  const signed=await call('/v1/auth/sign-in','POST',{email:'owner@example.test',password:'safe-local-password'});assert.equal(signed.status,200);token=signed.body.token;
  assert.equal((await call('/v1/creators','POST',{handle:'owner',displayName:'Owner'})).status,201);
  const created=await call('/v1/works','POST',{title:'Retain my original Work'});assert.equal(created.status,201);
  let work=created.body.work;const path='/v1/works/'+work.id,publicPath='/v1/public/works/'+work.id;
  const {instanceId,homeCellId,dataHomeRegion,dataHomeAssignedAt,routingRevision,creatorId}=work;
  const object={bucket:'cell',key:`cells/cell/creators/${creatorId}/renditions/asset`,versionId:'rendition-v1',contentType:'image/png',byteLength:1,scope:'private'};
  await local.storage.put({object,body:new Uint8Array([7])});
  await local.repositories.assets.create({id:'asset',instanceId,homeCellId,dataHomeRegion,dataHomeAssignedAt,routingRevision,creatorId,workId:work.id,status:'ready',mimeType:'image/png',checksum:'a'.repeat(64),objectVersion:'original-v1',storage:object});
  // Readiness and even a legacy Work flag grant no public access without a live receipt.
  work=await local.repositories.works.update(work.id,work.revision,{status:'ready'});
  assert.equal((await call(publicPath)).status,404);
  for(const key of ['first','second']){
   const published=await call(path+'/publications','POST',{destination:'local'},key);assert.equal(published.status,201);assert.equal(published.body.work.status,'ready');
  }
  work=(await call(path)).body.work;
  const foreign=await call(path+'/publications','POST',{destination:'elsewhere'},'elsewhere');assert.equal(foreign.status,201);
  assert.equal((await call(publicPath)).status,200);
  const blocked=await call(path,'DELETE',{revision:foreign.body.work.revision});assert.equal(blocked.status,409);assert.equal(blocked.body.error.code,'work_is_published');
  // A failed final audit rolls back ALL destination receipts and preserves the Work.
  const audit=local.repositories.auditEvents.create;
  local.repositories.auditEvents.create=async()=>{throw Error('audit unavailable');};
  try{assert.equal((await call(path+'/publications/local','PUT',{published:false})).status,500);}finally{local.repositories.auditEvents.create=audit;}
  let publications=(await call(path)).body.publications;assert.equal(publications.filter(p=>p.destination==='local'&&p.status==='live').length,2);
  assert.equal((await call(path+'/publications/local','PUT',{published:false})).status,200);
  let current=await call(path);publications=current.body.publications;
  assert.equal(current.body.work.status,'ready');assert.equal(current.body.work.title,work.title);
  assert.equal(publications.filter(p=>p.destination==='local'&&p.status==='live').length,0);
  assert.equal(publications.find(p=>p.destination==='elsewhere').status,'live');
  assert.equal((await call(path,'DELETE',{revision:current.body.work.revision})).status,409);
  assert.equal((await call(path+'/publications/elsewhere','PUT',{published:false})).status,200);
  assert.equal((await call(publicPath)).status,404);
  current=await call(path);assert.equal(current.body.work.status,'ready');
  const events=(await local.repositories.auditEvents.list({limit:100})).items.filter(e=>e.action==='work.withdrawn');assert.equal(events.length,2);
  assert.equal((await call(path+'/publications/elsewhere','PUT',{published:false})).status,200);
  assert.equal((await local.repositories.auditEvents.list({limit:100})).items.filter(e=>e.action==='work.withdrawn').length,2);
  assert.equal((await call(path,'DELETE',{revision:current.body.work.revision})).status,200);
  assert.equal((await call(publicPath)).status,404);
  // Existing records retain their legacy value; a flag without a receipt is private and deletable.
  const legacy=await local.repositories.works.create({id:'legacy',instanceId,homeCellId,dataHomeRegion,dataHomeAssignedAt,routingRevision,creatorId,title:'Legacy Work',status:'published'});
  assert.equal((await call('/v1/public/works/legacy')).status,404);
  assert.equal((await call('/v1/works/legacy')).body.work.status,'published');
  assert.equal((await call('/v1/works/legacy','DELETE',{revision:legacy.revision})).status,200);
 }finally{await api.close();local.database.database.close();rmSync(directory,{recursive:true,force:true});}
});
