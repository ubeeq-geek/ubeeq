import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile,readFile,unlink,access as fileExists} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {createLocalAdapterSet} from '@ubeeq/adapter-local';
import {createRetainedRepositoryCreator} from '../dist/retained-repository-store.js';
import {createSourceUploadCleanupWorker} from '../dist/retained-source-files.js';
import {prepareSourceFileIntake,inspectStoredOriginal} from '../dist/retained-preparation-host.js';
import {sourceStore,sourceFile,sourceAudit,actorRecord,scope,creatorInput,at} from './retained-source-fixture.mjs';
import {work,asset} from './retained-repository-fixture.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');

async function fixture(t){
 const directory=await mkdtemp(join(tmpdir(),'retained-source-')),path=join(directory,'state.sqlite'),open=()=>createLocalAdapterSet({databasePath:path,dataDirectory:directory,cellId:'cell',publicBaseUrl:'http://localhost'});let local=open(),bound;
 t.after(async()=>{local.database.close();await rm(directory,{recursive:true,force:true});});
 await local.repositories.transaction(tx=>createRetainedRepositoryCreator(local.repositories,creatorInput,'tenant',tx));await local.repositories.hostRecords.create(actorRecord);
 const bind=()=>{bound=sourceStore(local.repositories);};bind();
 const create=async(file=sourceFile(),audit=sourceAudit())=>{await bound.store.commitSourceFile({expected:null,file,audit,access:await bound.access()});return file;};
 const mutate=async(expected,patch,auditId)=>{const file={...expected,...patch,revision:expected.revision+1};await bound.store.commitSourceFile({expected,file,audit:sourceAudit(auditId),access:await bound.access()});return file;};
 return {directory,get local(){return local;},get store(){return bound.store;},get access(){return bound.access;},create,mutate,reopen:()=>{local.database.close();local=open();bind();},audits:async()=>(await local.repositories.auditEvents.list({limit:100})).items};
}

test('actual source intake, private original verification, full records and audits reopen under one repository authority',async t=>{
 const f=await fixture(t),bytes=Buffer.from('Original private bytes'),config={tenantId:'tenant',localMediaDirectory:f.directory,externalContentMaxBytes:1024},host={originalCreatorPrefix:id=>`${id}/originals/`,file:value=>({...value,opaque:{legacy:true}})};
 const file=await prepareSourceFileIntake(f.store,config,{creatorId:'creator',fileId:'original',originalFilename:'Original.txt',mimeType:'text/plain',sizeBytes:bytes.length},await f.access(),async()=>{throw Error('Local intake must not call remote storage');},host);
 const target=resolve(f.directory,file.storageKey);await mkdir(dirname(target),{recursive:true});await writeFile(target,bytes);
 const ready=await f.mutate(file,{uploadState:'ready',checksumSha256:hash(bytes)},'completed');
 assert.equal(await inspectStoredOriginal(config,ready,{...host,isPrivateOriginalKey:()=>false,openStream:async key=>createReadStream(resolve(f.directory,key))}),hash(bytes));
 f.reopen();assert.deepEqual(await f.store.getSourceFileById(file.fileId),ready);assert.deepEqual((await f.store.getSourceFileAudit('completed')).detail,sourceAudit('completed').detail);assert.deepEqual(await readFile(target),bytes);
 assert.equal((await f.audits()).length,2);assert.deepEqual((await f.local.repositories.assets.list({limit:100})).items,[],'an original is not a compact asset or premature Work');
});

test('source and workflow receipt roll back together when the real audit write fails',async t=>{
 const f=await fixture(t),save=f.local.repositories.auditEvents.create.bind(f.local.repositories.auditEvents);f.local.repositories.auditEvents.create=async()=>{throw Error('Audit storage unavailable');};
 await assert.rejects(f.store.asActor('actor',async()=>{await f.store.publicationAtomic.put('content-workflow:tenant:creator:operation','stage',{id:'stage',actorId:'actor'});await f.create();}),/Audit storage unavailable/);
 assert.equal(await f.store.getSourceFileById('original'),null);assert.equal(await f.store.publicationAtomic.get('content-workflow:tenant:creator:operation','stage'),undefined);assert.deepEqual(await f.audits(),[]);
 f.local.repositories.auditEvents.create=save;await f.create();f.reopen();assert.equal((await f.store.getSourceFileById('original')).revision,1);assert.equal((await f.audits()).length,1);
});

test('source custody, state, saved access and audit identity cannot be forged or overwritten',async t=>{
 const f=await fixture(t),pending=await f.create(),ready=await f.mutate(pending,{uploadState:'ready',checksumSha256:'a'.repeat(64)},'ready');
 for(const patch of [{storageKey:'other/originals/file/source'},{uploadState:'pending'},{uploadState:'cancelled',downloadable:false,cancellation:{requestedAt:at,requestedByUserId:'actor'}},{creatorId:'other'}])await assert.rejects(f.mutate(ready,patch,'must-not-exist'));
 await assert.rejects(f.store.commitSourceFile({expected:ready,file:{...ready,revision:3},audit:sourceAudit('forged'),access:{...await f.access(),isAdmin:true,expectedOwner:undefined}}));
 await assert.rejects(f.store.commitSourceFile({expected:ready,file:{...ready,revision:3},audit:sourceAudit('ready'),access:await f.access()}),/audit identity/);
 assert.deepEqual(await f.store.getSourceFileById('original'),ready);assert.equal((await f.audits()).length,2);
 const previouslyAuthorized=await f.access(),revoked=await f.local.repositories.hostRecords.get(actorRecord.id);await f.local.repositories.hostRecords.update(revoked.id,revoked.revision,{value:{...revoked.value,active:false}});
 await assert.rejects(f.store.commitSourceFile({expected:ready,file:{...ready,restricted:true,revision:3},audit:sourceAudit('revoked'),access:previouslyAuthorized}),{code:'access_denied'});assert.equal(await f.store.getSourceFileAudit('revoked'),null);
});

test('canonical attachment checks the current original under the same actor and storage snapshot',async t=>{
 const f=await fixture(t),pending=await f.create(),ready=await f.mutate(pending,{uploadState:'ready',checksumSha256:'a'.repeat(64)},'ready');await f.store.asActor('actor',()=>f.store.createWork(work()));
 const input={previousRevision:1,work:work('work',{revision:2}),asset:asset('attached',{kind:'document',storage:{mode:'hosted',objectKey:ready.storageKey},metadata:{sourceFileId:ready.fileId}}),attachment:{workId:'work',assetId:'attached',role:'primary',position:0}};
 await f.mutate(ready,{restricted:true},'restricted');await assert.rejects(f.store.asActor('actor',()=>f.store.commitAssetAttachment(input)),/Original or Creator access changed/);assert.equal((await f.store.getWork('tenant','work')).revision,1);assert.equal(await f.store.getCanonicalAsset('tenant','attached'),null);
 const current=await f.store.getSourceFileById('original');await f.mutate(current,{restricted:false},'unrestricted');await f.store.asActor('actor',()=>f.store.commitAssetAttachment(input));assert.equal((await f.store.getCanonicalAsset('tenant','attached')).metadata.sourceFileId,'original');
});

async function cancelled(f){const pending=await f.create();return f.mutate(pending,{uploadState:'cancelled',downloadable:false,cancellation:{requestedAt:at,requestedByUserId:'actor'}},'cancelled');}
test('cancelled original cleanup survives restart, revocation and Creator deletion, and purges an upload arriving late',async t=>{
 const f=await fixture(t),file=await cancelled(f),target=resolve(f.directory,file.storageKey);await mkdir(dirname(target),{recursive:true});await writeFile(target,'private');
 await f.store.asActor('actor',()=>f.store.createWork(work()));const creator=await f.local.repositories.creators.get('creator');await f.local.repositories.creators.update(creator.id,creator.revision,{deletion:{operationId:'delete',requestedAt:at}});const actor=await f.local.repositories.hostRecords.get(actorRecord.id);await f.local.repositories.hostRecords.update(actor.id,actor.revision,{value:{...actor.value,active:false}});f.reopen();
 assert.equal((await f.store.getWork('tenant','work')).title,work().title,'persistence retains legitimate history reads during deletion');await assert.rejects(f.store.asActor('actor',()=>f.store.updateWork(work('work',{title:'Blocked'}))),{code:'access_denied'});
 let now=new Date(at);const purge=async original=>{assert.equal(original.uploadState,'cancelled');assert.equal(original.storageKey,file.storageKey);try{await unlink(target);}catch(error){if(error.code!=='ENOENT')throw error;}};
 let worker=createSourceUploadCleanupWorker(f.store,purge,()=>now);const first=await worker.runNextJob();assert.equal(first.fileId,file.fileId);await assert.rejects(fileExists(target),{code:'ENOENT'});assert.equal((await f.store.getSourceFileById(file.fileId)).cancellation.cleanupAttempts,1);
 await writeFile(target,'late upload');f.reopen();worker=createSourceUploadCleanupWorker(f.store,purge,()=>now);assert.equal(await worker.runNextJob(),undefined);assert.equal(await readFile(target,'utf8'),'late upload');now=new Date(first.nextAttemptAt);await worker.runNextJob();await assert.rejects(fileExists(target),{code:'ENOENT'});
 const after=await f.store.getSourceFileById(file.fileId);assert.equal(after.cancellation.cleanupAttempts,2);assert.deepEqual(after.opaque,file.opaque);assert.equal(after.storageKey,file.storageKey);assert.equal((await f.store.getWork('tenant','work')).title,work().title);
 assert.equal((await f.audits()).filter(row=>row.action==='source_file.upload.cleanup_attempted').length,2);
 await assert.rejects(f.store.commitSourceCleanup({expected:file,now:now.toISOString(),nextAttemptAt:new Date(now.getTime()+60000).toISOString()}),/Cancelled source changed/);
});

test('cleanup checkpoint authority cannot add a Work or forge an unrelated audit',async t=>{
 const f=await fixture(t),file=await cancelled(f),read=f.store.getSourceFileById.bind(f.store);let inject=true;
 f.store.getSourceFileById=async id=>{const value=await read(id);if(inject&&f.store.transaction()){inject=false;await f.store.createWork(work('smuggled'));}return value;};
 await assert.rejects(f.store.commitSourceCleanup({expected:file,now:at,nextAttemptAt:'2026-11-15T00:01:00.000Z'}),{code:'access_denied'});assert.equal(await f.store.getWork('tenant','smuggled'),null);assert.deepEqual(await f.store.getSourceFileById(file.fileId),file);
 f.store.getSourceFileById=async id=>{const value=await read(id);if(f.store.transaction())await f.store.appendRetainedAudit(sourceAudit('forged-system','system:source-upload-cleanup'));return value;};
 await assert.rejects(f.store.commitSourceCleanup({expected:file,now:at,nextAttemptAt:'2026-11-15T00:01:00.000Z'}),{code:'access_denied'});assert.equal((await f.audits()).length,2);
});

test('failed physical cleanup records retry evidence without claiming completed deletion',async t=>{
 const f=await fixture(t),file=await cancelled(f),worker=createSourceUploadCleanupWorker(f.store,async()=>{throw Error('Synthetic private storage outage');},()=>new Date(at));await worker.tick();
 const updated=await f.store.getSourceFileById(file.fileId);assert.equal(updated.uploadState,'cancelled');assert.equal(updated.cancellation.cleanupAttempts,1);assert.match(updated.cancellation.cleanupError,/Automatic retry/);assert.equal((await f.audits()).filter(row=>row.action==='source_file.upload.cleanup_failed').length,1);
 const page=await f.store.listCreatorSourceFiles('creator',{limit:1});assert.equal(page.items[0].fileId,file.fileId);assert.deepEqual((await f.store.listCreatorSourceFiles('other',{limit:1})).items,[]);await assert.rejects(f.store.listCreatorSourceFiles('creator',{limit:0}));
});


test('malformed original rows require reconciliation rather than disappearing from scoped inventory',async t=>{
 for(const corrupt of ['creatorId','fileId']){
  const f=await fixture(t),file=await f.create(),value={...file};delete value[corrupt];
  await f.store.asActor('actor',()=>f.store.putRetainedEntity('source-file',file.fileId,value));
  await assert.rejects(f.store.listSourceFilesByCreatorId('creator'),{code:'retained_content_invalid'});
  await assert.rejects(f.store.getSourceFileById(file.fileId),{code:'retained_content_invalid'});
 }
});

test('source inventory paging binds its cursor to the instance, tenant and Creator',async t=>{
 const f=await fixture(t);await f.create(sourceFile('a'),sourceAudit('a'));await f.create(sourceFile('b'),sourceAudit('b'));
 const first=await f.store.listCreatorSourceFiles('creator',{limit:1});assert.equal(first.items[0].fileId,'a');assert.equal((await f.store.listCreatorSourceFiles('creator',{limit:1,cursor:first.nextCursor})).items[0].fileId,'b');
 for(const patch of [{instanceId:'another-product'},{tenantId:'another-tenant'},{creatorId:'another-creator'}]){
  const cursor=Buffer.from(JSON.stringify({...JSON.parse(Buffer.from(first.nextCursor,'base64url').toString()),...patch})).toString('base64url');await assert.rejects(f.store.listCreatorSourceFiles('creator',{limit:1,cursor}),{code:'invalid_page'});
 }
});


test('persisted member and platform-role snapshots remain conditional even when another role still permits editing',async t=>{
 const f=await fixture(t),creator=await f.local.repositories.creators.get('creator');await f.local.repositories.creators.update(creator.id,creator.revision,{subjectId:'another-owner'});
 const member={...actorRecord,id:'source-member',namespace:'test-source-members',scopeId:'creator',key:'actor',value:{creatorId:'creator',userId:'actor',role:'editor',createdAt:at,invitedByUserId:'another-owner'}};await f.local.repositories.hostRecords.create(member);
 const pending=await f.create();assert.equal(pending.creatorId,'creator');const access=await f.access();assert.equal(access.expectedOwner,undefined);assert.equal(access.expectedMember.role,'editor');
 const row=await f.local.repositories.hostRecords.get(member.id);await f.local.repositories.hostRecords.update(row.id,row.revision,{value:{...row.value,role:'manager'}});
 await assert.rejects(f.store.commitSourceFile({expected:pending,file:{...pending,revision:2,uploadState:'ready'},audit:sourceAudit('changed-member'),access}),{code:'revision_conflict'});assert.equal((await f.store.getSourceFileById(pending.fileId)).revision,1);
 const actor=await f.local.repositories.hostRecords.get(actorRecord.id),assignment={userId:'actor',role:'creator',revision:1,updatedAt:at,updatedByUserId:'administrator'};await f.local.repositories.hostRecords.update(actor.id,actor.revision,{value:{...actor.value,platformRole:assignment}});const roleAccess=await f.access();const changed=await f.local.repositories.hostRecords.get(actorRecord.id);await f.local.repositories.hostRecords.update(changed.id,changed.revision,{value:{...changed.value,platformRole:{...assignment,role:'user',revision:2}}});
 await assert.rejects(f.store.commitSourceFile({expected:pending,file:{...pending,revision:2,uploadState:'ready'},audit:sourceAudit('changed-role'),access:roleAccess}),{code:'revision_conflict'});assert.equal(await f.store.getSourceFileAudit('changed-role'),null);
});

test('an actual persisted administrator role can manage originals without a fabricated Creator membership',async t=>{
 const f=await fixture(t),creator=await f.local.repositories.creators.get('creator');await f.local.repositories.creators.update(creator.id,creator.revision,{subjectId:'another-owner'});
 const row=await f.local.repositories.hostRecords.get(actorRecord.id),assignment={userId:'actor',role:'admin',revision:1,updatedAt:at,updatedByUserId:'administrator'};await f.local.repositories.hostRecords.update(row.id,row.revision,{value:{...row.value,platformRole:assignment}});
 const access=await f.access();assert.equal(access.isAdmin,true);assert.equal(access.expectedMember,null);assert.equal(access.expectedOwner,undefined);await f.store.commitSourceFile({expected:null,file:sourceFile(),audit:sourceAudit('admin-create','actor',{actorRole:'admin'}),access});
 const current=await f.local.repositories.hostRecords.get(actorRecord.id);await f.local.repositories.hostRecords.update(current.id,current.revision,{value:{...current.value,platformRole:{...assignment,role:'user',revision:2}}});
 await assert.rejects(f.store.commitSourceFile({expected:sourceFile(),file:sourceFile('original',{revision:2,uploadState:'ready'}),audit:sourceAudit('revoked-admin'),access}),{code:'access_denied'});assert.equal((await f.store.getSourceFileById('original')).uploadState,'pending');
});


test('server-side access capture uses actual guarded ownership and rejects a mismatched role record',async t=>{
 const f=await fixture(t);assert.deepEqual(await f.store.captureSourceAccess('actor'),await f.access());
 const row=await f.local.repositories.hostRecords.get(actorRecord.id);await f.local.repositories.hostRecords.update(row.id,row.revision,{value:{...row.value,platformRole:{userId:'different-user',role:'admin',revision:1,updatedAt:at,updatedByUserId:'administrator'}}});
 await assert.rejects(f.store.captureSourceAccess('actor'),{code:'access_denied'});
 await assert.rejects(f.store.asActor('actor',()=>f.store.createWork(work('bad-role'))),{code:'access_denied'});assert.equal(await f.store.getWork('tenant','bad-role'),null);
});
