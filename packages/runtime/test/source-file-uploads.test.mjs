import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createLocalAdapterSet} from '@ubeeq/adapter-local';
import {createRetainedRepositoryCreator} from '../dist/retained-repository-store.js';
import {SourceFileUploads,sourceFileOriginalCreatorPrefix,sourceFileOriginalObjectKey} from '../dist/source-file-uploads.js';
import {sourceStore,actorRecord,sourceFile,sourceAudit,creatorInput,scope} from './retained-source-fixture.mjs';
const bytes=Buffer.from('Synthetic immutable source original');
const checksum=createHash('sha256').update(bytes).digest('hex');
/** A truthful quota-port unit fixture. Physical acceptance in these tests is
 * always the real LocalFilesystemStorage and SQLite provider, not this fixture. */
function quotaPort(){
 const reservations=new Map(),settlements=new Map(),closures=new Map();let allowed=true,admitted=true,failSettlement=false,failClosure=false;
 return {reservations,settlements,closures,setAllowed(v){allowed=v;},setAdmitted(v){admitted=v;},setFailSettlement(v){failSettlement=v;},setFailClosure(v){failClosure=v;},
  async checkAndReserveQuota(input){if(closures.has(input.idempotencyKey))return {allowed:false,reasonCode:'CLOSED'};if(!allowed)return {allowed:false,reasonCode:'QUOTA_DENIED'};const previous=reservations.get(input.idempotencyKey);if(previous)assert.deepEqual(input,previous);reservations.set(input.idempotencyKey,structuredClone(input));return {allowed:true};},
  async checkCurrentAdmission(){return {allowed:admitted,reasonCode:admitted?undefined:'SUSPENDED'};},
  async recordUsageSettlement(input){if(failSettlement)throw Error('Quota settlement temporarily unavailable');assert.equal(closures.has(input.idempotencyKey),false);const reserve=reservations.get(input.idempotencyKey);assert.ok(reserve);assert.equal(input.storageBytesDelta,reserve.storageBytesDelta);const previous=settlements.get(input.idempotencyKey);if(previous)assert.deepEqual(input,previous);settlements.set(input.idempotencyKey,structuredClone(input));},
  async closeStorageReservation(input){if(failClosure)throw Error('Quota closure temporarily unavailable');assert.equal(settlements.has(input.idempotencyKey),false);const previous=closures.get(input.idempotencyKey);if(previous)assert.deepEqual(input,previous);closures.set(input.idempotencyKey,structuredClone(input));}
 };
}
async function fixture(t,options={}){
 const directory=await mkdtemp(join(tmpdir(),'source-original-upload-')),configuration={databasePath:join(directory,'sources.sqlite'),dataDirectory:directory,cellId:scope.cellId,publicBaseUrl:'http://127.0.0.1'};
 const quota=quotaPort();let local,store,lifecycle,now=new Date();
 const start=()=>{local=createLocalAdapterSet(configuration);store=sourceStore(local.repositories).store;lifecycle=new SourceFileUploads({repositories:local.repositories,uploads:local.storage,quota,files:store,bucket:scope.cellId,now:()=>now,prepareCompletion:async(file,object)=>{const loaded=await local.storage.get(object);assert.equal(loaded.object.versionId,object.versionId);assert.equal(file.storageKey,object.key);return {checksumSha256:createHash('sha256').update(loaded.body).digest('hex'),sizeBytes:loaded.body.byteLength,metadata:file.metadata};},...options});};start();
 t.after(async()=>{local.database.close();await rm(directory,{recursive:true,force:true});});
 await local.repositories.transaction(tx=>createRetainedRepositoryCreator(local.repositories,creatorInput,scope.tenantId,tx));await local.repositories.hostRecords.create(actorRecord);
 const file=sourceFile('original',{storageKey:sourceFileOriginalObjectKey({...scope,fileId:'original'}),sizeBytes:bytes.length});
 await store.commitSourceFile({expected:null,file,audit:sourceAudit(),access:await store.captureSourceAccess('actor')});
 return {directory,quota,file,get local(){return local;},get store(){return store;},get uploads(){return lifecycle;},
  initiate:(patch={})=>lifecycle.initiate({actorId:'actor',fileId:file.fileId,checksumSha256:checksum,...patch}),
  accept:(patch={})=>lifecycle.accept({actorId:'actor',fileId:file.fileId,body:bytes,...patch}),
  complete:(patch={})=>lifecycle.complete({actorId:'actor',fileId:file.fileId,...patch}),
  cancel:(patch={})=>lifecycle.cancel({actorId:'actor',fileId:file.fileId,expectedRevision:1,...patch}),
  restart(){local.database.close();start();},advance(milliseconds){now=new Date(now.getTime()+milliseconds);},
  async revoke(){const row=await local.repositories.hostRecords.get(actorRecord.id);await local.repositories.hostRecords.update(row.id,row.revision,{value:{...row.value,active:false}});},
  async journal(){return (await local.repositories.hostRecords.list({limit:100})).items.find(row=>row.namespace==='runtime-source-file-upload');},
  async audits(){return (await local.repositories.auditEvents.list({limit:100})).items;}
 };
}
test('SourceFile upload-before-Work completes through the actual local provider and survives restart without duplicate object or audit',async t=>{
 const f=await fixture(t),issued=await f.initiate();assert.equal(issued.state,'issued');assert.equal(issued.completed,false);assert.equal(f.quota.reservations.size,1);assert.equal(await f.uploads.owns('original'),true);assert.equal(await f.uploads.owns('missing'),false);
 await f.accept();const completed=await f.complete();assert.equal(completed.state,'completed');assert.equal(completed.file.uploadState,'ready');assert.equal(completed.file.checksumSha256,checksum);assert.deepEqual(completed.file.opaque,f.file.opaque);assert.deepEqual(completed.file.metadata,f.file.metadata);assert.equal(completed.usagePending,false);
 assert.deepEqual(await f.uploads.readPhysicalReceipt('original'),completed.object);assert.equal(await f.uploads.readPhysicalReceipt('missing'),undefined);assert.deepEqual((await f.local.storage.get(completed.object)).body,bytes);assert.equal(f.quota.settlements.size,1);const settlement=[...f.quota.settlements.values()][0];assert.equal(settlement.storageBytesDelta,bytes.length);assert.equal(settlement.observedAt,completed.object.writtenAt);
 assert.deepEqual((await f.local.repositories.works.list({limit:100})).items,[]);assert.deepEqual((await f.local.repositories.assets.list({limit:100})).items,[]);
 f.restart();const replay=await f.complete();assert.deepEqual(replay.object,completed.object);assert.equal(replay.file.revision,2);assert.equal((await f.initiate()).completed,true);assert.equal((await f.audits()).filter(row=>row.action==='source_file.upload.completed').length,1);
 assert.equal(f.local.database.database.prepare('SELECT COUNT(*) AS n FROM ubeeq_upload_completions').get().n,1);
});
test('changed precommit checksum, actor, file dimensions or bytes cannot retarget a persisted session',async t=>{
 const f=await fixture(t);await assert.rejects(f.initiate({checksumSha256:undefined}),{code:'upload_checksum_required'});assert.equal(await f.journal(),undefined);
 await f.initiate();await assert.rejects(f.initiate({checksumSha256:'0'.repeat(64)}),{code:'upload_identity_conflict'});await assert.rejects(f.accept({body:Buffer.alloc(bytes.length)}),{code:'upload_content_conflict'});
 assert.equal(f.local.database.database.prepare('SELECT body FROM ubeeq_uploads').get().body,null);
 await assert.rejects(f.complete({actorId:'other-actor'}),{code:'access_denied'});const file=await f.store.getSourceFileById('original');const access=await f.store.captureSourceAccess('actor');await f.store.asActor('actor',()=>f.store.commitSourceFile({expected:file,file:{...file,mimeType:'application/pdf',revision:2},access,audit:sourceAudit('changed-type')}));
 await assert.rejects(f.initiate(),{code:'upload_source_conflict'});assert.equal(f.quota.settlements.size,0);
});
test('legacy keys are preserved and rejected by the new physical driver without issuing any provider capability',async t=>{
 const f=await fixture(t),file=sourceFile('legacy',{sizeBytes:bytes.length});await f.store.commitSourceFile({expected:null,file,audit:sourceAudit('legacy'),access:await f.store.captureSourceAccess('actor')});
 await assert.rejects(f.initiate({fileId:'legacy'}),{code:'upload_legacy_storage'});assert.equal((await f.store.getSourceFileById('legacy')).storageKey,file.storageKey);assert.equal(await f.uploads.owns('legacy'),false);assert.equal(f.local.database.database.prepare('SELECT COUNT(*) AS n FROM ubeeq_uploads').get().n,0);
});
test('a lost real provider completion response recovers its immutable version instead of writing it twice',async t=>{
 const f=await fixture(t);await f.initiate();await f.accept();const complete=f.local.storage.complete.bind(f.local.storage);let calls=0;
 f.local.storage.complete=async input=>{calls++;const object=await complete(input);throw Error('Lost physical completion response');};
 const result=await f.complete();assert.equal(result.state,'completed');assert.equal(calls,1);assert.equal(f.quota.settlements.size,1);f.restart();assert.equal((await f.complete()).object.versionId,result.object.versionId);
});
test('a failed source audit transaction retains and charges the real original, then repairs the same source after restart',async t=>{
 const f=await fixture(t);await f.initiate();await f.accept();const create=f.local.repositories.auditEvents.create.bind(f.local.repositories.auditEvents);let fail=true;
 f.local.repositories.auditEvents.create=async(...args)=>{if(fail&&args[0].action==='source_file.upload.completed')throw Error('Audit database unavailable');return create(...args);};
 await assert.rejects(f.complete(),/Audit database unavailable/);assert.equal((await f.store.getSourceFileById('original')).uploadState,'pending');assert.equal((await f.journal()).value.phase,'retained');assert.equal(f.quota.settlements.size,1,'actual retained bytes are charged even though their source transaction failed');
 const receipt=(await f.journal()).value.completedObject;f.restart();await f.uploads.repair();assert.equal((await f.store.getSourceFileById('original')).uploadState,'ready');assert.equal(f.quota.settlements.size,1);assert.deepEqual((await f.journal()).value.completedObject,receipt);assert.equal((await f.audits()).filter(row=>row.action==='source_file.upload.completed').length,1);
});
test('revocation while the provider completes leaves source pending and physical bytes owned, charged and recoverable after restart',async t=>{
 const f=await fixture(t);await f.initiate();await f.accept();const complete=f.local.storage.complete.bind(f.local.storage);
 f.local.storage.complete=async input=>{const object=await complete(input);await f.revoke();return object;};
 await assert.rejects(f.complete(),{code:'access_denied'});assert.equal((await f.store.getSourceFileById('original')).uploadState,'pending');const receipt=(await f.journal()).value.completedObject;f.restart();const recovered=await f.uploads.recover('original');assert.equal(recovered.state,'retained');assert.equal(recovered.file.uploadState,'pending');assert.equal(f.quota.settlements.size,1);assert.deepEqual(recovered.object,receipt);assert.deepEqual((await f.local.storage.get(receipt)).body,bytes);assert.equal((await f.audits()).filter(row=>row.action==='source_file.upload.completed').length,0);
});
test('revocation before worker recovery cannot grant the saved actor a ready-source mutation',async t=>{
 const f=await fixture(t),issued=await f.initiate();await f.accept();await f.revoke();f.restart();await f.uploads.repair();const row=await f.journal();assert.equal(row.value.phase,'issued','an accepted local buffer is not yet a physical completion receipt');
 f.advance(16*60_000);await f.uploads.repair();assert.equal((await f.journal()).value.phase,'retained');assert.equal((await f.store.getSourceFileById('original')).uploadState,'pending');assert.equal(f.quota.settlements.size,1);assert.equal(f.quota.closures.size,0);assert.equal((await f.audits()).length,1);
});
test('unused cancellation durably seals the actual provider session and closes quota exactly once',async t=>{
 const f=await fixture(t),issued=await f.initiate(),providerId=issued.upload.uploadId;const cancelled=await f.cancel();assert.equal(cancelled.state,'sealed');assert.equal(cancelled.file.uploadState,'cancelled');assert.equal(f.quota.closures.size,1);assert.equal(f.quota.settlements.size,0);
 const row=await f.journal();assert.equal(row.value.seal.state,'sealed');assert.equal([...f.quota.closures.values()][0].proofId,row.value.seal.proofId);
 await assert.rejects(f.local.storage.accept({uploadId:providerId,cellId:scope.cellId,creatorId:scope.creatorId,body:bytes,operation:'upload_content'}));
 f.restart();const repeated=await f.cancel();assert.equal(repeated.state,'sealed');assert.equal(repeated.file.revision,2);assert.equal(f.quota.closures.size,1);assert.equal((await f.audits()).filter(row=>row.action==='source_file.upload.cancelled').length,1);await assert.rejects(f.initiate(),{code:'upload_cancelled'});
});
test('cancelling accepted bytes retains the exact physical version and charges actual bytes rather than closing its reservation',async t=>{
 const f=await fixture(t);await f.initiate();await f.accept();const cancelled=await f.cancel();assert.equal(cancelled.state,'retained');assert.equal(cancelled.file.uploadState,'cancelled');assert.deepEqual((await f.local.storage.get(cancelled.object)).body,bytes);assert.equal(f.quota.closures.size,0);assert.equal(f.quota.settlements.size,1);assert.equal([...f.quota.settlements.values()][0].storageBytesDelta,bytes.length);
 f.restart();const replay=await f.uploads.recover('original');assert.equal(replay.state,'retained');assert.equal(replay.file.uploadState,'cancelled');assert.deepEqual(replay.object,cancelled.object);assert.equal((await f.audits()).filter(row=>row.action==='source_file.upload.completed').length,0);
});
test('a lost seal reply is retried after restart using its actual persistent proof, even after revocation',async t=>{
 const f=await fixture(t);await f.initiate();const seal=f.local.storage.seal.bind(f.local.storage);f.local.storage.seal=async input=>{await seal(input);throw Error('Lost seal reply');};
 await assert.rejects(f.cancel(),/Lost seal reply/);assert.equal((await f.journal()).value.phase,'closing');assert.equal((await f.store.getSourceFileById('original')).uploadState,'cancelled');await f.revoke();f.restart();await f.uploads.repair();assert.equal((await f.journal()).value.phase,'sealed');assert.equal(f.quota.closures.size,1);assert.equal(f.quota.settlements.size,0);
});
test('expiry and admission denial close unused physical sessions without requiring a Work or fabricated source edit',async t=>{
 const f=await fixture(t);await f.initiate();f.advance(16*60_000);await f.uploads.repair();assert.equal((await f.journal()).value.phase,'sealed');assert.equal((await f.store.getSourceFileById('original')).uploadState,'pending');assert.equal(f.quota.closures.size,1);await assert.rejects(f.initiate(),{code:'upload_closed'});
});
test('quota denial and current-admission denial fence future reservations before a capability reaches the browser',async t=>{
 for(const decision of ['quota','admission']){
  const f=await fixture(t);if(decision==='quota')f.quota.setAllowed(false);else f.quota.setAdmitted(false);
  await assert.rejects(f.initiate(),{code:decision==='quota'?'QUOTA_DENIED':'SUSPENDED'});assert.equal((await f.journal()).value.phase,'sealed');assert.equal(f.local.database.database.prepare('SELECT COUNT(*) AS n FROM ubeeq_uploads').get().n,0);assert.equal(f.quota.closures.size,1);
 }
});
test('usage and closure outages leave durable replayable intents rather than inventing an acknowledgement',async t=>{
 const f=await fixture(t);await f.initiate();await f.accept();f.quota.setFailSettlement(true);const result=await f.complete();assert.equal(result.state,'completed');assert.equal(result.usagePending,true);assert.equal(f.quota.settlements.size,0);assert.ok((await f.journal()).value.usageIntentId);f.quota.setFailSettlement(false);f.restart();await f.uploads.repair();assert.equal(f.quota.settlements.size,1);
 const g=await fixture(t);await g.initiate();g.quota.setFailClosure(true);const cancelled=await g.cancel();assert.equal(cancelled.state,'sealed');assert.equal(cancelled.usagePending,true);assert.ok((await g.journal()).value.closureIntentId);g.quota.setFailClosure(false);g.restart();await g.uploads.repair();assert.equal(g.quota.closures.size,1);
});
test('a ready original cannot cancel or revert, and another instance cannot claim its session',async t=>{
 const f=await fixture(t);await f.initiate();await f.accept();await f.complete();await assert.rejects(f.cancel({expectedRevision:2}),{code:'upload_already_completed'});assert.equal((await f.store.getSourceFileById('original')).uploadState,'ready');
 const row=await f.journal();await f.local.repositories.hostRecords.update(row.id,row.revision,{instanceId:'another-instance'});await assert.rejects(f.uploads.recover('original'),/requires reconciliation/);
});

test('missing or failing original finalization cannot mark accepted bytes ready or release their storage',async t=>{
 const f=await fixture(t);assert.throws(()=>new SourceFileUploads({repositories:f.local.repositories,uploads:f.local.storage,quota:f.quota,files:f.store,bucket:scope.cellId}),/actual original finalization/);
 const g=await fixture(t,{prepareCompletion:async()=>{throw Error('Image decoder unavailable');}});await g.initiate();await g.accept();await assert.rejects(g.complete(),/Image decoder unavailable/);assert.equal((await g.store.getSourceFileById('original')).uploadState,'pending');assert.equal((await g.journal()).value.phase,'retained');assert.equal(g.quota.settlements.size,1);assert.equal(g.quota.closures.size,0);
});

test('finalization cannot retarget custody/checksum or discard existing opaque metadata',async t=>{
 for(const output of [{checksumSha256:'0'.repeat(64),sizeBytes:bytes.length,metadata:{legacy:'retained'}},{checksumSha256:checksum,sizeBytes:bytes.length,metadata:{}},{checksumSha256:checksum,sizeBytes:bytes.length,metadata:{legacy:'retained'},storageKey:'another/key'}]){
  const f=await fixture(t,{prepareCompletion:async(file,object)=>{const actual=await f.local.storage.get(object);assert.deepEqual(actual.body,bytes);return output;}});await f.initiate();await f.accept();await assert.rejects(f.complete());assert.equal((await f.store.getSourceFileById('original')).uploadState,'pending');assert.deepEqual((await f.store.getSourceFileById('original')).metadata,f.file.metadata);assert.equal(f.quota.settlements.size,1);
 }
});
test('finalization enriches metadata only after reading the actual immutable original',async t=>{
 const f=await fixture(t,{prepareCompletion:async(file,object)=>{const actual=await f.local.storage.get(object);return {checksumSha256:createHash('sha256').update(actual.body).digest('hex'),sizeBytes:actual.body.length,metadata:{...file.metadata,verifiedBytes:true}};}});await f.initiate();await f.accept();const result=await f.complete();assert.deepEqual(result.file.metadata,{legacy:'retained',verifiedBytes:true});assert.deepEqual(result.file.opaque,f.file.opaque);
});

test('new original physical prefixes isolate instances while preserving Creator custody',()=>{
 const first=sourceFileOriginalObjectKey({...scope,fileId:'original'}),second=sourceFileOriginalObjectKey({...scope,instanceId:'another-instance',fileId:'original'});
 assert.notEqual(first,second);assert.ok(first.startsWith(`cells/${scope.cellId}/creators/${scope.creatorId}/originals/instance-`));assert.equal(first,sourceFileOriginalCreatorPrefix(scope)+'original/source');
 for(const patch of [{cellId:'../cell'},{creatorId:'../creator'},{fileId:'../original'},{instanceId:''}])assert.throws(()=>sourceFileOriginalObjectKey({...scope,fileId:'original',...patch}));
});
test('bounded repair durably advances beyond an earlier uncompleted session after restart',async t=>{
 const f=await fixture(t);await f.initiate();const second=sourceFile('later',{storageKey:sourceFileOriginalObjectKey({...scope,fileId:'later'}),sizeBytes:bytes.length});await f.store.commitSourceFile({expected:null,file:second,audit:sourceAudit('later'),access:await f.store.captureSourceAccess('actor')});await f.initiate({fileId:'later'});await f.accept({fileId:'later'});await f.local.storage.complete({uploadId:(await f.initiate({fileId:'later'})).upload.uploadId,cellId:scope.cellId,creatorId:scope.creatorId,checksum,byteLength:bytes.length});
 await f.uploads.repair(1);f.restart();await f.uploads.repair(1);assert.equal((await f.store.getSourceFileById('later')).uploadState,'ready');assert.equal((await f.store.getSourceFileById('original')).uploadState,'pending');assert.equal(f.quota.settlements.size,1);
});
