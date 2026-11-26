// SOURCE ONLY; not run. Apply with the companion Core source overlay.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createLocalAdapterSet} from '@ubeeq/adapter-local';
import {createRetainedRepositoryCreator} from '../dist/retained-repository-store.js';
import {scope,creatorInput,work,retainedStore} from './retained-repository-fixture.mjs';
async function fixture(t){
 const directory=await mkdtemp(join(tmpdir(),'retained-physical-')),path=join(directory,'state.sqlite'),open=()=>createLocalAdapterSet({databasePath:path,dataDirectory:directory,cellId:scope.cellId,publicBaseUrl:'http://127.0.0.1'});let local=open();
 t.after(async()=>{local.database.close();await rm(directory,{recursive:true,force:true});});
 await local.repositories.transaction(tx=>createRetainedRepositoryCreator(local.repositories,creatorInput,scope.tenantId,tx));
 return {get local(){return local;},store:()=>retainedStore(local.repositories),snapshot:async()=>structuredClone((await local.repositories.hostRecords.snapshot()).items),reopen:()=>{local.database.close();local=open();return retainedStore(local.repositories);}};
}
test('actual Local full Native-sized writing and opaque JSON reopen without a compact duplicate or a second full payload',async t=>{
 const f=await fixture(t),store=f.store(),large=work('long',{description:'漢'.repeat(100000),body:[{blockId:'original',type:'paragraph',text:'x'.repeat(100000),payload:{all:['unknown','values']}}],opaque:''});large.opaque='x'.repeat(1024*1024-Buffer.byteLength(JSON.stringify(large)));assert.equal(Buffer.byteLength(JSON.stringify(large)),1024*1024);
 await store.asActor('actor',()=>store.createWork(large));assert.deepEqual(await f.reopen().getWork(scope.tenantId,'long'),large);
 const rows=await f.snapshot(),header=rows.find(row=>row.value.kind==='works'),chunks=rows.filter(row=>row.value.physicalKind==='retained-json-chunk');
 assert.equal(header.value.schemaVersion,2);assert.equal(Object.hasOwn(header.value,'payload'),false);assert.equal(header.value.encoding.format,'json-utf8-inline-v1');assert.equal(Buffer.byteLength(header.value.json),1024*1024);assert.equal(chunks.length,0);assert.equal((await f.local.repositories.works.list({limit:100})).items.length,0);
 const small=work('small'),resumed=f.store();await resumed.asActor('actor',()=>resumed.createWork(small));
 assert.equal((await f.snapshot()).find(row=>row.value.kind==='works'&&JSON.parse(row.value.json).workId==='small').value.encoding.format,'json-utf8-inline-v1');
});
test('same-inventory inline update preserves cohort revision while changed full logical rows retain actual CAS',async t=>{
 const f=await fixture(t),store=f.store(),original=work();await store.asActor('actor',()=>store.createWork(original));const before=(await f.snapshot()).find(row=>row.key==='cohort');
 await store.asActor('actor',()=>store.commitWorkRevision({...original,title:'Actual later edit',revision:2},1));assert.deepEqual((await f.snapshot()).find(row=>row.key==='cohort'),before);
 await assert.rejects(store.asActor('actor',()=>store.commitWorkRevision({...original,title:'Stale',revision:2},1)));assert.equal((await f.reopen().getWork(scope.tenantId,'work')).title,'Actual later edit');
});
test('actual Local SQL failure after a full inline row update rolls back Work, command and cohort',async t=>{
 const f=await fixture(t),store=f.store(),old=work('long',{description:'a'.repeat(350000)});await store.asActor('actor',()=>store.createWork(old));const before=await f.snapshot(),database=f.local.database.database,writes=[];
 database.function('retained_inline_updated',()=>{writes.push(1);return 0;});
 try{
  database.exec(`CREATE TEMP TRIGGER retained_inline_count AFTER UPDATE ON ubeeq_records WHEN NEW.repository='hostRecords' AND json_extract(NEW.payload,'$.value.kind')='works' BEGIN SELECT retained_inline_updated(); END`);
  database.exec(`CREATE TEMP TRIGGER retained_inline_fail BEFORE INSERT ON ubeeq_records WHEN NEW.repository='hostRecords' AND json_extract(NEW.payload,'$.value.kind')='operation' BEGIN SELECT RAISE(ABORT,'Actual physical command failure'); END`);
  await assert.rejects(store.asActor('actor',async()=>{await store.commitWorkRevision({...old,description:'b'.repeat(350000),revision:2},1);await store.publicationAtomic.put('content-workflow:tenant:creator:operation','must-rollback',{id:'must-rollback',actorId:'actor'});}),/Actual physical command failure/);
  assert.equal(writes.length,1);assert.deepEqual(await f.snapshot(),before);
 }finally{database.exec('DROP TRIGGER IF EXISTS retained_inline_fail');database.exec('DROP TRIGGER IF EXISTS retained_inline_count');}
 const reopened=f.reopen();assert.deepEqual(await reopened.getWork(scope.tenantId,'long'),old);assert.equal(await reopened.publicationAtomic.get('content-workflow:tenant:creator:operation','must-rollback'),undefined);
});
test('actual Local full JSON entity move and shrink preserve exact conditional authority',async t=>{
 const f=await fixture(t),store=f.store(),value={tenantId:scope.tenantId,creatorId:scope.creatorId,id:'original',opaque:'✨'.repeat(120000)};
 await store.asActor('actor',()=>store.putRetainedEntity('large','original',value));
 const next={...value,id:'moved'};await store.asActor('actor',()=>store.moveRetainedEntity({kind:'large',fromKey:'original',toKey:'moved',expected:value,next}));assert.equal(await store.getRetainedEntity('large','original'),undefined);assert.deepEqual(await f.reopen().getRetainedEntity('large','moved'),next);
 const small={...next,opaque:'small'},resumed=f.store();await resumed.asActor('actor',()=>resumed.putRetainedEntity('large','moved',small));assert.equal((await f.snapshot()).filter(row=>row.value.physicalKind==='retained-json-chunk').length,0);assert.deepEqual(await f.store().getRetainedEntity('large','moved'),small);
 await assert.rejects(resumed.asActor('actor',()=>resumed.moveRetainedEntity({kind:'large',fromKey:'original',toKey:'other',expected:value,next})),{status:409});
});
test('missing or retargeted actual inline inventory fails closed and reads never repair it',async t=>{
 for(const failure of ['missing','retarget']){
  const f=await fixture(t),store=f.store(),value=work('long',{description:'a'.repeat(350000)});await store.asActor('actor',()=>store.createWork(value));
  const row=(await f.snapshot()).find(row=>row.value.kind==='works');
  if(failure==='missing')await f.local.repositories.hostRecords.remove(row.id,row.revision);else await f.local.repositories.hostRecords.update(row.id,row.revision,{value:{...row.value,key:'foreign'}});
  const before=await f.snapshot();await assert.rejects(f.store().getWork(scope.tenantId,'long'),{code:'retained_content_invalid'});assert.deepEqual(await f.snapshot(),before);
 }
});

test('schema1 full JSON hydration is read-only and does not lower a valid Local record to 300KiB',async t=>{
 const f=await fixture(t),store=f.store(),value=work('legacy',{description:'漢'.repeat(150000),opaque:{full:['unknown','fields']}});await store.asActor('actor',()=>store.createWork(value));const row=(await f.snapshot()).find(entry=>entry.value.kind==='works');await f.local.repositories.hostRecords.update(row.id,row.revision,{value:{schemaVersion:1,category:row.value.category,kind:row.value.kind,key:row.value.key,payload:value}});const before=await f.snapshot();assert.deepEqual(await f.reopen().getWork(scope.tenantId,'legacy'),value);assert.deepEqual(await f.snapshot(),before);
});
