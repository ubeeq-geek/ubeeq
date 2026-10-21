import { randomUUID } from 'node:crypto';
import { domainToASCII } from 'node:url';
import { WebsiteError, HostingActivationRejected, websiteExternalUrl, websitePath, type HostingConnection, type WebsiteHostingAdapter, type WebsiteHostingTarget, type HostingDeploymentContext, type HostingArtifact, type HostingOutcome, type HostingDomain, type WebsiteDestinationBinding } from '@ubeeq/core';
import type { WebsiteHostingStore, WebsiteStore, WebsitePublishIntent, WebsitePublishPlan, WebsiteDeploymentAttempt } from '@ubeeq/persistence';
import { WebsiteService, type WebsiteActor } from './website-service.js';
import { buildWebsiteArtifact, createWebsiteZip, websiteDigest, websiteFingerprint, validateWebsiteFiles, type WebsiteSnapshot } from './website-artifact.js';

export interface WebsitePublishingPorts {
  websites:WebsiteService; store:WebsiteHostingStore; artifacts:WebsiteStore;
  adapters:readonly WebsiteHostingAdapter[];
  hostingEnabled?(actor:WebsiteActor,adapter:WebsiteHostingAdapter):Promise<boolean>;
  authorize(actor:WebsiteActor,action:'view'|'publish'|'manage',target?:WebsiteHostingTarget):Promise<void>;
  enqueue(input:{workspaceId:string;attemptId:string;idempotencyKey:string}):Promise<void>;
  audit(input:{actor:WebsiteActor;action:string;targetId?:string;intentId?:string;generation?:number;digest?:string;result:string}):Promise<void>;
  /** Installation-owned proof, never a creator-supplied boolean. Must establish that all possible remote writers stopped. */
  confirmQuiescent?(input:{target:WebsiteHostingTarget;attempt:WebsiteDeploymentAttempt;proofReference:string}):Promise<boolean>;
  operatorDomain?(input:{target:WebsiteHostingTarget;domain:HostingDomain;operation:'request'|'verify'|'remove'}):Promise<Pick<HostingDomain,'state'|'instructions'|'providerId'>>;
  now?:()=>Date;
}
const terminal=new Set(['published','unpublished','failed','reconnect_required','superseded','cancelled']);
export class WebsitePublishingService {
  constructor(private readonly ports:WebsitePublishingPorts) {
    if(new Set(ports.adapters.map(a=>a.id)).size!==ports.adapters.length)throw new WebsiteError('duplicate_adapter','Hosting adapter IDs must be unique.');
  }
  private now(){return (this.ports.now?.()??new Date()).toISOString();}
  private adapter(id:string){const adapter=this.ports.adapters.find(a=>a.id===id);if(!adapter||adapter.apiVersion!=='2')throw new WebsiteError('hosting_unavailable','This hosting adapter is not enabled.');return adapter;}
  private async target(actor:WebsiteActor,id:string,action:'view'|'publish'|'manage') {const t=await this.ports.store.getTarget(actor.workspaceId,id);if(!t)throw new WebsiteError('target_not_found','Hosting target was not found.');await this.ports.authorize(actor,action,t);return t;}
  private async connection(t:WebsiteHostingTarget){if(!t.connectionId)return undefined;const c=await this.ports.store.getConnection(t.workspaceId,t.connectionId);if(!c||c.state!=='connected'||c.accountId!==t.accountId||c.family!==t.family)throw new WebsiteError('reconnect_required','Reconnect the original hosting account.');return c;}
  async choices(actor:WebsiteActor){await this.ports.authorize(actor,'view');const choices=[];for(const a of this.ports.adapters)if(!this.ports.hostingEnabled||await this.ports.hostingEnabled(actor,a))choices.push({id:a.id,family:a.family,apiVersion:a.apiVersion,capabilities:a.capabilities});return choices;}
  async targets(actor:WebsiteActor,websiteId:string){await this.ports.websites.get(actor,websiteId);const result=[];for(const t of await this.ports.store.listTargets(actor.workspaceId,websiteId)){await this.ports.authorize(actor,'view',t);result.push(t);}return result;}
  async configureTarget(actor:WebsiteActor,input:Omit<WebsiteHostingTarget,'capabilities'|'desiredGeneration'|'activeGeneration'|'serving'|'ownershipMarker'> & {ownershipConfirmed:boolean},expectedRevision:number){
    await this.ports.websites.get(actor,input.websiteId);await this.ports.authorize(actor,'manage');
    if(input.workspaceId!==actor.workspaceId||input.revision!==expectedRevision+1||!input.ownershipConfirmed||!input.remoteId||!input.label?.trim())throw new WebsiteError('invalid_target','Confirm management of this exact site/root and its replacement behavior.');
    if(Object.keys(input.config).some(k=>/secret|password|token|private.?key|credential/i.test(k)))throw new WebsiteError('invalid_target','Store credentials in the server vault.');
    const adapter=this.adapter(input.adapterId);if(this.ports.hostingEnabled&&!await this.ports.hostingEnabled(actor,adapter))throw new WebsiteError('hosting_unavailable','Hosting is not enabled for this workspace.');const url=new URL(websiteExternalUrl(input.publicUrl));
    if(adapter.family!==input.family||(input.family!=='native'&&url.protocol!=='https:')||url.search||url.hash||websitePath(input.basePath)!==url.pathname)throw new WebsiteError('invalid_target','Target URL, base path or adapter family is invalid.');
    const previous=await this.ports.store.getTarget(actor.workspaceId,input.id);
    const {ownershipConfirmed,...configuration}=input;
    const target:WebsiteHostingTarget={...configuration,lock:undefined,activeAttemptId:undefined,activeArtifactDigest:undefined,activeReleaseId:undefined,publicUrl:url.href,basePath:websitePath(input.basePath),capabilities:adapter.capabilities,ownershipMarker:previous?.ownershipMarker??websiteDigest(randomUUID()),desiredGeneration:0,activeGeneration:0,serving:'unpublished'};
    await adapter.validateTarget(target,await this.connection(target));
    await this.ports.store.saveTarget(target,expectedRevision);
    await this.ports.audit({actor,action:'website.target_configured',targetId:target.id,result:'validated'});
    return this.target(actor,target.id,'view');
  }
  async saveBinding(actor:WebsiteActor,binding:WebsiteDestinationBinding,expectedRevision:number){
    await this.ports.websites.get(actor,binding.websiteId);await this.ports.authorize(actor,'manage');
    if(binding.workspaceId!==actor.workspaceId||binding.revision!==expectedRevision+1||!binding.label.trim()||!binding.targetIds.length||binding.targetIds.length>20||new Set(binding.targetIds).size!==binding.targetIds.length)throw new WebsiteError('invalid_binding','Choose 1–20 distinct targets in this workspace.');
    for(const id of binding.targetIds){const target=await this.target(actor,id,'manage');if(target.websiteId!==binding.websiteId)throw new WebsiteError('foreign_reference','Binding target belongs to another website.');}
    await this.ports.store.saveBinding(binding,expectedRevision);return binding;
  }
  async reviewBinding(actor:WebsiteActor,bindingId:string,expectedBindingRevision:number,expectedWebsiteRevision:number){const binding=await this.ports.store.getBinding(actor.workspaceId,bindingId);if(!binding?.enabled||binding.revision!==expectedBindingRevision)throw new WebsiteError('binding_changed','Publishing binding is unavailable or changed.');return this.review(actor,binding.websiteId,expectedWebsiteRevision,binding.targetIds,{id:binding.id,revision:binding.revision});}
  async review(actor:WebsiteActor,websiteId:string,expectedRevision:number,targetIds:readonly string[],binding?:{id:string;revision:number}) {
    if(!targetIds.length||targetIds.length>20||new Set(targetIds).size!==targetIds.length)throw new WebsiteError('invalid_targets','Choose 1–20 distinct publishing targets.');
    const captured=await this.ports.websites.capturePublication(actor,websiteId,expectedRevision),targets=[];
    for(const id of targetIds){const target=await this.target(actor,id,'publish');if(target.websiteId!==websiteId)throw new WebsiteError('foreign_reference','Target belongs to another website.');const c=await this.connection(target);await this.adapter(target.adapterId).validateTarget(target,c);targets.push({id,revision:target.revision,connectionRevision:c?.revision,accountId:target.accountId});}
    const id=randomUUID(),reference='publish-snapshot-'+id;
    const fingerprint=websiteFingerprint({snapshot:{...captured.snapshot,assets:captured.snapshot.assets.map(({bytes,...asset})=>asset)},targets,binding,policyRevision:captured.policyRevision});
    const plan:WebsitePublishPlan={id,workspaceId:actor.workspaceId,websiteId,actorId:actor.actorId,fingerprint,snapshotReference:reference,websiteRevision:expectedRevision,dependencies:captured.dependencies,creatorIdentityId:captured.snapshot.website.creatorIdentityId,targets,binding,policyRevision:captured.policyRevision,limits:captured.limits,createdAt:this.now(),expiresAt:new Date(Date.parse(this.now())+15*60*1000).toISOString()};
    await this.ports.store.putPlan(plan,captured.snapshot);
    return {planId:id,fingerprint,websiteRevision:expectedRevision,targets,dependencies:plan.dependencies,expiresAt:plan.expiresAt};
  }
  private async accept(actor:WebsiteActor,input:{key:string;websiteId:string;operation:WebsitePublishIntent['operation'];fingerprint:string;plan?:WebsitePublishPlan;snapshotReference?:string;targetIds:readonly string[];source?:Pick<WebsiteDeploymentAttempt,'artifactDigest'|'sourceArtifactDigest'|'marker'|'dependencies'|'creatorIdentityId'|'binding'|'renderLimits'>}) {
    if(!input.key?.trim()||input.key.length>200)throw new WebsiteError('invalid_idempotency_key','A bounded publication key is required.');
    const id='publish-'+websiteFingerprint([actor.workspaceId,actor.actorId,input.key]);
    const existing=await this.ports.store.getIntent(actor.workspaceId,id);if(existing){if(existing.approvalFingerprint!==input.fingerprint)throw new WebsiteError('idempotency_conflict','Publish key was used for another approval.');return existing;}
    const targets=[],attempts:WebsiteDeploymentAttempt[]=[];
    for(const targetId of input.targetIds){const t=await this.target(actor,targetId,'publish'),connection=await this.connection(t),approved=input.plan?.targets.find(a=>a.id===targetId);if(t.websiteId!==input.websiteId||(input.plan&&(!approved||approved.revision!==t.revision||approved.accountId!==t.accountId||approved.connectionRevision!==connection?.revision)))throw new WebsiteError('revision_conflict','Selected target or account changed after review.');
      const attemptId=websiteFingerprint([id,targetId]);targets.push(t);attempts.push({id:attemptId,workspaceId:actor.workspaceId,targetId,targetRevision:t.revision,intentId:id,generation:t.desiredGeneration+1,revision:1,connectionRevision:connection?.revision,accountId:t.accountId,state:'queued',checkpoint:{},dependencies:input.plan?.dependencies??input.source?.dependencies??[],creatorIdentityId:input.plan?.creatorIdentityId??input.source?.creatorIdentityId??'',artifactDigest:input.source?.artifactDigest,sourceArtifactDigest:input.source?.sourceArtifactDigest,marker:input.source?.marker,binding:input.plan?.binding??input.source?.binding,renderLimits:input.plan?.limits??input.source?.renderLimits,activationStarted:false,updatedAt:this.now()});}
    const intent:WebsitePublishIntent={id,workspaceId:actor.workspaceId,websiteId:input.websiteId,actorId:actor.actorId,operation:input.operation,planId:input.plan?.id,snapshotReference:input.plan?.snapshotReference??input.snapshotReference,idempotencyKey:input.key,approvalFingerprint:input.fingerprint,createdAt:this.now(),attemptIds:attempts.map(a=>a.id)};
    const saved=await this.ports.store.acceptIntent({intent,plan:input.plan,targets,attempts});
    // Intent + outbox are already durable. Dispatch failure cannot lose accepted work.
    try{await this.recoverOutbox();}catch{}
    await this.ports.audit({actor,action:'website.publish_accepted',intentId:id,result:'queued'});return saved;
  }
  async publish(actor:WebsiteActor,planId:string,fingerprint:string,key:string,expectedWebsiteId?:string){const plan=await this.ports.store.getPlan(actor.workspaceId,planId);if(!plan||expectedWebsiteId&&plan.websiteId!==expectedWebsiteId||plan.actorId!==actor.actorId||plan.fingerprint!==fingerprint||Date.parse(plan.expiresAt)<=Date.parse(this.now())&&!await this.ports.store.getIntent(actor.workspaceId,'publish-'+websiteFingerprint([actor.workspaceId,actor.actorId,key])))throw new WebsiteError('invalid_approval','Publication review expired or does not match.');await this.ports.websites.authorizePublication(actor,plan.websiteId,plan.creatorIdentityId,plan.dependencies);return this.accept(actor,{key,websiteId:plan.websiteId,operation:'publish',fingerprint,plan,targetIds:plan.targets.map(t=>t.id)});}
  /** Confirmed deletion publishes content-free output through the ordinary durable deployment queue. */
  async publishBlankForDeletion(actor:WebsiteActor,websiteId:string,expectedRevision:number,targetId:string,key:string){
    const website=await this.ports.websites.get(actor,websiteId);await this.ports.authorize(actor,'manage');
    if(website.revision!==expectedRevision)throw new WebsiteError('revision_conflict','Website changed after deletion was confirmed. Review it before deleting.');
    const target=await this.target(actor,targetId,'publish');if(target.websiteId!==websiteId)throw new WebsiteError('foreign_reference','Deletion target belongs to another website.');
    const existing=await this.ports.store.getIntent(actor.workspaceId,'publish-'+websiteFingerprint([actor.workspaceId,actor.actorId,key]));if(existing)return existing;
    const dependencies=[{kind:'website' as const,id:websiteId,revision:String(expectedRevision)}];
    await this.ports.websites.authorizePublication(actor,websiteId,website.creatorIdentityId,dependencies);
    const adapter=this.adapter(target.adapterId);await adapter.validateTarget(target,await this.connection(target));
    const blank=new TextEncoder().encode('<!doctype html><html><head><meta charset="utf-8"><meta name="robots" content="noindex"><title></title></head><body></body></html>');
    const output=new Map<string,Uint8Array>([['index.html',blank],['404.html',blank],['robots.txt',new TextEncoder().encode('User-agent: *\nDisallow: /\n')]]);
    if(target.activeArtifactDigest){const previous=await this.ports.artifacts.getArtifact(actor.workspaceId,target.activeArtifactDigest);for(const name of previous?.files.keys()??[])if(name.endsWith('.html'))output.set(name,blank);}
    const files=new Map(adapter.transformFiles?.(output)??output),sourceDigest=websiteDigest(createWebsiteZip(files)),marker=websiteDigest('website-release:'+sourceDigest+':'+target.ownershipMarker);
    files.set('ubeeq-release.json',new TextEncoder().encode(JSON.stringify({version:'1',release:marker})+'\n'));
    const zip=createWebsiteZip(files),digest=websiteDigest(zip);await this.ports.artifacts.putArtifact(actor.workspaceId,digest,zip,files);
    const source={artifactDigest:digest,sourceArtifactDigest:sourceDigest,marker,creatorIdentityId:website.creatorIdentityId,dependencies};
    return this.accept(actor,{key,websiteId,operation:'publish',fingerprint:websiteFingerprint(['delete-blank',websiteId,expectedRevision,targetId]),targetIds:[targetId],source});
  }
  async cleanupExpiredReviews(){return {removedReviews:await this.ports.store.cleanupUnacceptedPlans(this.now(),100)};}
  async recoverOutbox(){for(const row of await this.ports.store.pendingOutbox(100)){await this.ports.enqueue({...row,idempotencyKey:'website-deploy:'+row.attemptId});await this.ports.store.acknowledgeOutbox(row.workspaceId,row.attemptId);}}
  private async readArtifact(t:WebsiteHostingTarget,a:WebsiteDeploymentAttempt):Promise<HostingArtifact>{if(!a.artifactDigest||!a.sourceArtifactDigest||!a.marker)throw new WebsiteError('artifact_unavailable','Deployment artifact is not ready.');const found=await this.ports.artifacts.getArtifact(t.workspaceId,a.artifactDigest);if(!found||websiteDigest(found.zip)!==a.artifactDigest||websiteDigest(createWebsiteZip(found.files))!==a.artifactDigest)throw new WebsiteError('artifact_unavailable','Pinned deployment artifact is missing or corrupt.');return {...found,digest:a.artifactDigest,sourceArtifactDigest:a.sourceArtifactDigest,marker:a.marker};}
  async execute(workspaceId:string,attemptId:string):Promise<WebsiteDeploymentAttempt|{state:'busy'}>{
    let attempt=await this.ports.store.getAttempt(workspaceId,attemptId);if(!attempt)throw new WebsiteError('attempt_not_found','Deployment attempt was not found.');
    if(terminal.has(attempt.state))return attempt;
    if(attempt.activationStarted)return this.reconcile(workspaceId,attemptId);
    const executionId=randomUUID();if(!await this.ports.store.claim(workspaceId,attempt.targetId,attempt.id,executionId))return {state:'busy'};
    attempt=(await this.ports.store.getAttempt(workspaceId,attemptId))!;
    const intent=(await this.ports.store.getIntent(workspaceId,attempt.intentId))!,actor={workspaceId,actorId:intent.actorId};
    let guardPassed=false,confirmedOutcome:{releaseId:string;disabled:boolean}|undefined;
    const update=async(patch:Partial<WebsiteDeploymentAttempt>)=>{const next={...attempt!,...patch,revision:attempt!.revision+1,updatedAt:this.now()};await this.ports.store.updateAttempt(next,attempt!.revision,executionId);attempt=next;};
    const finish=async(state:WebsiteDeploymentAttempt['state'],errorCode?:string,outcome?:{releaseId:string;disabled:boolean})=>{const next={...attempt!,state,errorCode,revision:attempt!.revision+1,updatedAt:this.now()};await this.ports.store.finish(next,attempt!.revision,executionId,['published','unpublished'].includes(state)?outcome:undefined);attempt=next;};
    try{
      const t=await this.ports.store.assertOwner(workspaceId,attempt.targetId,attempt.id,executionId),adapter=this.adapter(t.adapterId),connection=await this.connection(t);
      const guard=async()=>{const current=await this.ports.store.assertOwner(workspaceId,t.id,attempt!.id,executionId);if(current.desiredGeneration!==attempt!.generation)throw new WebsiteError('superseded','A newer approved target generation is desired.');if(current.revision!==attempt!.targetRevision||current.accountId!==attempt!.accountId)throw new WebsiteError('revision_conflict','Target identity/configuration changed.');if(attempt!.binding){const binding=await this.ports.store.getBinding(workspaceId,attempt!.binding.id);if(!binding?.enabled||binding.revision!==attempt!.binding.revision)throw new WebsiteError('binding_changed','Publishing binding changed after approval.');}await this.ports.authorize(actor,'publish',current);if(intent.operation!=='unpublish'&&this.ports.hostingEnabled&&!await this.ports.hostingEnabled(actor,adapter))throw new WebsiteError('hosting_unavailable','Hosting entitlement is not active.');const c=await this.connection(current);if(c?.revision!==attempt!.connectionRevision)throw new WebsiteError('reconnect_required','Connection changed; review its new authorization.');if(intent.operation!=='unpublish')await this.ports.websites.authorizePublication(actor,intent.websiteId,attempt!.creatorIdentityId,attempt!.dependencies);};
      if(adapter.family==='hostinger'&&!attempt.checkpoint.data?.hostingerPreparingAt)await update({checkpoint:{...attempt.checkpoint,data:{...attempt.checkpoint.data,hostingerPreparingAt:this.now()}}});
      await guard();await adapter.validateTarget(t,connection);
      if(intent.operation!=='unpublish'&&!attempt.artifactDigest){await update({state:'generating'});const snapshot=await this.ports.store.getSnapshot(workspaceId,intent.snapshotReference!) as WebsiteSnapshot|undefined;if(!snapshot)throw new WebsiteError('snapshot_unavailable','Approved source snapshot was not found.');
        // Render variants contain the same approved revisions with target-specific URLs.
        const variant=structuredClone(snapshot),url=new URL(t.publicUrl);variant.website={...variant.website,basePath:decodeURIComponent(t.basePath),publicBaseUrl:url.origin};
        const limits=attempt.renderLimits;
        if(!limits)throw new WebsiteError('snapshot_unavailable','Approved render limits are unavailable.');
        const built=buildWebsiteArtifact(variant,{maxPages:limits.maxPages,maxAssets:Math.min(limits.maxAssets,adapter.capabilities.maxFiles),maxBytes:Math.min(limits.maxBytes,adapter.capabilities.maxBytes)});
        const files=new Map(adapter.transformFiles?.(built.files)??built.files),marker=websiteDigest('website-release:'+websiteDigest(createWebsiteZip(files))+':'+t.ownershipMarker);
        if(files.has('ubeeq-release.json'))throw new WebsiteError('reserved_file','Release marker path is reserved.');files.set('ubeeq-release.json',new TextEncoder().encode(JSON.stringify({version:'1',release:marker})+'\n'));
        if(files.size>adapter.capabilities.maxFiles||[...files.values()].some(b=>b.length>adapter.capabilities.maxFileBytes)||[...files.values()].reduce((n,b)=>n+b.length,0)>adapter.capabilities.maxBytes)throw new WebsiteError('provider_limit','Generated output exceeds target file or byte limits.');
        validateWebsiteFiles(variant.website,files);const zip=createWebsiteZip(files),digest=websiteDigest(zip);await this.ports.artifacts.putArtifact(workspaceId,digest,zip,files);await update({artifactDigest:digest,sourceArtifactDigest:built.digest,marker});
      }
      const artifact=intent.operation==='unpublish'?undefined:await this.readArtifact(t,attempt);
      const context:HostingDeploymentContext={target:t,connection,attemptId:attempt.id,generation:attempt.generation,operation:intent.operation,artifact,checkpoint:attempt.checkpoint,beforeUpload:guard,saveCheckpoint:async checkpoint=>{await update({checkpoint});context.checkpoint=checkpoint;},beforeActivation:async()=>{await guard();guardPassed=true;}};
      if(intent.operation!=='unpublish'){await update({state:'uploading'});const checkpoint=await adapter.prepare(context);await context.saveCheckpoint(checkpoint);}
      await guard();await update({state:'activating',activationStarted:true});
      const outcome=intent.operation==='unpublish'?await (adapter.unpublish?.(context)??Promise.resolve({state:'failed' as const,reason:'operator_action_required'})):await adapter.activate(context);
      if(outcome.state==='unknown'||outcome.state==='pending'){await finish('unknown',outcome.reason??'activation_unconfirmed');return attempt;}
      if(outcome.state==='failed'){await finish('failed',outcome.reason??'activation_failed');return attempt;}
      if(!outcome.releaseId||outcome.publicUrl&&new URL(outcome.publicUrl).href!==new URL(t.publicUrl).href)throw new WebsiteError('target_identity_changed','Activation returned an unexpected target or no release identity.');
      confirmedOutcome={releaseId:outcome.releaseId,disabled:outcome.state==='disabled'};
      await update({state:'verifying',checkpoint:{...attempt.checkpoint,releaseId:outcome.releaseId}});
      const verification=await adapter.verify(context,outcome);await update({verification});
      if(!verification.associationConfirmed){await finish('unknown','association_unconfirmed');return attempt;}
      await finish(verification.publicConfirmed?(outcome.state==='disabled'?'unpublished':'published'):'verifying',verification.publicConfirmed?undefined:'verification_pending',{releaseId:outcome.releaseId,disabled:outcome.state==='disabled'});
      await this.ports.audit({actor,action:'website.deployment',targetId:t.id,intentId:intent.id,generation:attempt.generation,digest:attempt.artifactDigest,result:attempt.state});
    }catch(error){if(error instanceof WebsiteError&&attempt?.checkpoint.data?.hostingerPreparingAt&&!attempt.activationStarted&&['provider_outcome_unknown','rate_limited','setup_pending'].includes(error.code)&&Date.parse(this.now())-Date.parse(attempt.checkpoint.data.hostingerPreparingAt)<900000){const seconds=(error as WebsiteError&{retryAfterSeconds?:number}).retryAfterSeconds;if(seconds)await update({retryAfter:new Date(Date.parse(this.now())+seconds*1000).toISOString()});await finish('uploading',error.code);return attempt;}if(error instanceof WebsiteError&&error.code==='upload_interrupted'&&attempt?.checkpoint.data?.archive){await finish('uploading','upload_interrupted');return attempt;}const code=error instanceof WebsiteError||error instanceof HostingActivationRejected?error.code:'hosting_failed';if(code==='writer_fenced')return (await this.ports.store.getAttempt(workspaceId,attemptId))!;if(error instanceof HostingActivationRejected&&error.retryAfterSeconds)await update({retryAfter:new Date(Date.parse(this.now())+error.retryAfterSeconds*1000).toISOString()});const state=confirmedOutcome?'verifying':guardPassed&&!(error instanceof HostingActivationRejected)?'unknown':code==='superseded'?'superseded':code==='reconnect_required'?'reconnect_required':'failed';await finish(state,code,confirmedOutcome);}
    return attempt;
  }
  async reconcile(workspaceId:string,attemptId:string):Promise<WebsiteDeploymentAttempt|{state:'busy'}>{
    let attempt=await this.ports.store.getAttempt(workspaceId,attemptId);if(!attempt)throw new WebsiteError('attempt_not_found','Deployment was not found.');if(terminal.has(attempt.state))return attempt;
    let target=await this.ports.store.getTarget(workspaceId,attempt.targetId);if(!target)throw new WebsiteError('target_not_found','Target was not found.');
    if(target.activeGeneration>attempt.generation)return {...attempt,state:'superseded'};
    let executionId=target.lock?.attemptId===attempt.id?target.lock.executionId:undefined;
    if(!executionId){executionId=randomUUID();if(!await this.ports.store.claim(workspaceId,target.id,attempt.id,executionId))return {state:'busy'};attempt=(await this.ports.store.getAttempt(workspaceId,attempt.id))!;target=(await this.ports.store.getTarget(workspaceId,target.id))!;}
    const intent=(await this.ports.store.getIntent(workspaceId,attempt.intentId))!,actor={workspaceId,actorId:intent.actorId},adapter=this.adapter(target.adapterId);
    await this.ports.authorize(actor,'publish',target);const connection=await this.connection(target);
    if(intent.operation!=='unpublish')await this.ports.websites.authorizePublication(actor,intent.websiteId,attempt.creatorIdentityId,attempt.dependencies);
    const context:HostingDeploymentContext={target,connection,attemptId:attempt.id,generation:attempt.generation,operation:intent.operation,artifact:intent.operation==='unpublish'?undefined:await this.readArtifact(target,attempt),checkpoint:attempt.checkpoint,saveCheckpoint:async()=>{throw new WebsiteError('reconcile_read_only','Reconciliation cannot restage or activate.');},beforeActivation:async()=>{throw new WebsiteError('reconcile_read_only','Do not repeat an uncertain activation.');}};
    const result=await adapter.reconcile(context);
    if(result.state!=='activated'&&result.state!=='disabled')return attempt;
    const verification=await adapter.verify(context,result);if(!verification.associationConfirmed)return attempt;
    const next={...attempt,revision:attempt.revision+1,errorCode:verification.publicConfirmed?undefined:attempt.errorCode,verification,checkpoint:{...attempt.checkpoint,releaseId:result.releaseId},state:verification.publicConfirmed?(result.state==='disabled'?'unpublished' as const:'published' as const):'verifying' as const,updatedAt:this.now()};
    await this.ports.store.finish(next,attempt.revision,executionId,verification.publicConfirmed?{releaseId:result.releaseId!,disabled:result.state==='disabled'}:undefined);return next;
  }
  async history(actor:WebsiteActor,websiteId:string){await this.ports.websites.get(actor,websiteId);const targets=await this.targets(actor,websiteId);return {targets,bindings:await this.ports.store.listBindings(actor.workspaceId,websiteId),attempts:await this.ports.store.listAttempts(actor.workspaceId,websiteId),domains:(await Promise.all(targets.map(t=>this.ports.store.listDomains(actor.workspaceId,t.id)))).flat()};}
  async rollback(actor:WebsiteActor,targetId:string,attemptId:string,key:string){const target=await this.target(actor,targetId,'publish'),source=await this.ports.store.getAttempt(actor.workspaceId,attemptId);if(target.capabilities.rollback==='unsupported'||!source||source.targetId!==targetId||!source.artifactDigest||!['published','verifying'].includes(source.state))throw new WebsiteError('rollback_unavailable','Select a retained confirmed release for this target.');await this.ports.websites.authorizePublication(actor,target.websiteId,source.creatorIdentityId,source.dependencies);return this.accept(actor,{key,websiteId:target.websiteId,operation:'rollback',fingerprint:websiteFingerprint(['rollback',targetId,source.id,source.artifactDigest]),targetIds:[targetId],source});}
  async unpublish(actor:WebsiteActor,targetId:string,key:string){const target=await this.target(actor,targetId,'publish');if(target.capabilities.unpublish!=='confirmed')throw new WebsiteError('operator_action_required','This target requires operator-managed serving removal.');return this.accept(actor,{key,websiteId:target.websiteId,operation:'unpublish',fingerprint:websiteFingerprint(['unpublish',targetId,target.revision]),targetIds:[targetId]});}
  async retry(actor:WebsiteActor,attemptId:string,key:string){const old=await this.ports.store.getAttempt(actor.workspaceId,attemptId);if(!old||!['failed','reconnect_required'].includes(old.state))throw new WebsiteError('retry_unavailable','Only settled failed deployments can be retried. Reconcile unknown activation first.');if(old.retryAfter&&Date.parse(old.retryAfter)>Date.parse(this.now()))throw new WebsiteError('provider_cooldown','Wait until the provider cooldown expires before retrying.');const intent=(await this.ports.store.getIntent(actor.workspaceId,old.intentId))!;if(intent.operation!=='unpublish')await this.ports.websites.authorizePublication(actor,intent.websiteId,old.creatorIdentityId,old.dependencies);return this.accept(actor,{key,websiteId:intent.websiteId,operation:intent.operation,fingerprint:websiteFingerprint(['retry',old.intentId,old.targetId,old.artifactDigest??intent.approvalFingerprint]),targetIds:[old.targetId],source:old,snapshotReference:intent.snapshotReference});}
  async cancel(actor:WebsiteActor,attemptId:string){const a=await this.ports.store.getAttempt(actor.workspaceId,attemptId);if(!a)throw new WebsiteError('attempt_not_found','Deployment was not found.');await this.target(actor,a.targetId,'publish');if(a.activationStarted)throw new WebsiteError('reconciliation_required','Activation may have occurred; reconcile before requesting rollback/unpublish.');const executionId=randomUUID();if(!await this.ports.store.claim(actor.workspaceId,a.targetId,a.id,executionId))throw new WebsiteError('target_busy','Another deployment owns this target.');const current=(await this.ports.store.getAttempt(actor.workspaceId,a.id))!;await this.ports.store.finish({...current,state:'cancelled',revision:current.revision+1},current.revision,executionId);}
  /** Policy event hook: independent data-plane gates also cover an uncertain/stale activation. */
  async suspendDependencies(actor:WebsiteActor,subjectIds:readonly string[]){
    const subjects=new Set(subjectIds),results=[];
    for(const website of await this.ports.artifacts.listWebsites(actor.workspaceId))for(const target of await this.ports.store.listTargets(actor.workspaceId,website.id)){
      if(target.servingRemovalRequired)continue;
      const attempts=await Promise.all([target.activeAttemptId,target.lock?.attemptId].filter((id):id is string=>!!id).map(id=>this.ports.store.getAttempt(actor.workspaceId,id)));
      if(!subjects.has(actor.workspaceId)&&!subjects.has(website.id)&&!attempts.some(a=>a?.dependencies.some(d=>subjects.has(d.id))))continue;
      await this.ports.authorize(actor,'publish',target);const adapter=this.adapter(target.adapterId);
      if(!adapter.suspend){await this.ports.store.setServingState(actor.workspaceId,target.id,target.serving,true);await this.ports.audit({actor,action:'website.serving_removal_required',targetId:target.id,result:'operator_required'});results.push({targetId:target.id,state:'operator_required'});continue;}
      try{await adapter.suspend(target);}catch{await this.ports.audit({actor,action:'website.serving_suspension_pending',targetId:target.id,result:'operator_attention_required'});results.push({targetId:target.id,state:'suspension_pending'});continue;}await this.ports.store.setServingState(actor.workspaceId,target.id,'suspended');await this.ports.audit({actor,action:'website.serving_suspended',targetId:target.id,result:'suspended'});results.push({targetId:target.id,state:'suspended'});
    }return results;
  }
  async resume(actor:WebsiteActor,targetId:string){
    const target=await this.target(actor,targetId,'manage');if(target.lock)throw new WebsiteError('reconciliation_required','Resolve the current writer before resuming serving.');
    const adapter=this.adapter(target.adapterId),active=target.activeAttemptId?await this.ports.store.getAttempt(actor.workspaceId,target.activeAttemptId):undefined;
    const source=active?.artifactDigest?active:(await this.ports.store.listAttempts(actor.workspaceId,target.websiteId)).filter(a=>a.targetId===targetId&&a.artifactDigest).sort((a,b)=>b.generation-a.generation)[0];
    if(!adapter.resume||!source)throw new WebsiteError('operator_action_required','A retained approved artifact is required for serving recovery.');
    await this.ports.websites.authorizePublication(actor,target.websiteId,source.creatorIdentityId,source.dependencies);
    let state:WebsiteHostingTarget['serving']='unpublished';
    if(active){const intent=(await this.ports.store.getIntent(actor.workspaceId,active.intentId))!,context:HostingDeploymentContext={target,connection:await this.connection(target),attemptId:active.id,generation:active.generation,operation:intent.operation,artifact:active.artifactDigest?await this.readArtifact(target,active):undefined,checkpoint:active.checkpoint,saveCheckpoint:async()=>{throw new WebsiteError('reconcile_read_only','Serving recovery cannot restage files.');},beforeActivation:async()=>{throw new WebsiteError('reconcile_read_only','Serving recovery cannot activate a release.');}};const outcome=await adapter.reconcile(context);if(!['activated','disabled'].includes(outcome.state))throw new WebsiteError('reconciliation_required','Confirm the current release association before clearing the policy gate.');state=outcome.state==='activated'?'active':'unpublished';}
    await adapter.resume(target,async()=>{const current=await this.target(actor,targetId,'manage');if(current.lock||current.revision!==target.revision)throw new WebsiteError('reconciliation_required','Target changed during serving recovery.');if(this.ports.hostingEnabled&&!await this.ports.hostingEnabled(actor,adapter))throw new WebsiteError('hosting_unavailable','Hosting is not enabled for this workspace.');await this.ports.websites.authorizePublication(actor,target.websiteId,source.creatorIdentityId,source.dependencies);});await this.ports.store.setServingState(actor.workspaceId,targetId,state);await this.ports.audit({actor,action:'website.serving_resumed',targetId:targetId,result:state});
  }
  async releaseRecoveryLock(actor:WebsiteActor,attemptId:string,proofReference:string){
    const a=await this.ports.store.getAttempt(actor.workspaceId,attemptId);if(!a||a.state!=='unknown')throw new WebsiteError('recovery_unavailable','Select an uncertain deployment.');
    const target=await this.target(actor,a.targetId,'manage');if(!this.ports.confirmQuiescent||!await this.ports.confirmQuiescent({target,attempt:a,proofReference}))throw new WebsiteError('writer_not_fenced','Installation operator must independently prove every possible remote writer stopped before repair.');
    if(target.lock?.attemptId!==a.id)throw new WebsiteError('writer_fenced','Deployment no longer owns the target.');
    await this.ports.store.finish({...a,revision:a.revision+1,state:'failed',errorCode:'quiescent_repair_required',updatedAt:this.now()},a.revision,target.lock.executionId);
    await this.ports.audit({actor,action:'website.recovery_writer_fenced',targetId:target.id,result:'repair_required'});
  }
  async domains(actor:WebsiteActor,targetId:string){await this.target(actor,targetId,'view');return this.ports.store.listDomains(actor.workspaceId,targetId);}
  private async domainOperation(actor:WebsiteActor,target:WebsiteHostingTarget,domain:HostingDomain,operation:'request'|'verify'|'remove'){
    const adapter=this.adapter(target.adapterId),handler=adapter.domain?.bind(adapter);
    const result=handler?await handler({target,connection:await this.connection(target),domain,operation}):this.ports.operatorDomain?await this.ports.operatorDomain({target,domain,operation}):{state:operation==='remove'?'removing' as const:'dns_pending' as const,instructions:['Operator must verify hostname ownership, server/distribution association, DNS and valid HTTPS. Content and the current public URL remain unchanged.']};
    // Domain readiness does not silently switch canonicals or the target URL. That needs a separately reviewed target variant.
    const next={...domain,...result,revision:domain.revision+1};await this.ports.store.saveDomain(next,domain.revision);await this.ports.audit({actor,action:'website.domain_'+operation,targetId:target.id,result:next.state});return next;
  }
  async verifyDomain(actor:WebsiteActor,targetId:string,domainId:string,remove=false){const target=await this.target(actor,targetId,'manage'),domain=(await this.ports.store.listDomains(actor.workspaceId,targetId)).find(d=>d.id===domainId);if(!domain)throw new WebsiteError('domain_not_found','Domain was not found.');if(remove&&new URL(target.publicUrl).hostname===domain.hostname)throw new WebsiteError('active_domain','Verify and select a replacement public URL before removing the current hostname.');return this.domainOperation(actor,target,domain,remove?'remove':'verify');}
  async requestDomain(actor:WebsiteActor,targetId:string,hostname:string,mode:'primary'|'alias'){const target=await this.target(actor,targetId,'manage');const normalized=domainToASCII(hostname.trim().toLowerCase().replace(/\.$/,''));if(!normalized||normalized.length>253||!normalized.includes('.')||normalized.split('.').some(s=>!s||s.length>63||!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(s)))throw new WebsiteError('invalid_domain','Use an exact hostname without wildcard, path or port.');const domain:HostingDomain={id:randomUUID(),workspaceId:actor.workspaceId,targetId,revision:1,hostname:normalized,mode,state:'dns_pending',instructions:['Configure and verify the provider/server association, DNS and HTTPS with the target operator. The current URL remains active.']};if((await this.ports.store.listDomains(actor.workspaceId,targetId)).some(d=>d.hostname===normalized&&d.state!=='removed'))throw new WebsiteError('domain_exists','This hostname already has a domain request.');await this.ports.store.saveDomain(domain,0);return this.domainOperation(actor,target,domain,'request');}
}
