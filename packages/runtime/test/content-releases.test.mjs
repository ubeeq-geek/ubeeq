import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {installSqliteRetainedContentAtomic} from '@ubeeq/adapter-local';
import {publicationIdentityHash} from '@ubeeq/persistence';
import {announcementDestinationKey,contentAnnouncementTrigger,defaultContentPreparation} from '@ubeeq/core';
import {ContentReleaseService} from '../dist/content-releases.js';
import {ContentWorkflowService} from '../dist/content-preparations.js';
import {createContentPreparationWorker} from '../dist/content-worker.js';
const at='2026-11-15T00:00:00.000Z',tenant='tenant',creatorId='creator',actorId='original-owner';
const kind=(id,suffix='draft')=>`content-workflow:${tenant}:${id}:${suffix}`;
const creator={creatorId,status:'active',slug:'creator',name:'Creator'};
const work={tenantId:tenant,creatorId,workId:'work',kind:'article',status:'draft',title:'Retained text',slug:'text',slugHistory:['text'],tags:[],body:[{blockId:'text',type:'paragraph',text:'Approved text'}],contentRating:'general',aiDisclosure:'none',heavyTopics:[],origin:{type:'manual'},revision:1,createdAt:at,updatedAt:at,opaque:{retained:['full host metadata']}};
class HostStore {
 creators=[creator];works=[work];members=[{userId:actorId,role:'owner'}];publications=[];intents=[];discovery=[];failIntent=false;
 async listCreators(){return this.creators;}
 async getCreatorById(id){return this.creators.find(c=>c.creatorId===id)??null;}
 async getWork(t,id){return this.works.find(w=>w.tenantId===t&&w.workId===id)??null;}
 async listCreatorMembers(){return this.members;}
 async getPlatformRoleAssignment(){return null;}
 async listPublicationsByWork(t,id){return this.publications.filter(p=>p.tenantId===t&&p.workId===id);}
 async listCreatorCollections(){return [];}
 async getWorkDiscoveryParticipation(t,id){return this.discovery.find(d=>d.tenantId===t&&d.workId===id)??null;}
 async listPublicationIntentsByWork(t,id){return this.intents.filter(p=>p.tenantId===t&&p.workId===id);}
 async upsertPublicationIntent(value){if(this.failIntent){this.failIntent=false;throw Error('Synthetic storage interruption');}this.intents=this.intents.filter(i=>i.publicationIntentId!==value.publicationIntentId).concat(value);}
 async upsertWorkDiscoveryParticipation(value){this.discovery=this.discovery.filter(d=>d.workId!==value.workId).concat(value);}
}
const names=['isNativeDestination','nativeWorkDestination','nativeCollectionDestination','nativeWorkAnnouncementBinding','nativeCollectionAnnouncementBinding','collection','announcement','contentPublishing','resolvedContentOffer','validateNativeCollectionOffer','communityActorAllowed','announcementRules','announcementDestinations','announcementKnownLinks','parseAnnouncement','validateAnnouncement','announcementDocumentForDestination','stageAnnouncementMedia','pinCollectionAnnouncementMedia','activateAnnouncementMedia','readStagedAnnouncementMedia','readAnnouncementFile','readAnnouncementImage','evaluatePublicationPolicy','nativeWorkPublication','resolvedCollectionMembers','evaluateNativeCollectionPublication','announcementPlans','captureCollectionReleaseRequirements','readOrchestrationValue'];
const unused=()=>{throw Error('Fixture does not install this unexercised provider capability');};
async function fixture(t){
 const directory=mkdtempSync(join(tmpdir(),'shared-content-release-')),path=join(directory,'state.sqlite'),open=[];
 t.after(()=>{for(const db of open)db.close();rmSync(directory,{recursive:true,force:true});});
 const attach=()=>{const store=new HostStore();const db=installSqliteRetainedContentAtomic(store,path,{fields:['creators','works','members','publications','intents','discovery'],savePublication:async value=>{store.publications=store.publications.filter(p=>p.publicationId!==value.publicationId).concat(value);}});open.push(db);return store;};
 const make=store=>{
  const workflows={store,config:{tenantId:tenant,appOrigin:'https://example.test'},kind,get:(id,draft)=>store.publicationAtomic.get(kind(id),draft),list:async()=>[],recover:async()=>{},target:async(id,ref)=>{const row=await store.getWork(tenant,ref.id);assert.equal(row.creatorId,id);assert.equal(row.revision,ref.revision);return row;},review:unused};
  const host=Object.fromEntries(names.map(name=>[name,unused]));
  Object.assign(host,{isNativeDestination:destination=>destination==='configured-native',nativeWorkDestination:()=>'configured-native',contentPublishing:()=>undefined,communityActorAllowed:async(actor,id)=>id===creatorId&&(await store.listCreatorMembers(id)).some(m=>m.userId===actor),announcementRules:async()=>({revision:1}),evaluatePublicationPolicy:async()=>({allowed:true}),nativeWorkPublication:(w,existing,input)=>({...existing,tenantId:w.tenantId,creatorId:w.creatorId,workId:w.workId,publicationId:existing?.publicationId??'publication',destination:'configured-native',status:'live',visibility:input.visibility,metadataOverrides:input.metadata,providerData:input.providerData,sync:{localRevision:w.revision},createdAt:at,updatedAt:input.now})});
  const representations={full:unused,previews:unused,read:unused};
  return {service:new ContentReleaseService(workflows,async()=>true,host,representations),workflows,host,representations};
 };
 const store=attach(),output={schemaVersion:1,id:'approved-output',subject:{kind:'work',id:'work',revision:1},kind:'full',assets:[],body:structuredClone(work.body)};
 const draft={id:'draft',schemaVersion:1,tenantId:tenant,creatorId,actorId,revision:1,state:'accepted',title:'Retained text',entry:{intent:'work'},checkpoint:'review',arrangement:'work',arrangementConfirmed:true,collectionType:'collection',objects:[],previews:[],operationIds:[],units:[output.subject],settings:{...defaultContentPreparation(),access:'free',announce:{...defaultContentPreparation().announce,mode:'off',destinationIds:[]},publishDestinations:[{destination:'configured-native',representation:'full',required:true}]},createdAt:at,updatedAt:at};
 const release={id:'release',draftId:draft.id,creatorId,actorId,revision:1,reviewId:'release',fingerprint:'exact-review',state:'accepted',creatorFingerprint:publicationIdentityHash(await store.getCreatorById(creatorId)),blockRulesRevision:1,createdAt:at,publicationFingerprints:{work:publicationIdentityHash([])},outputs:[output],completed:[]};
 await store.publicationAtomic.run(async()=>{await store.publicationAtomic.put(kind(creatorId),draft.id,draft);await store.publicationAtomic.put(kind(creatorId,'release'),release.id,release);});
 return {store,attach,make,release,draft};
}

test('accepted release recovers from SQLite on another host, commits once, retains the full Work and uses its configured native identity',async t=>{
 const f=await fixture(t),reopened=f.attach();await f.make(reopened).service.tick();
 const status=await f.make(f.store).service.status(creatorId,'release');assert.equal(status.state,'completed');assert.equal(status.completed,1);
 await f.make(f.attach()).service.tick();assert.equal((await f.store.listPublicationsByWork(tenant,'work')).length,1);assert.equal((await f.store.listPublicationIntentsByWork(tenant,'work')).length,1);
 const publication=(await f.store.listPublicationsByWork(tenant,'work'))[0];assert.equal(publication.destination,'configured-native');assert.deepEqual(publication.providerData.contentRepresentation.manifest.body,work.body);assert.deepEqual((await f.store.getWork(tenant,'work')).opaque,work.opaque);assert.equal((await f.store.getWork(tenant,'work')).status,'draft');
});

test('restart recovery rechecks the saved actor rather than borrowing the worker identity',async t=>{
 const f=await fixture(t);await f.store.publicationAtomic.run(async()=>{f.store.members=[];});
 const worker=f.make(f.attach());await worker.service.tick();const status=await worker.service.status(creatorId,'release');assert.equal(status.state,'needs_review');assert.match(status.error,/Publishing access changed/);assert.equal(status.completed,0);assert.deepEqual(await f.store.listPublicationsByWork(tenant,'work'),[]);
});

test('a failure after publication construction rolls back the canonical write and child receipt together',async t=>{
 const f=await fixture(t);f.store.failIntent=true;await f.make(f.store).service.run(creatorId,'release');const reloaded=f.attach(),status=await f.make(reloaded).service.status(creatorId,'release');assert.equal(status.state,'needs_review');assert.match(status.error,/Synthetic storage interruption/);assert.equal(status.completed,0);assert.deepEqual(await reloaded.listPublicationsByWork(tenant,'work'),[]);assert.deepEqual(await reloaded.listPublicationIntentsByWork(tenant,'work'),[]);
});

test('cancellation survives a provider cancellation failure and recovery retries only the cancellation',async t=>{
 const f=await fixture(t),commands=[{id:'reviewed-provider-command',requirements:[]}];await f.store.publicationAtomic.run(async()=>{await f.store.publicationAtomic.put(kind(creatorId,'release'),'release',{...f.release,connected:commands});});
 let attempts=0;const cancellations={cancel:async(id,actor,values)=>{attempts++;assert.equal(id,'release');assert.equal(actor,actorId);assert.deepEqual(values,commands);if(attempts===1)throw Error('Provider cancellation temporarily unavailable');},dispatch:unused};
 const current=f.make(f.store);current.host.contentPublishing=()=>cancellations;await assert.rejects(current.service.cancel(creatorId,'release',1),/temporarily unavailable/);
 const reopened=f.attach(),worker=f.make(reopened);worker.host.contentPublishing=()=>cancellations;await worker.service.tick();await worker.service.tick();assert.equal(attempts,2);
 const release=await reopened.publicationAtomic.get(kind(creatorId,'release'),'release');assert.equal(release.state,'cancelled');assert.equal(release.cancellationPending,false);assert.equal((await reopened.publicationAtomic.get(kind(creatorId),'draft')).state,'draft');assert.deepEqual(await reopened.listPublicationsByWork(tenant,'work'),[]);
});

test('missing real host capabilities cannot create an accepted release service',async t=>{
 const f=await fixture(t),current=f.make(f.store);for(const name of names)assert.throws(()=>new ContentReleaseService(current.workflows,async()=>true,{...current.host,[name]:undefined},current.representations),error=>error.code==='unsupported_operation'&&error.status===503);
 assert.deepEqual(await f.store.listPublicationsByWork(tenant,'work'),[]);
});


test('hosts without durable release storage can initialize while release access still fails closed',async t=>{
 const f=await fixture(t),current=f.make(f.store),base=f.store.publicationAtomic;
 const unavailable=[undefined,{...base,supportsConditionalTransactions:false},...['run','get','list','put','savePublication','active'].map(name=>({...base,[name]:undefined}))];
 for(const atomic of unavailable){
  const store=Object.create(f.store);Object.defineProperty(store,'publicationAtomic',{value:atomic});
  const service=new ContentReleaseService({...current.workflows,store},async()=>true,current.host,current.representations);
  assert.equal((await store.getCreatorById(creatorId)).name,'Creator');
  for(const operation of [()=>service.run(creatorId,'release'),()=>service.cancel(creatorId,'release',1)])await assert.rejects(operation,error=>error.code==='unsupported_operation'&&error.status===503);
 }
 assert.deepEqual(await f.store.listPublicationsByWork(tenant,'work'),[]);
 assert.deepEqual((await base.get(kind(creatorId,'release'),'release')).completed,[]);
});

test('bounded release polling skips future schedules and stops after one durable due command',async t=>{
 const f=await fixture(t),current=f.make(f.store),future={...f.release,id:'future',scheduledAt:new Date(Date.now()+3600000).toISOString()};
 await f.store.publicationAtomic.run(()=>f.store.publicationAtomic.put(kind(creatorId,'release'),future.id,future));
 const result=await current.service.runNextJob();assert.equal(result.kind,'content-release');assert.equal(result.id,'release');assert.equal(result.state,'completed');
 assert.equal((await f.store.publicationAtomic.get(kind(creatorId,'release'),'future')).state,'accepted');
 assert.equal(await current.service.runNextJob(),undefined);
 assert.equal((await f.store.listPublicationsByWork(tenant,'work')).length,1);
});

test('bounded release polling retains revoked actor and malformed schedule denials in the durable review state',async t=>{
 for(const failure of ['actor','schedule']){
  const f=await fixture(t);
  await f.store.publicationAtomic.run(async()=>{
   if(failure==='actor')f.store.members=[];
   else await f.store.publicationAtomic.put(kind(creatorId,'release'),'release',{...f.release,scheduledAt:'not-a-time'});
  });
  const current=f.make(f.attach()),result=await current.service.runNextJob();assert.equal(result.state,'needs_review');
  const status=await current.service.status(creatorId,'release');assert.match(status.error,failure==='actor'?/Publishing access changed/:/release time is invalid/);
  assert.deepEqual(await f.store.listPublicationsByWork(tenant,'work'),[]);assert.equal(await current.service.runNextJob(),undefined);
 }
});

function joinedWorker(f){
 const current=f.make(f.store);
 const preparationHost=actor=>{
  const allowed=async id=>id===creatorId&&(await f.store.listCreatorMembers(id)).some(member=>member.userId===actor);
  return {authorizeCreator:allowed,canManageCollections:allowed,recoveryAuthorization:preparationHost,defaultSettings:defaultContentPreparation,inspectOriginal:unused,captureSetup:unused,contentMetadataWork:unused,validateCollectionVolumes:unused,resolvedCollectionMembers:unused,recordImageCompatibility:unused};
 };
 const workflows=new ContentWorkflowService(f.store,{tenantId:tenant},preparationHost(actorId));
 const releases=new ContentReleaseService(workflows,async()=>true,current.host,current.representations),worker=createContentPreparationWorker(workflows,releases);
 return {workflows,releases,worker};
}

test('one shared worker drains actual preparation and release services against the same SQLite authority',async t=>{
 const f=await fixture(t),{workflows,releases,worker}=joinedWorker(f);
 assert.throws(()=>createContentPreparationWorker({...workflows,recoverNext:workflows.recoverNext.bind(workflows)},releases),/same workflow and release authority/);
 const result=await worker.runNextJob('worker-is-not-the-saved-actor');assert.equal(result.kind,'content-release');assert.equal(result.state,'completed');
 assert.equal((await f.store.listPublicationsByWork(tenant,'work')).length,1);assert.equal(await worker.runNextJob('retry'),undefined);
 assert.deepEqual((await f.store.getWork(tenant,'work')).opaque,work.opaque);
});


test('cold-start recovery denial cannot starve a separately authorized due release',async t=>{
 const f=await fixture(t),blocked={...f.draft,id:'blocked',actorId:'revoked-actor'};
 await f.store.publicationAtomic.run(async()=>{
  await f.store.publicationAtomic.put(kind(creatorId),blocked.id,blocked);
  await f.store.publicationAtomic.put(kind(creatorId,'operation'),'blocked-save',{id:'blocked-save',state:'accepted',draft:blocked});
 });
 const {worker}=joinedWorker(f),result=await worker.runNextJob('a-new-worker');
 assert.equal(result.kind,'content-release');assert.equal(result.state,'completed');
 assert.equal((await f.store.publicationAtomic.get(kind(creatorId),blocked.id)).state,'accepted');
 assert.equal((await f.store.listPublicationsByWork(tenant,'work')).length,1);
 await assert.rejects(worker.runNextJob('next-poll'),/access denied/i);
});


// Neutral host PROTOCOL tests. SQLite is the actual durable accepting authority;
// materialization/admission/visibility are explicit host-boundary unit commands.
// These tests claim no Native, physical-public-media or external-provider acceptance.
async function activationFixture(t){
 const f=await fixture(t),binding={provider:'unit-community',accountId:'account',connectionId:'connection',targetId:'channel',postType:'message'},destination={communityDestinationId:'channel',destinationKey:announcementDestinationKey(binding),displayName:'Unit channel',available:true,binding},settings={...f.draft.settings,announce:{...f.draft.settings.announce,mode:'after_publication',destinationIds:['channel']}};
 const trigger=contentAnnouncementTrigger(settings.announce,[{binding,settings:{destinationId:'channel'}}],'native'),release={...f.release,announcementActivationProtocol:1,announcementTrigger:trigger};
 await f.store.publicationAtomic.run(async()=>{await f.store.publicationAtomic.put(kind(creatorId),f.draft.id,{...f.draft,settings});await f.store.publicationAtomic.put(kind(creatorId,'release'),release.id,release);await f.store.publicationAtomic.put('unit-policy','current',{enabled:true,revision:1});});
 const control={failOwnership:false,failMaterialized:false,failAdmission:false,loseActivationReply:false,failFinalGuard:false,activationCalls:0},reads=[];
 const compose=store=>{const current=f.make(store),atomic=store.publicationAtomic;
  store.getCollectionOrganization=async()=>({revision:0,publications:[]});store.getAnnouncementOrchestration=async()=>null;
  store.commitAnnouncementOrchestration=async commit=>{assert.ok(atomic.active());await atomic.put('unit-original-plan',commit.id,commit);if(control.failOwnership)throw Error('Real ownership transaction rejected');return true;};
  current.host.announcementDestinations=async()=>[destination];current.host.nativeWorkAnnouncementBinding=()=>binding;current.host.collection=value=>value;current.host.announcementPlans=()=>({scope:()=>({tenantId:tenant,creatorId}),prepareRelease:async input=>({id:'original-plan',originalInput:input})});
  current.host.prepareAnnouncementMediaAcceptance=async files=>{assert.equal(atomic.active(),false);const fingerprint=publicationIdentityHash(files);return{async enlist(){assert.ok(atomic.active());reads.push(fingerprint);}};};
  current.host.announcementActivation={stageOwnership(commit,input){return{commit:{...commit,releaseIdentity:input},ownership:{schemaVersion:1,fingerprint:publicationIdentityHash([commit,input]),references:[{kind:'plan',id:commit.id,revision:1,fingerprint:publicationIdentityHash(commit)}]}};},async prepare(input){
   assert.equal(atomic.active(),false);const plan=await atomic.get('unit-original-plan','original-plan');assert.ok(plan);assert.equal(plan.releaseIdentity.releaseId,input.releaseId);
   await atomic.run(async()=>{const old=await atomic.get('unit-authoring','canonical-announcement');if(!old)await atomic.put('unit-authoring','canonical-announcement',{id:'canonical-announcement',originalPlanId:plan.id,body:work.body,ownedMedia:input.files,revision:1});});
   const author=await atomic.get('unit-authoring','canonical-announcement');if(control.failMaterialized)throw Error('Interruption after actual durable materialization');if(control.failAdmission)throw Error('Current exact resource admission denied');
   const resource={kind:'announcement',id:author.id,revision:String(author.revision),contentFingerprint:publicationIdentityHash(author),destination:'unit-community'};
   return{resources:[resource],activeMediaKeys:[],deferredMediaKeys:input.files.map(file=>file.mediaKey),async enlist(){assert.ok(atomic.active());assert.deepEqual(await atomic.get('unit-authoring',author.id),author);assert.equal((await atomic.get('unit-policy','current')).enabled,true);assert.ok((await store.listCreatorMembers(creatorId)).some(member=>member.userId===actorId));if(control.failFinalGuard&&await atomic.get('unit-visibility',author.id))throw Error('Late exact accepting guard failed');},async activate(){assert.equal(atomic.active(),false);control.activationCalls++;await atomic.run(async()=>{const old=await atomic.get('unit-visibility',author.id);if(old)assert.equal(old.fingerprint,resource.contentFingerprint);else await atomic.put('unit-visibility',author.id,{id:author.id,fingerprint:resource.contentFingerprint});});if(control.loseActivationReply)throw Error('Lost unit visibility acceptance reply');}};
  }};
  return{...current,service:new ContentReleaseService(current.workflows,async()=>true,current.host,current.representations,{async tick(){const stored=await atomic.get(kind(creatorId,'release'),release.id);assert.equal(stored.state,'completed');assert.equal(stored.announcementActivation.phase,'media_activated');await atomic.run(async()=>{if(!await atomic.get('unit-dispatch',stored.id))await atomic.put('unit-dispatch',stored.id,{resourceId:'canonical-announcement'});});}})};
 };
 return{...f,release,control,compose,reads};
}

test('strong ordering rolls ownership rejection back before materialization or visibility',async t=>{
 const f=await activationFixture(t);f.control.failOwnership=true;await f.compose(f.store).service.run(creatorId,'release');const reopened=f.attach(),release=await reopened.publicationAtomic.get(kind(creatorId,'release'),'release');assert.equal(release.state,'needs_review');assert.equal(release.announcementActivation,undefined);assert.equal(await reopened.publicationAtomic.get('unit-original-plan','original-plan'),undefined);assert.equal(await reopened.publicationAtomic.get('unit-authoring','canonical-announcement'),undefined);assert.equal(await reopened.publicationAtomic.get('unit-visibility','canonical-announcement'),undefined);assert.equal(f.control.activationCalls,0);f.control.failOwnership=false;await f.compose(reopened).service.resumeAnnouncementActivation(creatorId,'release');assert.equal((await reopened.publicationAtomic.get(kind(creatorId,'release'),'release')).state,'completed');
});

test('restart after materialization or denied admission keeps the original canonical resource private and resumes its exact identity',async t=>{
 for(const failure of ['failMaterialized','failAdmission']){const f=await activationFixture(t);f.control[failure]=true;await f.compose(f.store).service.run(creatorId,'release');let reopened=f.attach(),release=await reopened.publicationAtomic.get(kind(creatorId,'release'),'release'),author=await reopened.publicationAtomic.get('unit-authoring','canonical-announcement');assert.equal(release.state,'needs_review');assert.equal(release.announcementActivation.phase,'ownership_accepted');assert.ok(author);assert.equal(await reopened.publicationAtomic.get('unit-visibility',author.id),undefined);assert.equal(f.control.activationCalls,0);f.control[failure]=false;await f.compose(reopened).service.resumeAnnouncementActivation(creatorId,'release');reopened=f.attach();assert.deepEqual(await reopened.publicationAtomic.get('unit-authoring',author.id),author);release=await reopened.publicationAtomic.get(kind(creatorId,'release'),'release');assert.equal(release.state,'completed');assert.equal(release.announcementActivation.resources[0].id,author.id);assert.equal((await reopened.publicationAtomic.get('unit-dispatch','release')).resourceId,author.id);}
});

test('lost visibility reply and final accepting failure recover the same phase and never dispatch before final guards',async t=>{
 for(const failure of ['loseActivationReply','failFinalGuard']){const f=await activationFixture(t);f.control[failure]=true;await f.compose(f.store).service.run(creatorId,'release');let reopened=f.attach(),release=await reopened.publicationAtomic.get(kind(creatorId,'release'),'release'),author=await reopened.publicationAtomic.get('unit-authoring','canonical-announcement'),visibility=await reopened.publicationAtomic.get('unit-visibility',author.id);assert.equal(release.state,'needs_review');assert.equal(release.announcementActivation.phase,'admission_accepted');assert.ok(visibility);assert.equal(await reopened.publicationAtomic.get('unit-dispatch','release'),undefined);f.control[failure]=false;await f.compose(reopened).service.resumeAnnouncementActivation(creatorId,'release');reopened=f.attach();assert.deepEqual(await reopened.publicationAtomic.get('unit-authoring',author.id),author);assert.deepEqual(await reopened.publicationAtomic.get('unit-visibility',author.id),visibility);assert.equal((await reopened.publicationAtomic.get(kind(creatorId,'release'),'release')).state,'completed');assert.equal((await reopened.publicationAtomic.list('unit-dispatch')).length,1);}
});

test('an old accepted release cannot acquire fabricated ownership or activate media on read/retry',async t=>{
 const f=await activationFixture(t);await f.store.publicationAtomic.run(async()=>{const old=await f.store.publicationAtomic.get(kind(creatorId,'release'),'release');delete old.announcementActivationProtocol;await f.store.publicationAtomic.put(kind(creatorId,'release'),'release',old);});await f.compose(f.store).service.run(creatorId,'release');const reopened=f.attach(),release=await reopened.publicationAtomic.get(kind(creatorId,'release'),'release');assert.equal(release.state,'needs_review');assert.equal(release.announcementActivation,undefined);assert.match(release.error,/migration/);assert.equal(f.control.activationCalls,0);assert.equal(await reopened.publicationAtomic.get('unit-authoring','canonical-announcement'),undefined);
});
