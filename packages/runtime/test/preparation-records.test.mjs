import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createLocalAdapterSet} from '@ubeeq/adapter-local';
import {RepositoryPreparationRecords,prepareNewCreatorPreparationRecords} from '../dist/preparation-records.js';

async function fixture(t,initialize=true){
 const directory=await mkdtemp(join(tmpdir(),'preparation-records-')),options={databasePath:join(directory,'state.sqlite'),dataDirectory:directory,cellId:'cell',publicBaseUrl:'http://localhost'};
 let local=createLocalAdapterSet(options);t.after(async()=>{local.database.close();await rm(directory,{recursive:true,force:true});});
 const home={homeCellId:'cell',dataHomeRegion:'local',dataHomeAssignedAt:'2026-11-14T00:00:00.000Z',routingRevision:1};
 await local.repositories.transaction(async transaction=>{
  const creator=await local.repositories.creators.create({id:'creator',instanceId:'instance',...home,subjectId:'owner',handle:'creator',displayName:'Creator'},{transaction});
  if(initialize)await prepareNewCreatorPreparationRecords(local.repositories,creator,transaction);
 });
 const connect=(scope={instanceId:'instance',cellId:'cell',region:'local'})=>new RepositoryPreparationRecords(local.repositories,scope);
 return {home,get local(){return local;},connect,records:connect(),kind:suffix=>'content-workflow:instance:creator:'+suffix,
  reopen(){local.database.close();local=createLocalAdapterSet(options);return connect();}};
}
test('preparation records retain exact payloads and kind isolation across a real database restart',async t=>{
 const f=await fixture(t),draft={id:'draft',revision:7,actorId:'owner',opaque:{preserve:true}},receipt={digest:'unchanged',result:0};
 await f.records.run(async()=>{await f.records.put(f.kind('draft'),'same',draft);await f.records.put(f.kind('receipt'),'same',receipt);assert.deepEqual(await f.records.get(f.kind('draft'),'same'),draft);});
 const restarted=f.reopen();assert.deepEqual(await restarted.get(f.kind('draft'),'same'),draft);assert.deepEqual(await restarted.get(f.kind('receipt'),'same'),receipt);assert.deepEqual(await restarted.list(f.kind('draft')),[draft]);
 draft.opaque.preserve=false;assert.equal((await restarted.get(f.kind('draft'),'same')).opaque.preserve,true);
});
test('canonical Work changes and preparation progress roll back together when the repository flush fails',async t=>{
 const f=await fixture(t);await f.records.put(f.kind('draft'),'draft',{revision:1});
 const repository=f.local.repositories.hostRecords,update=repository.update.bind(repository);let failed=false;
 repository.update=async(id,revision,change,options)=>{const row=await repository.get(id,options);if(!failed&&JSON.parse(row.key)[1]==='value'){failed=true;throw Error('Synthetic durable record failure');}return update(id,revision,change,options);};
 await assert.rejects(f.records.run(async()=>{
  await f.local.repositories.works.create({id:'work',instanceId:'instance',creatorId:'creator',...f.home,title:'Private Work',status:'draft'},{transaction:f.records.transaction()});
  await f.records.put(f.kind('draft'),'draft',{revision:2});
 }),/Synthetic durable record failure/);
 repository.update=update;assert.equal(await f.local.repositories.works.get('work'),undefined);assert.deepEqual(await f.records.get(f.kind('draft'),'draft'),{revision:1});
});
test('canonical-only effects retain read-only preparation and Creator dependency guards',async t=>{
 const f=await fixture(t);await f.records.put(f.kind('preset'),'preset',{revision:1});
 for(const repository of [f.local.repositories.hostRecords,f.local.repositories.creators]){
  const guard=repository.checkRevision.bind(repository);let checked=false;
  repository.checkRevision=async()=>{checked=true;throw Error('Synthetic changed dependency');};
  await assert.rejects(f.records.run(async()=>{
   assert.deepEqual(await f.records.get(f.kind('preset'),'preset'),{revision:1});
   await f.local.repositories.works.create({id:'dependent-work',instanceId:'instance',creatorId:'creator',...f.home,title:'Private Work',status:'draft'},{transaction:f.records.transaction()});
  }),/Synthetic changed dependency/);
  repository.checkRevision=guard;assert.equal(checked,true);assert.equal(await f.local.repositories.works.get('dependent-work'),undefined);
 }
});
test('the directory splits without using an eventually consistent repository index',async t=>{
 const f=await fixture(t),repository=f.local.repositories.hostRecords,list=repository.list.bind(repository);
 repository.list=async()=>{throw Error('A GSI is unavailable and must not supply preparation authority');};
 for(let i=0;i<130;i++)await f.records.put(f.kind('receipt'),'receipt-'+i,{id:i});
 assert.equal((await f.records.list(f.kind('receipt'))).length,130);
 const rows=await list({limit:1000});assert.ok(rows.items.some(row=>row.value.type==='branch'));assert.ok(rows.items.filter(row=>row.value.type==='leaf').every(row=>row.value.ids.length<=64));
 const restarted=f.reopen();f.local.repositories.hostRecords.list=async()=>{throw Error('No discovery index');};
 assert.equal((await restarted.list(f.kind('receipt'))).length,130);assert.deepEqual(await restarted.get(f.kind('receipt'),'receipt-129'),{id:129});
});
test('an existing Creator without an initialized directory cannot acquire empty-history authority through a read or write',async t=>{
 const f=await fixture(t,false);
 await assert.rejects(f.records.list(f.kind('draft')),e=>e.code==='preparation_migration_required');await assert.rejects(f.records.put(f.kind('draft'),'draft',{id:'draft'}),e=>e.code==='preparation_migration_required');
 assert.deepEqual((await f.local.repositories.hostRecords.list({limit:100})).items,[]);
});
test('instance, cell, region and current Creator state are enforced before records are changed',async t=>{
 const f=await fixture(t);await assert.rejects(f.records.put('content-workflow:other:creator:draft','id',{}),e=>e.code==='access_denied');
 for(const scope of [{instanceId:'instance',cellId:'other',region:'local'},{instanceId:'instance',cellId:'cell',region:'other'}])await assert.rejects(f.connect(scope).get(f.kind('draft'),'id'),e=>e.code==='access_denied');
 const creator=await f.local.repositories.creators.get('creator');await f.local.repositories.creators.update(creator.id,creator.revision,{status:'inactive'});
 await assert.rejects(f.records.put(f.kind('draft'),'id',{}),e=>e.code==='access_denied');
});
test('stored preparation roots must match the Creator current routing assignment',async t=>{
 const f=await fixture(t);await f.records.put(f.kind('draft'),'draft',{revision:1});
 const creator=await f.local.repositories.creators.get('creator');
 // Trusted migration writer: the normal cell-scoped repository correctly rejects data-home changes.
 await f.local.repositories.creators.repository.update(creator.id,creator.revision,{routingRevision:creator.routingRevision+1,dataHomeAssignedAt:'2026-11-15T00:00:00.000Z'});
 await assert.rejects(f.records.get(f.kind('draft'),'draft'),e=>e.code==='preparation_state_invalid');
 await assert.rejects(f.records.put(f.kind('draft'),'draft',{revision:2}),e=>e.code==='preparation_state_invalid');
});
test('a lost transaction response does not repeat a canonical effect when a saved receipt is retried',async t=>{
 const f=await fixture(t),repositories=f.local.repositories,transaction=repositories.transaction.bind(repositories);let lose=true;
 repositories.transaction=async operation=>{const result=await transaction(operation);if(lose){lose=false;throw Error('Synthetic lost response after commit');}return result;};
 const command=()=>f.records.run(async()=>{
  const receipt=await f.records.get(f.kind('receipt'),'operation');if(receipt)return receipt.result;
  const work=await repositories.works.create({id:'one-work',instanceId:'instance',creatorId:'creator',...f.home,title:'Private Work',status:'draft'},{transaction:f.records.transaction()});
  await f.records.put(f.kind('receipt'),'operation',{result:work.id});return work.id;
 });
 await assert.rejects(command(),/Synthetic lost response after commit/);assert.equal(await command(),'one-work');assert.equal((await repositories.works.list({limit:100})).items.length,1);
});
test('a detached continuation cannot reuse a completed preparation transaction cache',async t=>{
 const f=await fixture(t);let release,late;const gate=new Promise(resolve=>{release=resolve;});
 await f.records.run(async()=>{
  await f.records.put(f.kind('draft'),'draft',{revision:1});
  late=(async()=>{await gate;await f.records.put(f.kind('draft'),'draft',{revision:2});})();
 });
 release();await assert.rejects(late,/Preparation transaction context has ended/);
 assert.deepEqual(await f.connect().get(f.kind('draft'),'draft'),{revision:1});
});
test('catching a nested preparation failure cannot commit staged canonical or directory changes',async t=>{
 const f=await fixture(t);
 for(const [id,value] of [['invalid',undefined],['',{}]]){
  await assert.rejects(f.records.run(async()=>{
   await f.local.repositories.works.create({id:'caught-work',instanceId:'instance',creatorId:'creator',...f.home,title:'Private Work',status:'draft'},{transaction:f.records.transaction()});
   try{await f.records.put(f.kind('draft'),id,value);}catch{/* Outer callers cannot convert a failed write into a successful transaction. */}
  }),/cannot commit/);
  assert.equal(await f.local.repositories.works.get('caught-work'),undefined);assert.deepEqual(await f.records.list(f.kind('draft')),[]);
 }
});
