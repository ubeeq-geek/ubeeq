import { randomUUID } from 'node:crypto';
import { WebsiteError } from '@ubeeq/core';
import type { WebsitePublishingService, WebsiteActor } from '@ubeeq/portability';
import type { NativeWebsiteHostingAdapter } from '@ubeeq/adapter-local';
/** Authenticated composition route. Internal target generations, locks and secrets are never accepted. */
export async function handleWebsiteHostingRequest(input:{service:WebsitePublishingService;actor:WebsiteActor;method:string;parts:string[];body:()=>Promise<Record<string,unknown>>;native:readonly NativeWebsiteHostingAdapter[]}) {
  const {service,actor,method,parts}=input,site=parts[0],operation=parts[2],id=parts[3];
  if(method==='GET'&&operation==='choices')return {choices:await service.choices(actor)};
  if(method==='GET'&&operation==='history')return service.history(actor,site);
  if(method==='GET'&&operation==='targets')return {targets:await service.targets(actor,site)};
  const b=method==='GET'?{}:await input.body(),key=String(b.idempotencyKey??'');
  if(method==='POST'&&operation==='native-target'){
    const adapter=input.native.find(a=>a.id===b.adapterId);if(!adapter)throw new WebsiteError('hosting_unavailable','Choose an administrator-enabled native profile.');
    const targetId=randomUUID(),publicUrl=adapter.publicUrl(actor.workspaceId,targetId);
    return {target:await service.configureTarget(actor,{id:targetId,workspaceId:actor.workspaceId,websiteId:site,revision:1,label:String(b.label??'Website'),adapterId:adapter.id,family:'native',accountId:adapter.profile.id,remoteId:(await import('@ubeeq/adapter-local')).nativeWebsiteKey(actor.workspaceId,targetId),publicUrl,basePath:decodeURIComponent(new URL(publicUrl).pathname),config:{},ownershipConfirmed:b.ownershipConfirmed===true},0)};
  }
  if(method==='POST'&&operation==='binding'){return {binding:await service.saveBinding(actor,{id:typeof b.id==='string'?b.id:randomUUID(),workspaceId:actor.workspaceId,websiteId:site,revision:Number(b.expectedRevision??0)+1,label:String(b.label??''),enabled:b.enabled!==false,targetIds:Array.isArray(b.targetIds)?b.targetIds.map(String):[]},Number(b.expectedRevision??0))};}
  if(method==='POST'&&operation==='binding-review'){if(!(await service.history(actor,site)).bindings.some(binding=>binding.id===b.bindingId))throw new WebsiteError('binding_not_found','Binding was not found for this website.');return service.reviewBinding(actor,String(b.bindingId),Number(b.bindingRevision),Number(b.expectedRevision));}
  if(method==='POST'&&operation==='review')return service.review(actor,site,Number(b.expectedRevision),Array.isArray(b.targetIds)?b.targetIds.map(String):[]);
  if(method==='POST'&&operation==='publish')return {intent:await service.publish(actor,String(b.planId),String(b.fingerprint),key,site)};
  // Check website scope before resolving an attempt or changing any target.
  const history=await service.history(actor,site);
  const target=history.targets.find(t=>t.id===id),attempt=history.attempts.find(a=>a.id===id);
  if(method==='POST'&&operation==='retry'&&attempt)return {intent:await service.retry(actor,id,key)};
  if(method==='POST'&&operation==='cancel'&&attempt){await service.cancel(actor,id);return {cancelled:true};}
  if(method==='POST'&&operation==='reconcile'&&attempt)return {attempt:await service.reconcile(actor.workspaceId,id)};
  if(method==='POST'&&operation==='rollback'&&target)return {intent:await service.rollback(actor,id,String(b.attemptId),key)};
  if(method==='POST'&&operation==='resume'&&target){await service.resume(actor,id);return {resumed:true};}
  if(method==='POST'&&operation==='unpublish'&&target)return {intent:await service.unpublish(actor,id,key)};
  if(method==='GET'&&operation==='domains'&&target)return {domains:await service.domains(actor,id)};
  if(method==='POST'&&['domain-verify','domain-remove'].includes(operation)&&target)return {domain:await service.verifyDomain(actor,id,String(b.domainId),operation==='domain-remove')};
  if(method==='POST'&&operation==='domains'&&target)return {domain:await service.requestDomain(actor,id,String(b.hostname),b.mode==='alias'?'alias':'primary')};
  throw new WebsiteError('website_route_not_found','Hosting operation was not found.');
}
