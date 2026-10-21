import { WebsiteError } from '@ubeeq/core';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebsiteService,WebsitePublishingService,websiteDigest } from '../dist/index.js';
import { SqliteWebsiteStore,NativeWebsiteHostingAdapter,createNativeWebsiteHandler,nativeWebsiteKey } from '../../../adapters/local/dist/index.js';
import { createHostingPublicProbe } from '@ubeeq/integrations';
const actor={workspaceId:'workspace',actorId:'actor'};
async function fixture(t,{fake,enqueueFails=false,confirmQuiescent}={}){
  const dir=await mkdtemp(join(tmpdir(),'ubeeq-hosting-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const store=new SqliteWebsiteStore(join(dir,'website.sqlite'));t.after(()=>store.close());
  const site={id:'site',workspaceId:'workspace',creatorIdentityId:'creator',revision:1,title:'Approved website',locale:'en',homePageId:'home',theme:{id:'neutral',version:'1',settings:{}},galleryDefault:{destination:{mode:'manual',url:'https://example.com/'},missing:'error'},mediaMode:'bundled',basePath:'/',publicBaseUrl:'https://example.com',pages:[{id:'home',websiteId:'site',workspaceId:'workspace',revision:1,documentId:'home-doc',kind:'home',title:'Home',slug:'',order:0,state:'ready',navigation:true},{id:'about',websiteId:'site',workspaceId:'workspace',revision:1,documentId:'about-doc',kind:'page',title:'About',slug:'about',order:1,state:'ready',navigation:true}],galleryPublicationIds:[],redirects:[]};
  let text='Approved content',allowed=true,member=true,asset;let queues=[];
  const website=new WebsiteService({store,membership:async()=>member?{workspaceId:'workspace',userId:'actor',role:'owner',status:'active'}:undefined,creatorIdentityAllowed:async()=>true,capabilities:async()=>({apiVersion:'1',export:false,maxPages:30,maxAssets:100,maxBytes:2000000,deploymentAdapters:[]}),resolveSnapshot:async(_a,s)=>({apiVersion:'1',copyrightYear:2026,creatorIdentities:[s.creatorIdentityId,...s.contributingCreatorIds??[]].map(id=>({id,title:id==='guest'?'Guest':'Creator'})),website:s,documents:s.pages.map(p=>({id:p.documentId,workspaceId:'workspace',revision:1,blocks:[{id:'block-'+p.id,type:'paragraph',text},...(asset?[{id:'image-'+p.id,type:'image',assetId:asset.id}]:[])]})),assets:asset?[asset]:[],galleries:[],mappings:[],dependencies:[]}),evaluateRelease:async()=>({decision:allowed?'allow':'hold',revision:'policy1',reasons:[]}),dependenciesEligible:async()=>allowed,enqueue:async()=>{},audit:async()=>{}});
  // Documents must exist to attach the website; publication resolves independent frozen source views.
  for(const p of site.pages)await store.saveDocument({id:p.documentId,workspaceId:'workspace',revision:1,blocks:[]},0);
  await website.save(actor,site,0);
  const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(r=>server.close(r)));
  const profile={id:'vps',root:join(dir,'public-releases'),publicUrlTemplate:`http://127.0.0.1:${server.address().port}/sites/{site}/`,persistent:true,writerMode:'single'};
  const native=new NativeWebsiteHostingAdapter(profile,createHostingPublicProbe({authorizeUrl:async u=>assert.equal(u.origin,new URL(profile.publicUrlTemplate).origin)}));server.on('request',createNativeWebsiteHandler([profile]));
  const adapter=fake?fake(native):native;
  const service=new WebsitePublishingService({websites:website,store,artifacts:store,adapters:[adapter],confirmQuiescent,authorize:async a=>{assert.equal(a.actorId,'actor');if(!member)throw new Error('offboarded');},enqueue:async p=>{if(enqueueFails)throw new Error('queue down');queues.push(p);},audit:async()=>{}});
  const add=async(id)=>{const publicUrl=native.publicUrl('workspace',id);return service.configureTarget(actor,{id,workspaceId:'workspace',websiteId:'site',revision:1,label:id,adapterId:adapter.id,family:adapter.family,accountId:'vps',remoteId:nativeWebsiteKey('workspace',id),publicUrl,basePath:new URL(publicUrl).pathname,config:{},ownershipConfirmed:true},0);};
  const target=await add('target');
  const accept=async(key='key',ids=[target.id])=>{const review=await service.review(actor,'site',1,ids);return service.publish(actor,review.planId,review.fingerprint,key);};
  return {dir,store,service,website,target,native,adapter,profile,add,accept,queues,setText:v=>text=v,setAsset:v=>{const bytes=Buffer.from(v);asset={id:'public-image',workspaceId:'workspace',revision:1,checksum:websiteDigest(bytes),mimeType:'image/jpeg',bytes,approvedPublic:true,metadataStripped:true,alt:'Public image',width:1,height:1};},setAllowed:v=>allowed=v,setMember:v=>member=v};
}
test('Publish freezes approved sources, outbox survives dispatch failure, native HTTP serves nested paths and independent export permission',async t=>{
  const f=await fixture(t,{enqueueFails:true});const review=await f.service.review(actor,'site',1,['target']);f.setText('Unapproved newer draft');
  const intent=await f.service.publish(actor,review.planId,review.fingerprint,'one');assert.equal((await f.store.pendingOutbox(100)).length,1);
  assert.equal((await f.service.publish(actor,review.planId,review.fingerprint,'one')).id,intent.id);
  const attempt=await f.service.execute('workspace',intent.attemptIds[0]);assert.equal(attempt.state,'published',JSON.stringify(attempt));
  const html=await(await fetch(f.target.publicUrl)).text();assert.match(html,/Approved content/);assert.doesNotMatch(html,/Unapproved newer draft/);
  assert.equal((await fetch(f.target.publicUrl+'about/')).status,200);assert.equal((await fetch(f.target.publicUrl+'missing/')).status,404);
  assert.equal((await fetch(f.target.publicUrl+'current.json')).status,404);assert.equal((await fetch(f.target.publicUrl+'releases/'+attempt.artifactDigest+'/index.html')).status,404);
  assert.equal((await f.store.pendingOutbox(100)).length,0);assert.equal((await f.store.getTarget('workspace','target')).activeGeneration,1);
  // Read-only data plane remains available with all application services stopped/recreated.
  const disk=JSON.parse(await readFile(join(f.profile.root,'targets',f.target.remoteId,'current.json'),'utf8'));assert.equal(disk.releaseId,attempt.artifactDigest);
});
test('repeat Publish uses the same target; newer desired generation supersedes pending work; rollback and unpublish are separately approved',async t=>{
  const f=await fixture(t);const first=await f.accept('first'),second=await f.accept('second');
  assert.equal((await f.service.execute('workspace',first.attemptIds[0])).state,'superseded');
  assert.equal((await f.service.execute('workspace',second.attemptIds[0])).state,'published');
  f.setText('Second approved text');const third=await f.accept('third');assert.equal((await f.service.execute('workspace',third.attemptIds[0])).state,'published');
  const rollback=await f.service.rollback(actor,'target',second.attemptIds[0],'rollback');assert.equal((await f.service.execute('workspace',rollback.attemptIds[0])).state,'published');assert.match(await(await fetch(f.target.publicUrl)).text(),/Approved content/);
  const unpublish=await f.service.unpublish(actor,'target','remove');assert.equal((await f.service.execute('workspace',unpublish.attemptIds[0])).state,'unpublished');assert.equal((await fetch(f.target.publicUrl)).status,410);assert.equal((await fetch(f.target.publicUrl+'assets/theme.css')).status,410);
});
test('two targets fail independently and policy is rechecked before any upload',async t=>{
  const f=await fixture(t,{fake:n=>({apiVersion:'2',id:n.id,family:n.family,capabilities:n.capabilities,validateTarget:(...a)=>n.validateTarget(...a),prepare:c=>{if(c.target.id==='bad')throw new Error('upload failed');return n.prepare(c);},activate:c=>n.activate(c),reconcile:c=>n.reconcile(c),verify:(...a)=>n.verify(...a)})});
  await f.add('bad');const i=await f.accept('multi',['target','bad']);const results=await Promise.all(i.attemptIds.map(id=>f.service.execute('workspace',id)));assert.deepEqual(results.map(r=>r.state).sort(),['failed','published']);
  const blocked=await f.accept('held');f.setAllowed(false);assert.equal((await f.service.execute('workspace',blocked.attemptIds[0])).state,'failed');assert.equal((await f.store.getTarget('workspace','target')).activeGeneration,1);
  await assert.rejects(f.service.rollback(actor,'target',i.attemptIds[0],'held-rollback'));
});
test('lost activation response locks the writer; read-only reconciliation never activates twice',async t=>{
  let calls=0,expose=false;const f=await fixture(t,{fake:n=>({apiVersion:'2',id:n.id,family:n.family,capabilities:n.capabilities,validateTarget:(...a)=>n.validateTarget(...a),prepare:c=>n.prepare(c),activate:async c=>{calls++;await n.activate(c);throw new Error('lost response');},reconcile:c=>expose?n.reconcile(c):Promise.resolve({state:'unknown'}),verify:(...a)=>n.verify(...a)})});
  const i=await f.accept('crash');assert.equal((await f.service.execute('workspace',i.attemptIds[0])).state,'unknown');const newer=await f.accept('newer');assert.equal((await f.service.execute('workspace',newer.attemptIds[0])).state,'busy');
  assert.equal((await f.service.execute('workspace',i.attemptIds[0])).state,'unknown');assert.equal(calls,1);expose=true;
  assert.equal((await f.service.reconcile('workspace',i.attemptIds[0])).state,'published');assert.equal(calls,1);
});
test('execution fencing prevents a previous worker from writing checkpoints or activating',async t=>{
  const f=await fixture(t),i=await f.accept('fence'),id=i.attemptIds[0];assert.equal(await f.store.claim('workspace','target',id,'old'),true);const old=await f.store.getAttempt('workspace',id);assert.equal(await f.store.claim('workspace','target',id,'replacement'),true);
  await assert.rejects(f.store.assertOwner('workspace','target',id,'old'),{code:'writer_fenced'});await assert.rejects(f.store.updateAttempt({...old,revision:old.revision+1},old.revision,'old'),{code:'writer_fenced'});
  const current=await f.store.getAttempt('workspace',id);await f.store.updateAttempt({...current,revision:current.revision+1,activationStarted:true},current.revision,'replacement');assert.equal(await f.store.claim('workspace','target',id,'unsafe-takeover'),false);
});

test('expired unaccepted reviews are cleaned while accepted snapshots remain available for recovery',async t=>{
 const f=await fixture(t),first=await f.service.review(actor,'site',1,['target']),accepted=await f.accept('retained');
 assert.equal(await f.store.cleanupUnacceptedPlans('2099-01-01T00:00:00.000Z',100),1);assert.equal(await f.store.getPlan('workspace',first.planId),undefined);
 assert.equal((await f.service.execute('workspace',accepted.attemptIds[0])).state,'published');
});

test('native retains previous approved hashed assets through normal release transitions and checks withdrawal before retained lookup',async t=>{
 const f=await fixture(t);f.setAsset('first public rendition');const one=await f.accept('asset-one'),first=await f.service.execute('workspace',one.attemptIds[0]),artifact=await f.store.getArtifact('workspace',first.artifactDigest),oldAsset=[...artifact.files.keys()].find(p=>/^assets\/[a-f0-9]{64}/.test(p));
 f.setAsset('second public rendition');const two=await f.accept('asset-two');assert.equal((await f.service.execute('workspace',two.attemptIds[0])).state,'published');assert.equal((await fetch(f.target.publicUrl+oldAsset)).status,200);
 const disabled=await f.service.unpublish(actor,'target','disable-assets');await f.service.execute('workspace',disabled.attemptIds[0]);assert.equal((await fetch(f.target.publicUrl+oldAsset)).status,410);
});
test('uncertain in-place repair requires independently verified writer fencing and reuses exact bytes',async t=>{
 let broken=true;const f=await fixture(t,{confirmQuiescent:async({proofReference})=>proofReference==='verified-stop',fake:n=>({apiVersion:'2',id:n.id,family:n.family,capabilities:n.capabilities,validateTarget:(...a)=>n.validateTarget(...a),prepare:c=>n.prepare(c),activate:async c=>{if(broken){await c.beforeActivation();throw new Error('interrupted');}return n.activate(c);},reconcile:async()=>({state:'unknown'}),verify:(...a)=>n.verify(...a)})});
 const one=await f.accept('uncertain'),old=await f.service.execute('workspace',one.attemptIds[0]);assert.equal(old.state,'unknown');await assert.rejects(f.service.retry(actor,old.id,'blind'),{code:'retry_unavailable'});
 await assert.rejects(f.service.releaseRecoveryLock(actor,old.id,'unverified'),{code:'writer_not_fenced'});await f.service.releaseRecoveryLock(actor,old.id,'verified-stop');broken=false;f.setText('Later unapproved text');
 const retry=await f.service.retry(actor,old.id,'repair'),result=await f.service.execute('workspace',retry.attemptIds[0]);assert.equal(result.state,'published');assert.equal(result.artifactDigest,old.artifactDigest);assert.doesNotMatch(await(await fetch(f.target.publicUrl)).text(),/Later unapproved/);
});

test('saved destination bindings capture one explicit approval and invalidate queued generations when disabled',async t=>{
 const f=await fixture(t),binding={id:'binding',workspaceId:'workspace',websiteId:'site',revision:1,label:'Main website',targetIds:['target'],enabled:true};await f.service.saveBinding(actor,binding,0);
 const review=await f.service.reviewBinding(actor,'binding',1,1),intent=await f.service.publish(actor,review.planId,review.fingerprint,'bound');await f.service.saveBinding(actor,{...binding,revision:2,enabled:false},1);
 const result=await f.service.execute('workspace',intent.attemptIds[0]);assert.equal(result.state,'failed');assert.equal(result.errorCode,'binding_changed');assert.equal((await fetch(f.target.publicUrl)).status,404);
});

test('an explicit provider serving-request rejection releases the writer and preserves reconnect/cooldown semantics',async t=>{
 const {HostingActivationRejected}=await import('@ubeeq/core');const f=await fixture(t,{fake:n=>({apiVersion:'2',id:n.id,family:n.family,capabilities:n.capabilities,validateTarget:(...a)=>n.validateTarget(...a),prepare:c=>n.prepare(c),activate:async c=>{await c.beforeActivation();throw new HostingActivationRejected('rate_limited',45);},reconcile:c=>n.reconcile(c),verify:(...a)=>n.verify(...a)})});
 const intent=await f.accept('rate'),attempt=await f.service.execute('workspace',intent.attemptIds[0]);assert.equal(attempt.state,'failed');assert.equal(attempt.errorCode,'rate_limited');assert.ok(attempt.retryAfter);assert.equal((await f.store.getTarget('workspace','target')).lock,undefined);await assert.rejects(f.service.retry(actor,attempt.id,'too-soon'),{code:'provider_cooldown'});
});

test('policy suspension gates HTML and retained assets independently of the release pointer; only eligible explicit resume clears it',async t=>{
 const f=await fixture(t);f.setAsset('approved image');const intent=await f.accept('policy-gate');assert.equal((await f.service.execute('workspace',intent.attemptIds[0])).state,'published');
 f.setAllowed(false);assert.deepEqual(await f.service.suspendDependencies(actor,['home-doc']),[{targetId:'target',state:'suspended'}]);assert.equal((await fetch(f.target.publicUrl)).status,410);assert.equal((await fetch(f.target.publicUrl+'assets/theme.css')).status,410);assert.equal((await f.store.getTarget('workspace','target')).serving,'suspended');await assert.rejects(f.service.resume(actor,'target'),{code:'release_restricted'});
 f.setAllowed(true);await f.service.resume(actor,'target');assert.equal((await fetch(f.target.publicUrl)).status,200);
 f.setAllowed(false);await f.service.suspendDependencies(actor,['home-doc']);const remove=await f.service.unpublish(actor,'target','remove-held');assert.equal((await f.service.execute('workspace',remove.attemptIds[0])).state,'unpublished');
 f.setAllowed(true);await f.service.resume(actor,'target');assert.equal((await fetch(f.target.publicUrl)).status,410);const republish=await f.accept('after-hold');assert.equal((await f.service.execute('workspace',republish.attemptIds[0])).state,'published');
});

test('opaque markers bind identical rendered bytes to their exact target ownership without exposing private IDs',async t=>{
 const f=await fixture(t,{fake:n=>({apiVersion:'2',id:n.id,family:n.family,capabilities:n.capabilities,validateTarget:async()=>{},prepare:async c=>({releaseId:c.artifact.digest}),activate:async c=>{await c.beforeActivation();return {state:'activated',releaseId:c.artifact.digest,publicUrl:c.target.publicUrl};},reconcile:async c=>({state:'activated',releaseId:c.artifact.digest}),verify:async()=>({associationConfirmed:true,publicConfirmed:false,observedAt:'now',locations:[],reasons:['pending']})})});
 await f.add('second');for(const target of await f.store.listTargets('workspace','site'))await f.store.saveTarget({...target,revision:2,publicUrl:'http://public.example.test/common/',basePath:'/common/'},1);
 const intent=await f.accept('markers',['target','second']),attempts=await Promise.all(intent.attemptIds.map(id=>f.service.execute('workspace',id)));assert.notEqual(attempts[0].marker,attempts[1].marker);assert.notEqual(attempts[0].artifactDigest,attempts[1].artifactDigest);assert.equal(attempts[0].sourceArtifactDigest,attempts[1].sourceArtifactDigest);
});

test('frozen publication plans preserve current design, shared identities and copyright year',async t=>{
 const f=await fixture(t);f.setAsset('approved image');const site=await f.website.get(actor,'site');
 site.revision++;site.contributingCreatorIds=['guest'];site.editingCreatorIds=['guest'];site.theme={id:'plum',version:'1',settings:{colorMode:'system',showCopyright:true,headerLayout:'stacked'}};
 site.pages[0]={...site.pages[0],template:'cover',coverAssetId:'public-image',coverPosition:{x:.2,y:.8},footerNavigation:true};
 await f.website.save(actor,site,1);const review=await f.service.review(actor,'site',2,['target']),plan=await f.store.getPlan('workspace',review.planId),snapshot=await f.store.getSnapshot('workspace',plan.snapshotReference);
 assert.equal(snapshot.copyrightYear,2026);assert.equal(snapshot.creatorIdentities[1].id,'guest');assert.deepEqual(snapshot.website.theme,site.theme);assert.deepEqual(snapshot.website.pages[0],site.pages[0]);assert.deepEqual(snapshot.website.editingCreatorIds,['guest']);
});
test('invalidated candidates remain stale after eligibility is restored',async t=>{
 const f=await fixture(t);await f.store.saveBuild({id:'old-build',workspaceId:'workspace',websiteId:'site',websiteRevision:1,actorId:'actor',creatorIdentityId:'creator',revision:1,idempotencyKey:'old',state:'ready',invalidated:true,createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),dependencies:[],warnings:[]},0);
 assert.equal((await f.website.build(actor,'old-build')).stale,true);
});

test('verification cannot clear a serving suspension or operator withdrawal flag',async t=>{
 const f=await fixture(t,{fake:n=>({apiVersion:'2',id:n.id,family:n.family,capabilities:n.capabilities,validateTarget:(...a)=>n.validateTarget(...a),prepare:c=>n.prepare(c),activate:c=>n.activate(c),reconcile:c=>n.reconcile(c),verify:async(...args)=>({...await n.verify(...args),publicConfirmed:false})})});
 const intent=await f.accept('pending-public-verification');assert.equal((await f.service.execute('workspace',intent.attemptIds[0])).state,'verifying');
 await f.native.suspend(f.target);await f.store.setServingState('workspace','target','suspended',true);
 await f.service.reconcile('workspace',intent.attemptIds[0]);const target=await f.store.getTarget('workspace','target');assert.equal(target.serving,'suspended');assert.equal(target.servingRemovalRequired,true);assert.equal((await fetch(f.target.publicUrl)).status,410);
});

test('resumable upload interruptions retain their checkpoint and do not enter activation',async t=>{
 let first=true,activations=0;
 const f=await fixture(t,{fake:n=>({apiVersion:'2',id:n.id,family:n.family,capabilities:n.capabilities,validateTarget:(...args)=>n.validateTarget(...args),prepare:async c=>{await c.beforeUpload();if(first){first=false;await c.saveCheckpoint({data:{archive:'reserved.zip',offset:'3'}});throw new WebsiteError('upload_interrupted','Retry the saved upload.');}assert.equal(c.checkpoint.data.offset,'3');return n.prepare(c);},activate:async c=>{activations++;return n.activate(c);},reconcile:c=>n.reconcile(c),verify:(...args)=>n.verify(...args)})});
 const intent=await f.accept('upload-resume'),id=intent.attemptIds[0];
 assert.equal((await f.service.execute('workspace',id)).state,'uploading');assert.equal(activations,0);
 assert.equal((await f.store.getAttempt('workspace',id)).activationStarted,false);
 assert.equal((await f.service.execute('workspace',id)).state,'published');assert.equal(activations,1);
});
test('a pending candidate does not replace the last verified live release',async t=>{
 let confirmed=true;
 const f=await fixture(t,{fake:n=>({apiVersion:'2',id:n.id,family:n.family,capabilities:n.capabilities,validateTarget:(...args)=>n.validateTarget(...args),prepare:c=>n.prepare(c),activate:c=>n.activate(c),reconcile:c=>n.reconcile(c),verify:async(...args)=>({...await n.verify(...args),publicConfirmed:confirmed})})});
 const first=await f.accept('first-live');assert.equal((await f.service.execute('workspace',first.attemptIds[0])).state,'published');
 const live=(await f.store.getTarget('workspace','target')).activeAttemptId;
 confirmed=false;const next=await f.accept('pending');assert.equal((await f.service.execute('workspace',next.attemptIds[0])).state,'verifying');assert.equal((await f.store.getTarget('workspace','target')).activeAttemptId,live);
 confirmed=true;const reconciled=await f.service.reconcile('workspace',next.attemptIds[0]);assert.equal(reconciled.state,'published');assert.equal(reconciled.errorCode,undefined);assert.equal((await f.store.getTarget('workspace','target')).activeAttemptId,next.attemptIds[0]);
});

test('transient Hostinger preparation failures retry the same immutable attempt before activation',async t=>{
 let fail=true,activations=0;
 const f=await fixture(t,{fake:n=>({apiVersion:'2',id:n.id,family:n.family,capabilities:n.capabilities,validateTarget:(...args)=>n.validateTarget(...args),prepare:async c=>{if(fail){fail=false;await c.saveCheckpoint({data:{hostingerPreparingAt:new Date().toISOString()}});throw new WebsiteError('provider_outcome_unknown','Provider temporarily unavailable.');}return n.prepare(c);},activate:async c=>{activations++;return n.activate(c);},reconcile:c=>n.reconcile(c),verify:(...args)=>n.verify(...args)})});
 const intent=await f.accept('preparation-retry'),id=intent.attemptIds[0];assert.equal((await f.service.execute('workspace',id)).state,'uploading');assert.equal(activations,0);assert.equal((await f.service.execute('workspace',id)).state,'published');assert.equal(activations,1);
});
