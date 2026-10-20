import { createHash, randomUUID } from 'node:crypto';
import { mkdir, lstat, readFile, realpath, rename, rm, open, readdir } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { WebsiteError, websiteFrameAncestors, websiteExternalUrl, type HostingCapabilities, type HostingDeploymentContext, type HostingOutcome, type WebsiteHostingAdapter, type WebsiteHostingTarget } from '@ubeeq/core';

export interface NativeWebsiteHostingProfile {
  id:string; root:string; publicUrlTemplate:string; persistent:true;
  /** The reference arrangement has one publisher; shared-volume replicas require separate verification. */
  writerMode:'single';
}
const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
export const nativeWebsiteKey=(workspaceId:string,targetId:string)=>hash(JSON.stringify([workspaceId,targetId])).slice(0,32);
const types:Record<string,string>={html:'text/html; charset=utf-8',css:'text/css; charset=utf-8',json:'application/json',xml:'application/xml',txt:'text/plain; charset=utf-8',jpg:'image/jpeg',png:'image/png',webp:'image/webp',avif:'image/avif',gif:'image/gif',mp4:'video/mp4',webm:'video/webm',mp3:'audio/mpeg',ogg:'audio/ogg',wav:'audio/wav',pdf:'application/pdf'};
export const websiteContentType=(path:string)=>types[path.split('.').pop()??'']??'application/octet-stream';
const safeFile=(file:string)=>{if(!file||isAbsolute(file)||file.includes('\\')||file.split('/').some(p=>!p||p==='.'||p==='..')||/[\u0000-\u001f]/.test(file))throw new WebsiteError('unsafe_hosting_path','Unsafe website file path.');return file;};
const exists=async(path:string)=>{try{return await lstat(path);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw e;}};
const syncDirectory=async(path:string)=>{const handle=await open(path,'r');try{await handle.sync();}finally{await handle.close();}};
const syncTree=async(path:string):Promise<void>=>{for(const entry of await readdir(path,{withFileTypes:true}))if(entry.isDirectory())await syncTree(join(path,entry.name));await syncDirectory(path);};
const writeSynced=async(path:string,bytes:Uint8Array|string)=>{const handle=await open(path,'wx',0o640);try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}};

/** Private release storage. Only serve through the explicit handler below, never its parent directory. */
export class NativeWebsiteHostingAdapter implements WebsiteHostingAdapter {
  readonly apiVersion='2' as const; readonly family='native' as const; readonly id:string;
  readonly capabilities:HostingCapabilities={emergencySuspension:true,provision:true,select:true,staging:'private',activation:'filesystem_pointer',propagation:'local',rollback:'retained_artifact',domains:'operator_managed',redirects:'portable',headers:false,unpublish:'confirmed',maxFiles:20000,maxBytes:512*1024*1024,maxFileBytes:128*1024*1024};
  constructor(readonly profile:NativeWebsiteHostingProfile, private readonly publicProbe?:(context:HostingDeploymentContext)=>Promise<import('@ubeeq/core').HostingVerification>){this.id='native:'+profile.id;const sample=profile.publicUrlTemplate.replace('{site}','a'.repeat(32));if(!profile.id||!isAbsolute(profile.root)||resolve(profile.root)==='/'||!profile.persistent||profile.writerMode!=='single'||profile.publicUrlTemplate.split('{site}').length!==2)throw new WebsiteError('invalid_hosting_profile','Native hosting needs a dedicated absolute persistent root, one writer and one {site} URL placeholder.');const url=new URL(websiteExternalUrl(sample));if(url.search||url.hash||!url.pathname.endsWith('/'))throw new WebsiteError('invalid_hosting_profile','Hosting URL must not include a query or fragment.');}
  publicUrl(workspaceId:string,targetId:string){return new URL(this.profile.publicUrlTemplate.replace('{site}',nativeWebsiteKey(workspaceId,targetId))).href;}
  private async root(){await mkdir(this.profile.root,{recursive:true,mode:0o750});const physical=await realpath(this.profile.root);if(physical!==resolve(this.profile.root))throw new WebsiteError('symlink_root','Hosting roots cannot traverse symlinks.');return physical;}
  private async site(target:WebsiteHostingTarget){const root=await this.root(),key=nativeWebsiteKey(target.workspaceId,target.id);if(target.remoteId!==key||target.publicUrl!==this.publicUrl(target.workspaceId,target.id)||target.accountId!==this.profile.id)throw new WebsiteError('target_identity_changed','Target does not match this administrator hosting profile.');const path=join(root,'targets',key);for(const p of [join(root,'targets'),path]){const st=await exists(p);if(st?.isSymbolicLink()||st&&!st.isDirectory())throw new WebsiteError('symlink_root','Hosting directories must be real directories.');await mkdir(p,{recursive:true,mode:0o750});}return path;}
  async validateTarget(target:WebsiteHostingTarget){const path=await this.site(target),ownerPath=join(path,'owner.json'),current=await exists(ownerPath);
    const expected=JSON.stringify({version:'1',marker:target.ownershipMarker,publicUrl:target.publicUrl,key:target.remoteId});
    if(current){if(current.isSymbolicLink()||await readFile(ownerPath,'utf8')!==expected)throw new WebsiteError('hosting_ownership','Hosting root belongs to another target or has drifted.');}
    else{if((await readdir(path)).length)throw new WebsiteError('hosting_ownership','Refusing to adopt a non-empty unowned hosting directory.');await writeSynced(ownerPath,expected);}
    // Exercise replacement on this actual filesystem; EXDEV/unsupported writes fail configuration.
    const probe=join(path,'.pointer-probe-'+randomUUID()),replacement=probe+'-next';try{await writeSynced(probe,'old');await writeSynced(replacement,'new');await rename(replacement,probe);if(await readFile(probe,'utf8')!=='new')throw new WebsiteError('atomic_activation_unavailable','Pointer replacement did not preserve complete bytes.');await syncDirectory(path);}finally{await rm(probe,{force:true});await rm(replacement,{force:true});}
  }
  private async safeParent(root:string,file:string){safeFile(file);const destination=join(root,file);if(relative(root,destination).startsWith('..'))throw new WebsiteError('unsafe_hosting_path','File escapes its release root.');let cursor=root;for(const part of file.split('/').slice(0,-1)){cursor=join(cursor,part);const st=await exists(cursor);if(st?.isSymbolicLink()||st&&!st.isDirectory())throw new WebsiteError('symlink_output','Output cannot traverse symlinks.');await mkdir(cursor,{recursive:true,mode:0o750});}if((await exists(destination))?.isSymbolicLink())throw new WebsiteError('symlink_output','Output cannot replace a symlink.');return destination;}
  async prepare(context:HostingDeploymentContext){const artifact=context.artifact;if(!artifact)throw new WebsiteError('artifact_unavailable','A pinned artifact is required.');const site=await this.site(context.target),releaseId=artifact.digest,releaseRoot=join(site,'releases',releaseId),stage=join(site,'.staging-'+randomUUID());
    const releases=join(site,'releases'),assets=join(site,'assets');for(const dir of [releases,assets]){const st=await exists(dir);if(st?.isSymbolicLink())throw new WebsiteError('symlink_output','Release/asset storage cannot be a symlink.');await mkdir(dir,{recursive:true,mode:0o750});}
    if(await exists(releaseRoot)){for(const [file,bytes] of artifact.files){const destination=await this.safeParent(releaseRoot,file);if(hash(await readFile(destination))!==hash(bytes))throw new WebsiteError('release_drift','An immutable release has changed.');}return {releaseId};}
    await mkdir(stage,{mode:0o750});try{for(const [file,bytes] of artifact.files){const destination=await this.safeParent(stage,file);await writeSynced(destination,bytes);
        if(/^assets\/[a-f0-9]{64}\.[a-z0-9]+$/.test(file)){const asset=join(assets,file.slice(7)),st=await exists(asset);if(st?.isSymbolicLink())throw new WebsiteError('symlink_output','Asset cannot be a symlink.');if(st){if(hash(await readFile(asset))!==hash(bytes))throw new WebsiteError('asset_drift','Retained public asset changed.');}else{try{await writeSynced(asset,bytes);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST'||hash(await readFile(asset))!==hash(bytes))throw error;}}}}
      await syncTree(stage);await syncDirectory(assets);await rename(stage,releaseRoot);await syncDirectory(releases);return {releaseId};
    }catch(error){await rm(stage,{recursive:true,force:true});throw error;}
  }
  private async pointer(context:HostingDeploymentContext,disabled:boolean){const site=await this.site(context.target),file=join(site,'current.json'),old=await exists(file);if(old?.isSymbolicLink())throw new WebsiteError('symlink_output','Current pointer cannot be a symlink.');if(old){const previous=JSON.parse(await readFile(file,'utf8'));if(previous.generation>context.generation)throw new WebsiteError('superseded','A newer native generation is active.');}
    if(!disabled&&await exists(join(site,'serving.json'))&&JSON.parse(await readFile(join(site,'serving.json'),'utf8')).state!=='active')throw new WebsiteError('serving_suspended','Clear the policy gate through an authorized resume first.');
    const releaseId=disabled?'disabled-'+context.generation:context.checkpoint.releaseId;
    if(!disabled&&(!releaseId||releaseId!==context.artifact?.digest))throw new WebsiteError('artifact_unavailable','Staged release does not match the exact artifact.');
    const temp=join(site,'.current-'+randomUUID());await writeSynced(temp,JSON.stringify({version:'1',generation:context.generation,state:disabled?'disabled':'active',releaseId,marker:context.artifact?.marker??null}));
    try{await context.beforeActivation();await rename(temp,file);await syncDirectory(site);}finally{await rm(temp,{force:true});}
    return {state:disabled?'disabled' as const:'activated' as const,releaseId,publicUrl:context.target.publicUrl};
  }
  private async policyGate(target:WebsiteHostingTarget,state:'active'|'suspended',beforeServing?:()=>Promise<void>){
    await this.validateTarget(target);const site=await this.site(target),file=join(site,'serving.json');if((await exists(file))?.isSymbolicLink())throw new WebsiteError('symlink_output','Serving gate cannot be a symlink.');
    // A crashed gate writer leaves serving denied. Never expire this lock based only on elapsed time.
    const lockPath=join(site,'.serving-lock'),lock=await open(lockPath,'wx',0o640),temp=join(site,'.serving-'+randomUUID());
    try{await writeSynced(temp,JSON.stringify({state}));await beforeServing?.();await rename(temp,file);await syncDirectory(site);}finally{await lock.close();await rm(temp,{force:true});await rm(lockPath,{force:true});await syncDirectory(site);}
  }
  async suspend(target:WebsiteHostingTarget){await this.policyGate(target,'suspended');}
  async resume(target:WebsiteHostingTarget,beforeServing:()=>Promise<void>){await this.policyGate(target,'active',beforeServing);}
  async activate(c:HostingDeploymentContext){return this.pointer(c,false);}
  async unpublish(c:HostingDeploymentContext){return this.pointer(c,true);}
  async reconcile(c:HostingDeploymentContext):Promise<HostingOutcome>{const site=await this.site(c.target);try{const value=JSON.parse(await readFile(join(site,'current.json'),'utf8'));if(value.generation===c.generation&&(c.operation==='unpublish'?value.state==='disabled':value.releaseId===c.artifact?.digest&&value.marker===c.artifact?.marker))return {state:value.state==='disabled'?'disabled':'activated',releaseId:value.releaseId,publicUrl:c.target.publicUrl};return {state:'unknown',reason:'native_pointer_not_confirmed'};}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {state:'unknown',reason:'native_pointer_missing'};throw error;}}
  async verify(c:HostingDeploymentContext,_outcome:HostingOutcome){const result=await this.reconcile(c),associationConfirmed=['activated','disabled'].includes(result.state);let publicConfirmed=false;
    const probe=this.publicProbe?await this.publicProbe(c):undefined;
    return {observedAt:new Date().toISOString(),associationConfirmed,publicConfirmed:probe?.publicConfirmed??false,locations:probe?.locations??[],reasons:probe?.reasons??['public_probe_not_configured']};
  }
}

const releaseFrameAncestors=async(root:string)=>{try{const path=join(root,'embedding.json');if(await realpath(path)!==resolve(path))return "'none'";const data=JSON.parse(await readFile(path,'utf8'));return websiteFrameAncestors(data);}catch{return "'none'";}};
/** Read-only static data plane: target/serving state is checked before asset or release lookup. */
export async function readNativeWebsite(profile:NativeWebsiteHostingProfile,url:URL,rawPath=url.pathname):Promise<{status:number;body?:Uint8Array;contentType?:string;immutable?:boolean;frameAncestors?:string}>{
  const escaped=profile.publicUrlTemplate.replace(/[.*+?^${}()|[\]\\]/g,'\\$&').replace('\\{site\\}','([a-f0-9]{32})');
  const match=(url.origin+url.pathname).match(new RegExp('^'+escaped));if(!match)return {status:404};
  if(/%(?:2f|5c|25|2e)/i.test(rawPath)||rawPath.includes('\\')||rawPath.split('/').some(p=>p==='.'||p==='..'))return {status:400};
  const key=match[1],base=new URL(profile.publicUrlTemplate.replace('{site}',key)),site=join(profile.root,'targets',key);
  if(url.origin!==base.origin||!url.pathname.startsWith(base.pathname))return {status:404};
  let path:string;try{path=decodeURIComponent(url.pathname.slice(base.pathname.length))||'index.html';safeFile(path.endsWith('/')?path+'index.html':path);}catch{return {status:400};}
  if(path.startsWith('releases/')||path.startsWith('.staging')||path.startsWith('targets/')||path==='current.json'||path==='owner.json'||path==='serving.json'||path.startsWith('.serving'))return {status:404};
  try{
    if(await realpath(profile.root)!==resolve(profile.root)||await realpath(site)!==resolve(site))return {status:503};
    const owner=JSON.parse(await readFile(join(site,'owner.json'),'utf8'));if(owner.publicUrl!==base.href||owner.key!==key)return {status:404};
    if(await exists(join(site,'.serving-lock')))return {status:410,body:Buffer.from('Website unavailable')};
    const gate=await exists(join(site,'serving.json'));if(gate){if(gate.isSymbolicLink()||JSON.parse(await readFile(join(site,'serving.json'),'utf8')).state!=='active')return {status:410,body:Buffer.from('Website unavailable')};}
    const pointer=JSON.parse(await readFile(join(site,'current.json'),'utf8'));if(pointer.state!=='active')return {status:410,contentType:'text/plain',body:Buffer.from('Website unavailable')};
    if(!/^[a-f0-9]{64}$/.test(pointer.releaseId))return {status:503};
    const immutable=/^assets\/[a-f0-9]{64}\.[a-z0-9]+$/.test(path),root=immutable?join(site,'assets'):join(site,'releases',pointer.releaseId),file=immutable?path.slice(7):path.endsWith('/')?path+'index.html':path;
    const destination=join(root,file),physical=await realpath(destination);if(physical!==resolve(destination)||!physical.startsWith(resolve(root)+'/'))return {status:403};
    const st=await lstat(destination);if(!st.isFile())return {status:404};return {status:200,body:await readFile(destination),contentType:websiteContentType(file),immutable,frameAncestors:await releaseFrameAncestors(join(site,'releases',pointer.releaseId))};
  }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'){try{const pointer=JSON.parse(await readFile(join(site,'current.json'),'utf8'));if(pointer.state==='active'&&/^[a-f0-9]{64}$/.test(pointer.releaseId)){const fallback=join(site,'releases',pointer.releaseId,'404.html');if(await realpath(fallback)!==resolve(fallback))return {status:503};const body=await readFile(fallback);return {status:404,body,contentType:'text/html; charset=utf-8',frameAncestors:await releaseFrameAncestors(join(site,'releases',pointer.releaseId))};}}catch{}return {status:404};}return {status:503};}
}
/** Authorize only exact submission endpoints emitted by the validated static renderer. */
export const nativeWebsiteFormActionPolicy=(body:Uint8Array|undefined):string=>{
  const actions=new Set<string>(),html=body?Buffer.from(body).toString('utf8'):'';
  for(const match of html.matchAll(/<form class="website-mailing-form" data-website-mailing="true" method="post" action="([^"<>\s]+)"/g)){
    try{const url=new URL(match[1]);if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||!/\/public\/mailing-list\/[A-Za-z0-9_%~-]+\/subscribe-form$/.test(url.pathname)||!/^[A-Za-z0-9%/:._~\[\]-]+$/.test(url.href))continue;actions.add(url.href);}catch{}
  }
  return actions.size&&actions.size<=20?[...actions].sort().join(' '):"'none'";
};
export const createNativeWebsiteHandler=(profiles:readonly NativeWebsiteHostingProfile[])=>async(req:IncomingMessage,res:ServerResponse)=>{
  if(!['GET','HEAD'].includes(req.method??'GET')){res.writeHead(405).end();return;}
  const host=req.headers.host;if(!host){res.writeHead(400).end();return;}
  let url:URL;try{url=new URL(req.url??'/',`http://${host}`);}catch{res.writeHead(400).end();return;}
  for(const profile of profiles){const template=new URL(profile.publicUrlTemplate.replace('{site}','a'.repeat(32)));url.protocol=template.protocol;const result=await readNativeWebsite(profile,url,(req.url??'/').split('?')[0]);if(result.status===404&&!result.body)continue;res.writeHead(result.status,{'content-type':result.contentType??'text/plain','cache-control':result.immutable?'public, max-age=31536000, immutable':'no-store','x-content-type-options':'nosniff','content-security-policy':`default-src 'none'; style-src 'self'; img-src 'self' https:; media-src 'self' https:; base-uri 'none'; frame-ancestors ${result.frameAncestors??"'none'"}; form-action ${result.contentType?.startsWith('text/html')?nativeWebsiteFormActionPolicy(result.body):"'none'"}`});res.end(req.method==='HEAD'?undefined:result.body);return;}
  res.writeHead(404,{'cache-control':'no-store'}).end('Website not found');
};
