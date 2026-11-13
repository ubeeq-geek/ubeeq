import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {createLocalAdapterSet} from '@ubeeq/adapter-local';
import {OwnedObjectWrites} from '../dist/owned-object-writes.js';
const home={homeCellId:'cell',dataHomeRegion:'local',dataHomeAssignedAt:'2026-01-01T00:00:00.000Z',routingRevision:1};
async function fixture(t){
 const directory=await mkdtemp(join(tmpdir(),'owned-object-'));
 let local,writer,grants=new Map(),settlements=new Map(),closures=new Map(),fault='',writeCount=0;
 const quota={
  async checkAndReserveQuota(input){if(closures.has(input.idempotencyKey))return {allowed:false,reasonCode:'RESERVATION_CLOSED'};const previous=grants.get(input.idempotencyKey);if(previous)assert.deepEqual(previous,input);grants.set(input.idempotencyKey,structuredClone(input));return {allowed:true};},
  async recordUsageSettlement(input){if(fault==='settlement-before')throw Error('Settlement unavailable');assert.ok(grants.has(input.idempotencyKey));const previous=settlements.get(input.idempotencyKey);if(previous)assert.deepEqual(previous,input);else settlements.set(input.idempotencyKey,structuredClone(input));if(fault==='settlement-after')throw Error('Committed settlement reply lost');},
  async closeStorageReservation(input){const previous=closures.get(input.idempotencyKey);if(previous)assert.deepEqual(previous,input);closures.set(input.idempotencyKey,structuredClone(input));if(fault==='closure-after')throw Error('Committed closure reply lost');}
 };
 const start=()=>{
  local=createLocalAdapterSet({databasePath:join(directory,'data.sqlite'),dataDirectory:directory,cellId:'cell',publicBaseUrl:'http://localhost'});
  const complete=local.storage.complete.bind(local.storage);
  local.storage.complete=async input=>{writeCount++;const object=await complete(input);if(fault==='complete-after')throw Error('Completion reply lost');return object;};
  writer=new OwnedObjectWrites(local.repositories,local.storage,quota,'instance','cell');
 };
 start();t.after(async()=>{local.database.close();await rm(directory,{recursive:true,force:true});});
 const input={creatorId:'creator',operation:'asset.rendition',idempotencyKey:'source-version',home,bucket:'cell',kind:'renditions',scope:'public',contentType:'text/plain',body:Buffer.from('retained physical derivative'),metadata:{source:{version:'original',id:'asset'}}};
 const rows=async()=>(await local.repositories.hostRecords.list({limit:100})).items;
 return {input,quota,grants,settlements,closures,rows,get local(){return local;},get writer(){return writer;},get writeCount(){return writeCount;},fault(value){fault=value;},restart(){local.database.close();start();}};
}
test('an internal output reserves before bytes and commits its physical receipt and settlement before returning',async t=>{
 const f=await fixture(t),accept=f.local.storage.accept.bind(f.local.storage);
 f.local.storage.accept=async input=>{assert.equal(f.grants.size,1);return accept(input);};
 const original=f.local.storage.put;f.local.storage.put=async()=>{throw Error('Unconditional put must not be used');};
 const result=await f.writer.write(f.input);assert.ok(result.object.versionId);assert.ok(result.object.writtenAt);assert.equal(f.settlements.size,1);
 assert.equal([...f.settlements.values()][0].storageBytesDelta,f.input.body.length);assert.equal([...f.settlements.values()][0].observedAt,result.object.writtenAt);
 const row=(await f.rows()).find(row=>row.namespace==='runtime-owned-object');assert.equal(row.value.phase,'completed');assert.ok(row.value.usageIntentId);assert.notEqual(row.id,row.value.usageIntentId);
 f.local.storage.put=original;assert.deepEqual((await f.local.storage.get(result.object)).body,f.input.body);
});
test('lost completion and settlement replies recover one immutable version across restart',async t=>{
 const f=await fixture(t);f.fault('complete-after');const output=await f.writer.write(f.input);assert.equal(f.writeCount,1);
 f.fault('settlement-after');const second=await f.writer.write({...f.input,idempotencyKey:'other-output'});assert.ok(second.object.versionId);
 f.restart();f.fault('');await f.writer.repair();assert.deepEqual(await f.writer.recover(f.input),output);assert.deepEqual(await f.writer.write(f.input),output);assert.equal(f.writeCount,2);assert.equal(f.settlements.size,2);
});
test('a failed physical receipt transaction is reconciled and counted without producing another version',async t=>{
 const f=await fixture(t),update=f.local.repositories.hostRecords.update.bind(f.local.repositories.hostRecords);let fail=true;
 f.local.repositories.hostRecords.update=async(id,revision,patch,options)=>{if(fail&&patch.value?.phase==='completed'){fail=false;throw Error('Receipt commit unavailable');}return update(id,revision,patch,options);};
 await assert.rejects(()=>f.writer.write(f.input),/Receipt commit unavailable/);assert.equal(f.settlements.size,0);assert.equal(f.writeCount,1);
 f.restart();const recovered=await f.writer.recover(f.input);assert.ok(recovered.object.versionId);assert.equal(f.writeCount,1);assert.equal(f.settlements.size,1);
 assert.deepEqual(await f.writer.write(f.input),recovered);
});
test('an interrupted accepted body is retained and counted even when its logical parent never commits',async t=>{
 const f=await fixture(t),complete=f.local.storage.complete.bind(f.local.storage);
 f.local.storage.complete=async()=>{throw Error('Provider completion unavailable');};
 await assert.rejects(()=>f.writer.write(f.input),/Provider completion unavailable/);assert.equal(f.settlements.size,0);
 f.local.storage.complete=complete;f.restart();const result=await f.writer.recover(f.input);assert.ok(result.object.versionId);assert.equal(f.settlements.size,1);
 assert.equal((await f.local.repositories.assets.list({limit:100})).items.length,0);
 assert.deepEqual((await f.local.storage.get(result.object)).body,f.input.body);
});
test('unused generations are physically sealed before releasing capacity and replacing their key',async t=>{
 const f=await fixture(t),accept=f.local.storage.accept.bind(f.local.storage);let old;
 f.local.storage.accept=async input=>{old=input;throw Error('No bytes sent');};
 await assert.rejects(()=>f.writer.write(f.input),/No bytes sent/);assert.equal(f.closures.size,0);
 f.local.storage.accept=accept;f.fault('closure-after');assert.equal(await f.writer.recover(f.input),undefined);
 assert.equal(f.closures.size,1);await assert.rejects(()=>accept(old),/scope/);
 const closed=(await f.rows()).find(row=>row.namespace==='runtime-owned-object');assert.equal(closed.value.phase,'sealed');assert.ok(closed.value.closureIntentId);
 f.restart();f.fault('');await f.writer.repair();const result=await f.writer.write(f.input);assert.notEqual(result.object.key,closed.value.object.key);assert.equal(f.settlements.size,1);
 assert.equal((await f.rows()).filter(row=>row.namespace==='runtime-owned-object').length,2);
});
test('a late reserve after an empty closure cannot issue a provider capability or accept bytes',async t=>{
 const f=await fixture(t),reserve=f.quota.checkAndReserveQuota.bind(f.quota);let release,entered;
 const pending=new Promise(resolve=>{entered=resolve;});const gate=new Promise(resolve=>{release=resolve;});
 f.quota.checkAndReserveQuota=async input=>{entered();await gate;return reserve(input);};
 const first=f.writer.write(f.input);await pending;assert.equal(await f.writer.recover(f.input),undefined);release();
 await assert.rejects(()=>first,/RESERVATION_CLOSED/);assert.equal(f.grants.size,0);
 assert.equal(f.local.database.database.prepare('SELECT COUNT(*) AS n FROM ubeeq_uploads').get().n,0);
});
test('changed bytes or metadata never retarget a logical output and foreign ownership is rejected',async t=>{
 const f=await fixture(t),output=await f.writer.write(f.input);
 await assert.rejects(()=>f.writer.write({...f.input,body:Buffer.from('different')}),/identity conflicts/);
 await assert.rejects(()=>f.writer.write({...f.input,metadata:{source:{id:'other',version:'original'}}}),/identity conflicts/);
 await assert.rejects(()=>f.writer.write({...f.input,home:{...home,homeCellId:'foreign'}}),/Invalid owned output/);
 assert.equal(await f.writer.recover({...f.input,creatorId:'foreign'}),undefined);
 assert.deepEqual(await f.writer.write({...f.input,metadata:{source:{id:'asset',version:'original'}}}),output);
});
test('concurrent exact writes converge on one physical version and one storage measurement',async t=>{
 const f=await fixture(t),results=await Promise.allSettled([f.writer.write(f.input),f.writer.write(f.input)]);
 const success=results.filter(r=>r.status==='fulfilled');assert.ok(success.length);const recovered=await f.writer.recover(f.input);
 for(const r of success)assert.deepEqual(r.value,recovered);assert.equal(f.settlements.size,1);
 const row=(await f.rows()).find(row=>row.namespace==='runtime-owned-object');assert.equal(row.value.completedObject.checksum,createHash('sha256').update(f.input.body).digest('hex'));
});
test('required internal writers reject missing physical receipts without issuing a storage operation',async t=>{
 const f=await fixture(t);assert.throws(()=>new OwnedObjectWrites(f.local.repositories,{...f.local.storage,seal:async()=>{}},f.quota,'instance','cell'),/durable receipts/);
});
test('admission denial after reservation closes the unused hold before any provider capability is issued',async t=>{
 const f=await fixture(t);f.quota.checkCurrentAdmission=async()=>({allowed:false,reasonCode:'ACCOUNT_SUSPENDED'});
 await assert.rejects(()=>f.writer.write(f.input),/ACCOUNT_SUSPENDED/);assert.equal(f.closures.size,1);assert.equal(f.settlements.size,0);
 assert.equal(f.local.database.database.prepare('SELECT COUNT(*) AS n FROM ubeeq_uploads').get().n,0);
 assert.equal((await f.rows()).find(row=>row.namespace==='runtime-owned-object').value.phase,'sealed');
});
