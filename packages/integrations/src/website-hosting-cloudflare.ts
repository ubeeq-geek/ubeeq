import { hash as blake3 } from 'blake3-wasm';
import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import { WebsiteError, type HostingCapabilities, type HostingDeploymentContext, type HostingOutcome, type HostingConnection, type HostingDomain, type WebsiteHostingAdapter, type WebsiteHostingTarget } from '@ubeeq/core';
import { HostingHttp, hostingJson, hostingMime, hostingPath, hostingRedirectFiles, type HostingFetch, type HostingPublicProbe } from './website-hosting-http.js';

export const cloudflarePagesAttemptTag=(context:HostingDeploymentContext)=>'Ubeeq attempt '+createHash('sha256').update(context.attemptId).digest('hex');
export const cloudflarePagesAssetHash=(path:string,bytes:Uint8Array)=>blake3(Buffer.from(bytes).toString('base64')+extname(path).slice(1)).toString('hex').slice(0,32);
export class CloudflarePagesWebsiteHostingAdapter implements WebsiteHostingAdapter {
  readonly apiVersion='2' as const;readonly id='cloudflare-pages';readonly family='cloudflare-pages' as const;
  readonly capabilities:HostingCapabilities={provision:true,select:true,staging:'public',activation:'release_reference',propagation:'provider',rollback:'retained_artifact',domains:'provider_assisted',redirects:'native',headers:false,unpublish:'operator_required',maxFiles:20000,maxBytes:512*1024*1024,maxFileBytes:25*1024*1024};
  private readonly http:HostingHttp;
  constructor(private readonly ports:{credential:(connection:HostingConnection)=>Promise<string>;probe:HostingPublicProbe;fetch?:HostingFetch}){this.http=new HostingHttp('https://api.cloudflare.com',ports.fetch);}
  private async token(c?:HostingConnection){if(!c||c.family!=='cloudflare-pages'||c.authorization!=='api_token'||c.state!=='connected')throw new WebsiteError('reconnect_required','Cloudflare Pages requires a restricted API-token connection.');return this.ports.credential(c);}
  private root(account:string){if(!/^[a-f0-9]{32}$/i.test(account))throw new WebsiteError('invalid_remote_identity','Use the exact Cloudflare account ID.');return `/client/v4/accounts/${account}/pages/projects`;}
  private async result(path:string,token:string,init:RequestInit={}){const body=await this.http.request(path,token,init);if(body.success!==true)throw new WebsiteError('provider_rejected','Cloudflare did not confirm the API operation.');return body.result;}
  async projects(c:HostingConnection){return this.result(this.root(c.accountId),await this.token(c));}
  async createProject(c:HostingConnection,name:string,productionBranch='main'){return this.result(this.root(c.accountId),await this.token(c),{method:'POST',...hostingJson({name,production_branch:productionBranch})});}
  private path(t:WebsiteHostingTarget){if(!/^[a-z0-9][a-z0-9-]*$/.test(t.config.projectName??''))throw new WebsiteError('invalid_remote_identity','Project name must come from the selected account catalogue.');return this.root(t.accountId)+'/'+hostingPath(t.config.projectName);}
  async validateTarget(t:WebsiteHostingTarget,c?:HostingConnection){if(new URL(t.publicUrl).pathname!=='/')throw new WebsiteError('unsupported_base_path','This provider profile serves the artifact at the site root.');if(c?.accountId!==t.accountId)throw new WebsiteError('target_identity_changed','Cloudflare connection account mismatch.');const project=await this.result(this.path(t),await this.token(c));if(project.id!==t.remoteId||project.source)throw new WebsiteError('unsupported_project','Select a Direct Upload project; Git-integrated projects are not converted.');if(project.production_branch!==t.config.productionBranch)throw new WebsiteError('target_identity_changed','Production branch differs from the approved target configuration.');if(new URL(t.publicUrl).hostname!==project.subdomain&&!(project.domains??[]).includes(new URL(t.publicUrl).hostname))throw new WebsiteError('public_url_mismatch','Public URL is not mapped to this Pages project.');}
  transformFiles=hostingRedirectFiles;
  async prepare(c:HostingDeploymentContext){const token=await this.token(c.connection),artifact=c.artifact!,manifest:Record<string,string>={};if(artifact.files.size>this.capabilities.maxFiles||[...artifact.files.values()].some(b=>b.length>this.capabilities.maxFileBytes))throw new WebsiteError('provider_limit','Cloudflare Pages file limits exceeded.');
    const session=await this.result(this.path(c.target)+'/upload-token',token);if(typeof session.jwt!=='string')throw new WebsiteError('provider_invalid_response','Cloudflare did not return an upload session.');
    for(const [path,bytes] of artifact.files){if(path==='_redirects'||path==='_headers')continue;manifest['/'+path]=cloudflarePagesAssetHash(path,bytes);}
    const missing=await this.result('/client/v4/pages/assets/check-missing',session.jwt,{method:'POST',...hostingJson({hashes:Object.values(manifest)})});
    if(!Array.isArray(missing)||missing.length>artifact.files.size)throw new WebsiteError('provider_invalid_response','Invalid Pages missing-asset response.');
    // Sequential bounded batches; an upload session token never leaves the fixed API origin.
    for(const digest of missing){const item=[...artifact.files].find(([p])=>manifest['/'+p]===digest);if(!item)throw new WebsiteError('provider_invalid_response','Unknown asset hash requested.');await this.result('/client/v4/pages/assets/upload',session.jwt,{method:'POST',...hostingJson([{key:digest,value:Buffer.from(item[1]).toString('base64'),metadata:{contentType:hostingMime(item[0])},base64:true}])});}
    await this.result('/client/v4/pages/assets/upsert-hashes',session.jwt,{method:'POST',...hostingJson({hashes:Object.values(manifest)})});
    return {data:{manifest:JSON.stringify(manifest)}};
  }
  async activate(c:HostingDeploymentContext):Promise<HostingOutcome>{const token=await this.token(c.connection);const project=await this.result(this.path(c.target),token);if(project.id!==c.target.remoteId||project.source)throw new WebsiteError('target_identity_changed','Pages project changed.');if(c.target.activeReleaseId&&project.canonical_deployment?.id!==c.target.activeReleaseId)throw new WebsiteError('remote_drift','Pages production changed outside Ubeeq.');
    const form=new FormData();form.set('manifest',c.checkpoint.data?.manifest??'{}');form.set('branch',c.target.config.productionBranch);form.set('commit_hash',c.artifact!.marker.slice(0,40));form.set('commit_message',cloudflarePagesAttemptTag(c));form.set('commit_dirty','false');for(const name of ['_redirects','_headers']){const bytes=c.artifact!.files.get(name);if(bytes)form.set(name,new Blob([Buffer.from(bytes)]),name);}
    await c.beforeActivation();const deployment=await this.result(this.path(c.target)+'/deployments',token,{method:'POST',body:form});if(!deployment.id)throw new WebsiteError('provider_invalid_response','Pages did not return a deployment identity.');await c.saveCheckpoint({...c.checkpoint,releaseId:deployment.id});return this.reconcile(c);
  }
  async reconcile(c:HostingDeploymentContext):Promise<HostingOutcome>{const token=await this.token(c.connection),project=await this.result(this.path(c.target),token);if(project.id!==c.target.remoteId)throw new WebsiteError('target_identity_changed','Pages project identity changed.');let id=c.checkpoint.releaseId;
    if(!id){const deployments=await this.result(this.path(c.target)+'/deployments?env=production&per_page=100',token);const candidates=deployments.filter((d:any)=>d.environment==='production'&&d.deployment_trigger?.metadata?.commit_hash===c.artifact?.marker.slice(0,40)&&d.deployment_trigger?.metadata?.commit_message===cloudflarePagesAttemptTag(c));if(candidates.length===1)id=candidates[0].id;}
    if(!id)return {state:'unknown',reason:'pages_deployment_identity_unknown'};
    const deployment=await this.result(this.path(c.target)+'/deployments/'+hostingPath(id),token);
    if(deployment.environment!=='production'||deployment.deployment_trigger?.metadata?.commit_hash!==c.artifact?.marker.slice(0,40)||deployment.deployment_trigger?.metadata?.commit_message!==cloudflarePagesAttemptTag(c))throw new WebsiteError('target_identity_changed','Pages deployment is not the intended production artifact.');
    return deployment.latest_stage?.status==='success'&&project.canonical_deployment?.id===id?{state:'activated',releaseId:id,publicUrl:c.target.publicUrl}:{state:'pending',releaseId:id,reason:'pages_production_verification_pending'};
  }
  async domain(input:{target:WebsiteHostingTarget;connection?:HostingConnection;domain:HostingDomain;operation:'request'|'verify'|'remove'}):Promise<Pick<HostingDomain,'state'|'instructions'|'providerId'>>{
    const {target,domain,operation}=input;await this.validateTarget(target,input.connection);const token=await this.token(input.connection),path=this.path(target)+'/domains';
    if(operation==='remove'){await this.result(path+'/'+hostingPath(domain.hostname),token,{method:'DELETE'});return {state:'removed',providerId:domain.hostname,instructions:['Remove obsolete DNS records separately.']};}
    const result=operation==='request'?await this.result(path,token,{method:'POST',...hostingJson({name:domain.hostname})}):await this.result(path+'/'+hostingPath(domain.hostname),token);
    return {state:result.status==='active'?'ready':result.validation_data?.status==='pending'?'verification_pending':'certificate_pending',providerId:result.id??domain.hostname,instructions:result.status==='active'?['Provider domain is ready. Verify public serving before selecting it as the primary URL.']:['Follow the Pages custom-domain ownership, CNAME and certificate instructions for this exact project. The prior URL remains active.']};
  }
  async verify(c:HostingDeploymentContext,_outcome:HostingOutcome){const association=await this.reconcile(c),probe=await this.ports.probe(c);return {...probe,associationConfirmed:association.state==='activated'};}
}
