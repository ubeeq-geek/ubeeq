import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createLocalAdapterSet} from '@ubeeq/adapter-local';
import {createRetainedRepositoryCreator} from '../dist/retained-repository-store.js';
import {scope,creatorInput,work,asset,publication,retainedStore,seedAsset,at} from './retained-repository-fixture.mjs';

async function fixture(t,birth=true){
 const directory=await mkdtemp(join(tmpdir(),'retained-repository-')),path=join(directory,'state.sqlite'),open=()=>createLocalAdapterSet({databasePath:path,dataDirectory:directory,cellId:'cell',publicBaseUrl:'http://localhost'});let local=open();
 t.after(async()=>{local.database.close();await rm(directory,{recursive:true,force:true});});
 if(birth)await local.repositories.transaction(tx=>createRetainedRepositoryCreator(local.repositories,creatorInput,scope.tenantId,tx));
 return {get local(){return local;},get repositories(){return local.repositories;},store:()=>retainedStore(local.repositories),reopen:()=>{local.database.close();local=open();return retainedStore(local.repositories);}};
}

test('full records and commands reopen from the repository, preserving business IDs, raw metadata and independent memberships',async t=>{
 const f=await fixture(t),store=f.store(),w=work(),second=work('second'),a=asset(),p=publication(),kind='content-workflow:tenant:creator:operation';
 await store.asActor('actor',async()=>{
  await store.createWork(w);await store.createWork(second);await seedAsset(store,a);
  for(const id of [w.workId,second.workId])await store.attachAssetToWork(scope.tenantId,{workId:id,assetId:a.assetId,role:'primary',position:0,caption:'Original caption'});
  await store.upsertPublication(p);await store.publicationAtomic.put(kind,'saved-operation',{id:'saved-operation',actorId:'actor',state:'accepted',draft:{id:'original-draft',opaque:{keep:true}}});
 });
 const reopened=f.reopen();assert.deepEqual(await reopened.getWork('tenant','work'),w);assert.deepEqual(await reopened.getPublication('tenant','publication'),p);assert.deepEqual(await reopened.getCanonicalAsset('tenant','asset'),a);
 assert.equal((await reopened.listCanonicalAssetsByWork('tenant','second'))[0].attachment.caption,'Original caption');
 assert.equal((await reopened.publicationAtomic.get(kind,'saved-operation')).draft.opaque.keep,true);
 assert.deepEqual((await f.repositories.works.list({limit:100})).items,[],'no compact Work copy');
 const copy=await reopened.getWork('tenant','work');copy.opaque.keep.push('mutated');assert.deepEqual((await reopened.getWork('tenant','work')).opaque.keep,['all','fields']);
});

test('retained birth refuses existing Creators and ordinary repositories cannot become a parallel writer',async t=>{
 const f=await fixture(t),repo=f.repositories;
 await assert.rejects(repo.transaction(tx=>createRetainedRepositoryCreator(repo,creatorInput,'tenant',tx)),{code:'retained_content_invalid'});
 for(const [name,value] of [['works',{id:'compact-work',...creatorInput,creatorId:'creator',title:'Must not write',status:'draft'}],['assets',{id:'compact-asset',...creatorInput,creatorId:'creator',mimeType:'image/png',checksum:'x',objectVersion:'v1',status:'ready'}],['collections',{id:'compact-collection',...creatorInput,creatorId:'creator',title:'Must not write'}]]){
  await assert.rejects(repo[name].create(value),{code:'creator_content_authority_conflict'});assert.deepEqual((await repo[name].list({limit:100})).items,[]);
 }
 const creator=await repo.creators.get('creator');await assert.rejects(repo.creators.update('creator',creator.revision,{contentAuthority:undefined}),{code:'creator_content_authority_conflict'});await assert.rejects(repo.creators.remove('creator',creator.revision),{code:'creator_content_authority_conflict'});
});

test('genuine birth seeds complete host entities and its cohort once, with normal guarded edits after reopen',async t=>{
 const f=await fixture(t,false),initial=[{kind:'settings',key:'state',value:{tenantId:'tenant',creatorId:'creator',revision:0,custom:[],opaque:{preserve:['full','JSON']}}},{kind:'host-origin',key:'birth',value:{protocol:'actual-new-creator'}}];
 const created=await f.repositories.transaction(tx=>createRetainedRepositoryCreator(f.repositories,creatorInput,'tenant',tx,initial));assert.equal(created.revision,1);
 initial[0].value.opaque.preserve.push('external mutation');
 const rows=(await f.repositories.hostRecords.list({limit:100})).items;assert.equal(rows.length,3);assert.ok(rows.every(row=>row.revision===1));
 const reopened=f.reopen(),saved=await reopened.getRetainedEntity('settings','state');assert.deepEqual(saved.opaque,{preserve:['full','JSON']});assert.equal((await reopened.getRetainedEntity('host-origin','birth')).protocol,'actual-new-creator');
 await reopened.asActor('actor',()=>reopened.putRetainedEntity('settings','state',{...saved,revision:1,custom:['A real later edit']}));assert.equal((await reopened.getRetainedEntity('settings','state')).revision,1);
 await assert.rejects(f.repositories.transaction(tx=>createRetainedRepositoryCreator(f.repositories,creatorInput,'tenant',tx,initial)),{code:'retained_content_invalid'});
 assert.deepEqual(await reopened.getRetainedEntity('settings','state'),{...saved,revision:1,custom:['A real later edit']});
});

test('invalid or duplicate birth entities fail before any identity or cohort write',async t=>{
 for(const initial of [null,{},[{kind:'',key:'x',value:{}}],[{kind:'x',key:'',value:{}}],[{kind:'x',key:'x',value:[]}],[{kind:'x',key:'x',value:{tenantId:'foreign'}}],[{kind:'x',key:'x',value:{creatorId:'foreign'}}],[{kind:'x',key:'x',value:{}},{kind:'x',key:'x',value:{different:true}}]]){
  const f=await fixture(t,false);await assert.rejects(f.repositories.transaction(tx=>createRetainedRepositoryCreator(f.repositories,creatorInput,'tenant',tx,initial)),{code:'retained_content_invalid'});assert.deepEqual((await f.repositories.creators.list({limit:100})).items,[]);assert.deepEqual((await f.repositories.hostRecords.list({limit:100})).items,[]);
 }
});

test('a failed initial entity or later enclosing intake step rolls back identity and all initial cohort records',async t=>{
 for(const stage of ['entity','enclosing']){
  const f=await fixture(t,false),repository=f.repositories.hostRecords,save=repository.create.bind(repository);
  if(stage==='entity')repository.create=async(row,options)=>{if(row.value?.kind==='second')throw Error('Synthetic initial entity outage');return save(row,options);};
  try{await assert.rejects(f.repositories.transaction(async tx=>{await createRetainedRepositoryCreator(f.repositories,creatorInput,'tenant',tx,[{kind:'first',key:'state',value:{original:true}},{kind:'second',key:'state',value:{original:true}}]);throw Error('Synthetic later intake outage');}),/Synthetic/);}finally{repository.create=save;}
  assert.deepEqual((await f.repositories.creators.list({limit:100})).items,[]);assert.deepEqual((await f.repositories.hostRecords.list({limit:100})).items,[]);
 }
});

test('legacy content without a cohort is unavailable for migration, never an invented empty history',async t=>{
 const f=await fixture(t,false);await f.repositories.creators.create(creatorInput);await f.repositories.works.create({...creatorInput,id:'legacy-work',creatorId:'creator',title:'Retained legacy subject',status:'draft'});
 await assert.rejects(f.store().listWorksByCreator('tenant','creator'),{code:'retained_content_migration_required'});assert.equal((await f.repositories.works.get('legacy-work')).title,'Retained legacy subject');
 await assert.rejects(f.repositories.transaction(tx=>createRetainedRepositoryCreator(f.repositories,creatorInput,'tenant',tx)),{code:'retained_content_invalid'});
 assert.equal((await f.repositories.hostRecords.list({limit:100})).items.length,0);
});

test('writes need a current actor, tenant matches and failed nested operations poison the entire acceptance',async t=>{
 const f=await fixture(t),store=f.store();await assert.rejects(store.createWork(work()),{code:'access_denied'});
 await assert.rejects(store.asActor('revoked',()=>store.createWork(work())),{code:'access_denied'});
 await assert.rejects(store.asActor('actor',async()=>{await store.createWork(work());await store.createWork(work('foreign',{tenantId:'other'}));}));
 await assert.rejects(store.asActor('actor',async()=>{await store.createWork(work());try{await store.commitWorkRevision(work('missing',{revision:2}),1);}catch{}await store.putRetainedEntity('audit','must-rollback',{message:'No partial acceptance'});}));
 assert.deepEqual(await store.listWorksByCreator('tenant','creator'),[]);assert.equal(await store.getRetainedEntity('audit','must-rollback'),undefined);
});

test('replacement retires only this Work membership and checks the original source evidence atomically',async t=>{
 const f=await fixture(t),store=f.store(),old=asset(),replacement=asset('replacement');
 await store.asActor('actor',async()=>{for(const id of ['work','second'])await store.createWork(work(id));await seedAsset(store,old);for(const id of ['work','second'])await store.attachAssetToWork('tenant',{workId:id,assetId:old.assetId,position:0,role:'primary'});await store.putRetainedEntity('source-file',replacement.assetId,{fileId:replacement.assetId,creatorId:'creator',storageKey:replacement.storage.objectKey,uploadState:'ready',revision:1});});
 const input={work:work('work',{revision:2,primaryAssetId:replacement.assetId}),previousRevision:1,asset:replacement,attachment:{workId:'work',assetId:replacement.assetId,position:0,role:'primary'},replacement:{previousAsset:old}};
 await assert.rejects(store.asActor('actor',()=>store.commitAssetAttachment({...input,sourceFileGuard:{file:{fileId:'changed'}}})));
 assert.equal((await store.getWork('tenant','work')).revision,1);assert.equal(await store.getCanonicalAsset('tenant','replacement'),null);
 await store.asActor('actor',()=>store.commitAssetAttachment(input));
 assert.equal((await store.listCanonicalAssetsByWork('tenant','work')).find(row=>row.assetId==='asset').replacedByAssetId,'replacement');
 assert.equal((await store.listCanonicalAssetsByWork('tenant','second'))[0].replacedByAssetId,undefined);assert.equal((await store.getCanonicalAsset('tenant','asset')).replacedByAssetId,undefined);
 await assert.rejects(store.asActor('actor',()=>store.commitAssetAttachment(input)));assert.equal((await store.listCanonicalAssetsByWork('tenant','work')).length,2);
});

test('shared metadata revisions are conditional as one batch and inventory paging retains deleted-row cursor positions',async t=>{
 const f=await fixture(t),store=f.store();await store.asActor('actor',async()=>{await store.createWork(work('a',{status:'deleted'}));await store.createWork(work('b'));});
 const page=await store.listUbeeqWorksPage('tenant','creator',{limit:1});assert.deepEqual(page.items,[]);assert.deepEqual(page.next,{updatedAt:at,workId:'a'});assert.equal((await store.listUbeeqWorksPage('tenant','creator',{limit:1,after:page.next})).items[0].workId,'b');
 await assert.rejects(store.asActor('actor',()=>store.commitSharedWorkRevisions([{work:work('a',{revision:2}),expectedRevision:1},{work:work('b',{revision:3}),expectedRevision:2}])));assert.equal((await store.getWork('tenant','a')).revision,1);
 await store.asActor('actor',()=>store.commitSharedWorkRevisions([{work:work('a',{revision:2}),expectedRevision:1},{work:work('b',{revision:2}),expectedRevision:1}]));assert.equal((await store.getWork('tenant','b')).revision,2);
});

test('publication observation updates provider data only, preserving full historical and command fields',async t=>{
 const f=await fixture(t),store=f.store(),p=publication();await store.asActor('actor',async()=>{await store.createWork(work());await store.upsertPublication(p);});
 assert.equal(await store.asActor('actor',()=>store.claimPublicationState({...p,status:'removed'},p)),false);
 assert.equal(await store.asActor('actor',()=>store.claimPublicationState(p,{...p,status:'removed',providerData:{remoteGallery:['observed']}},2)),false);
 assert.equal(await store.asActor('actor',()=>store.claimPublicationState(p,{...p,status:'removed',providerData:{remoteGallery:['observed']}},1)),true);
 assert.deepEqual(await store.getPublication('tenant','publication'),{...p,providerData:{remoteGallery:['observed']}});
});

test('missing raw inventory rows cause reconciliation instead of silently deleting retained history',async t=>{
 const f=await fixture(t),store=f.store();await store.asActor('actor',()=>store.createWork(work()));
 const row=(await f.repositories.hostRecords.snapshot()).items.find(row=>row.value.kind==='works');await f.repositories.hostRecords.remove(row.id,row.revision);
 await assert.rejects(store.getWork('tenant','work'),{code:'retained_content_invalid'});
});


test('a corrupt ownerless Work is rejected instead of disappearing from Creator inventory',async t=>{
 const f=await fixture(t),store=f.store();await store.asActor('actor',()=>store.createWork(work()));
 const row=(await f.repositories.hostRecords.snapshot()).items.find(row=>row.value.kind==='works');
 // Exercise the still-supported original schema1 owner predicate. New inline
 // corruption/checksum controls live in retained-physical-records.test.mjs.
 const value={schemaVersion:1,category:row.value.category,kind:row.value.kind,key:row.value.key,payload:JSON.parse(row.value.json)};delete value.payload.creatorId;
 await f.repositories.hostRecords.update(row.id,row.revision,{value});
 await assert.rejects(store.listWorksByCreator('tenant','creator'),{code:'retained_content_invalid'});
});

test('wrapped repositories retain real host overrides and reject foreign transaction handles',async t=>{
 const f=await fixture(t,false),repo=f.repositories;await repo.creators.create(creatorInput);
 const update=repo.creators.update.bind(repo.creators);let calls=0;
 repo.creators.update=async(...args)=>{calls++;return update(...args);};
 const creator=await repo.creators.update('creator',1,{displayName:'Renamed'});assert.equal(calls,1);assert.equal(creator.displayName,'Renamed');
 await assert.rejects(repo.creators.update('creator',creator.revision,{displayName:'Wrong scope'},{transaction:{id:'foreign'}}),/not active/);assert.equal((await repo.creators.get('creator')).displayName,'Renamed');
});

const entitySource=()=>({tenantId:'tenant',creatorId:'creator',externalPublicationId:'publication',externalAccountId:'connection',externalContentId:'pending:publication',assetId:'work',createdAt:at,updatedAt:at,rawMetadataJson:{nested:{all:['original','fields']},requested:false},opaque:{retain:true}});
const entityTarget=value=>({...value,externalContentId:'actual-remote',updatedAt:'2026-11-15T00:01:00.000Z',rawMetadataJson:{...value.rawMetadataJson,observed:{id:'actual-remote'}}});

test('conditional entity move preserves full JSON across restart and updates only the same canonical cohort',async t=>{
 const f=await fixture(t),store=f.store(),source=entitySource(),next=entityTarget(source),kind='compatibility-publication';
 await store.asActor('actor',()=>store.putRetainedEntity(kind,'pending-key',{...source,notStored:undefined}));
 const before=(await f.repositories.hostRecords.snapshot()).items.filter(row=>row.namespace==='retained-creator-content');
 await store.asActor('actor',async()=>{
  await store.moveRetainedEntity({kind,fromKey:'pending-key',toKey:'remote-key',expected:{opaque:source.opaque,...source,notStored:undefined},next});
  assert.equal(await store.getRetainedEntity(kind,'pending-key'),undefined);assert.deepEqual(await store.getRetainedEntity(kind,'remote-key'),next);
 });
 const reopened=f.reopen();assert.equal(await reopened.getRetainedEntity(kind,'pending-key'),undefined);assert.deepEqual(await reopened.getRetainedEntity(kind,'remote-key'),next);
 const rows=(await f.repositories.hostRecords.snapshot()).items.filter(row=>row.namespace==='retained-creator-content');
 assert.equal(rows.length,before.length,'Move creates no competing operation receipt or second source copy.');
 assert.equal(rows.filter(row=>row.value.category==='entity'&&row.value.kind===kind).length,1);
 assert.ok(rows.find(row=>row.key==='cohort').revision>before.find(row=>row.key==='cohort').revision);
});

test('entity moves/removals conflict on stale full JSON, missing source, occupied matching target and repeated calls',async t=>{
 const f=await fixture(t),store=f.store(),source=entitySource(),next=entityTarget(source),kind='compatibility-publication';
 await store.asActor('actor',async()=>{await store.putRetainedEntity(kind,'old',source);await store.putRetainedEntity(kind,'occupied',next);});
 const conflict={code:'retained_entity_conflict',status:409};
 await assert.rejects(store.asActor('actor',()=>store.moveRetainedEntity({kind,fromKey:'old',toKey:'new',expected:{...source,opaque:{retain:false}},next})),conflict);
 await assert.rejects(store.asActor('actor',()=>store.moveRetainedEntity({kind,fromKey:'old',toKey:'occupied',expected:source,next})),conflict);
 await assert.rejects(store.asActor('actor',()=>store.removeRetainedEntity({kind,key:'old',expected:{...source,rawMetadataJson:{}}})),conflict);
 await assert.rejects(store.asActor('actor',()=>store.moveRetainedEntity({kind,fromKey:'old',toKey:'old',expected:source,next:source})),{code:'retained_entity_invalid',status:400});
 assert.deepEqual(await store.getRetainedEntity(kind,'old'),source);assert.equal(await store.getRetainedEntity(kind,'new'),undefined);
 await store.asActor('actor',()=>store.moveRetainedEntity({kind,fromKey:'old',toKey:'new',expected:source,next}));
 await assert.rejects(store.asActor('actor',()=>store.moveRetainedEntity({kind,fromKey:'old',toKey:'new',expected:source,next})),conflict);
 await store.asActor('actor',()=>store.removeRetainedEntity({kind,key:'new',expected:next}));
 await assert.rejects(store.asActor('actor',()=>store.removeRetainedEntity({kind,key:'new',expected:next})),conflict);
 assert.deepEqual(await store.getRetainedEntity(kind,'occupied'),next,'An unrelated occupied entity is retained.');
});

test('entity commands require current actor/scope and a rejected nested move rolls back canonical writes and the whole cohort',async t=>{
 const f=await fixture(t),store=f.store(),source=entitySource(),next=entityTarget(source),kind='compatibility-publication';
 await store.asActor('actor',()=>store.putRetainedEntity(kind,'old',source));
 await assert.rejects(store.moveRetainedEntity({kind,fromKey:'old',toKey:'new',expected:source,next}),{code:'access_denied'});
 await assert.rejects(store.asActor('outsider',()=>store.removeRetainedEntity({kind,key:'old',expected:source})),{code:'access_denied'});
 for(const changed of [{...next,tenantId:'foreign'},{...next,creatorId:'foreign'},Object.fromEntries(Object.entries(next).filter(([key])=>key!=='creatorId'))])await assert.rejects(store.asActor('actor',()=>store.moveRetainedEntity({kind,fromKey:'old',toKey:'new',expected:source,next:changed})),{code:'retained_entity_invalid'});
 const before=(await f.repositories.hostRecords.snapshot()).items;
 await assert.rejects(store.asActor('actor',async()=>{await store.createWork(work());await store.moveRetainedEntity({kind,fromKey:'old',toKey:'new',expected:source,next});throw Error('Synthetic outer failure after complete staging');}),/outer failure/);
 assert.deepEqual((await f.repositories.hostRecords.snapshot()).items,before);assert.equal(await store.getWork('tenant','work'),null);
 for(const failure of ['stale move','occupied target','stale removal']){
  await assert.rejects(store.asActor('actor',async()=>{
   await store.createWork(work());
   if(failure==='occupied target')await store.putRetainedEntity(kind,'occupied',next);
   // Call/catch the actual public conditional command directly. No explicit
   // run wrapper around the failed call may hide a missing rollback-only mark.
   if(failure==='stale removal')await assert.rejects(store.removeRetainedEntity({kind,key:'old',expected:{}}),{code:'retained_entity_conflict'});
   else await assert.rejects(store.moveRetainedEntity({kind,fromKey:'old',toKey:failure==='occupied target'?'occupied':'new',expected:failure==='stale move'?{...source,externalTitle:'Stale observed title'}:source,next}),{code:'retained_entity_conflict'});
  }),/failed or unawaited/);
  assert.deepEqual((await f.repositories.hostRecords.snapshot()).items,before,'Caught '+failure+' must roll back all preceding canonical/entity changes.');
  assert.equal(await store.getWork('tenant','work'),null);assert.deepEqual(await store.getRetainedEntity(kind,'old'),source);
 }

 await store.asActor('actor',async()=>{await store.removeRetainedEntity({kind,key:'old',expected:source});await store.createWork(work());});
 assert.equal(await store.getRetainedEntity(kind,'old'),undefined);assert.equal((await store.getWork('tenant','work')).title,work().title);
});
