import { parseRetryAfterSeconds } from './provider-errors.js';
import { createHash } from 'node:crypto';
import { WebsiteError, type HostingConnection, type HostingCapabilities, type HostingDeploymentContext, type WebsiteHostingAdapter, type WebsiteHostingTarget } from '@ubeeq/core';
import { HostingHttp, HostingProviderError, hostingJson, hostingPath, type HostingFetch, type HostingPublicProbe } from './website-hosting-http.js';

// Reviewed OpenAPI 2.1.3, SHA256 52558306fe22c49c1d71db63ae22d153d030ce1953d5ee9f89c9de408f736a8c (2026-10-21).
export interface HostingerWebsite { domain: string; username?: string; client_id?: number; website_type?: string; is_enabled?: boolean; vhost_type?: string; }
export type HostingerDestinationCheck={id:string;label:string;status:'passed'|'failed';message?:string;code?:string};
type Check= <T>(id:string,label:string,operation:()=>Promise<T>)=>Promise<T>;
const checkDirect:Check=(_id,_label,operation)=>operation();
export class HostingerWebsiteHostingAdapter implements WebsiteHostingAdapter {
  readonly apiVersion = '2' as const;
  readonly id = 'hostinger-static-root'; readonly family = 'hostinger' as const;
  readonly capabilities: HostingCapabilities = { provision:false, select:true, staging:'public', activation:'in_place', propagation:'provider', rollback:'retained_artifact', domains:'operator_managed', redirects:'portable', headers:false, unpublish:'operator_required', maxFiles:10000, maxBytes:50*1024*1024, maxFileBytes:8*1024*1024 };
  private http: HostingHttp;
  private static budgets=new Map<string,Promise<void>>();
  constructor(private ports: { credential(c:HostingConnection):Promise<string>; probe:HostingPublicProbe; fetch?:HostingFetch; uploadHosts?:readonly string[]; authorizeUploadUrl?:(url:URL)=>Promise<void>; requestIntervalMs?:number; }) {
    const transport=ports.fetch??fetch;
    this.http=new HostingHttp('https://developers.hostinger.com',async(url,init)=>{
      const key=createHash('sha256').update(new Headers(init?.headers).get('authorization')??'').digest('hex');
      const prior=HostingerWebsiteHostingAdapter.budgets.get(key)??Promise.resolve();
      let release!:()=>void;const done=new Promise<void>(resolve=>release=resolve);
      const tail=prior.catch(()=>{}).then(()=>done);HostingerWebsiteHostingAdapter.budgets.set(key,tail);
      await prior.catch(()=>{});
      let cooldown=ports.requestIntervalMs??1000;
      try {const response=await transport(url,init);if(response.status===409&&(!init?.method||init.method==='GET'||new URL(url).pathname.endsWith('/upload-urls'))){const seconds=Number(response.headers.get('retry-after'));await response.body?.cancel();throw new HostingProviderError('setup_pending',Number.isFinite(seconds)&&seconds>0?seconds:15);}if(response.status===429){const seconds=Number(response.headers.get('retry-after'));if(Number.isFinite(seconds)&&seconds>0)cooldown=Math.max(cooldown,Math.min(900000,seconds*1000));}return response;} finally {setTimeout(()=>{release();if(HostingerWebsiteHostingAdapter.budgets.get(key)===tail)HostingerWebsiteHostingAdapter.budgets.delete(key);},cooldown);}
    });
  }
  async discover(token:string):Promise<HostingerWebsite[]> {
    const result:HostingerWebsite[]=[];
    for(let page=1;page<=100;page++) {
      const body=await this.http.request('/api/hosting/v1/websites?per_page=100&page='+page,token);
      if(!Array.isArray(body.data))throw new WebsiteError('provider_invalid_response','Hostinger website discovery was incomplete.');
      result.push(...body.data);
      if(body.meta?.last_page!==undefined ? page>=body.meta.last_page : body.data.length<100)return result;
    }
    throw new WebsiteError('provider_limit','Too many Hostinger websites. Discovery must complete before selecting a destination.');
  }
  private async token(c?:HostingConnection) { if(!c||c.family!=='hostinger'||c.authorization!=='api_token'||c.state!=='connected')throw new WebsiteError('reconnect_required','Reconnect the Hostinger API token.'); return this.ports.credential(c); }
  async sites(c:HostingConnection) {
    return (await this.discover(await this.token(c))).filter(row=>String(row.client_id)===c.accountId).map(row=>{
      const eligible=row.website_type==='other'&&row.is_enabled===true&&!!row.username&&['main','addon'].includes(row.vhost_type??'');
      const reason=row.website_type==='builder'?'Website Builder cannot receive generated website files.':row.website_type!=='other'?'Only file-based hosting supports direct publishing.':row.is_enabled!==true?'Enable this website in Hostinger before connecting.':!row.username?'Hostinger has not assigned a hosting username yet.':!['main','addon'].includes(row.vhost_type??'')?'Aliases and unsupported virtual hosts cannot be publishing destinations.':'Select this site and validate its setup before connecting.';
      return {id:row.domain,name:row.domain,publicUrl:'https://'+row.domain+'/',type:row.website_type,eligible,reason};
    });
  }
  private path(t:WebsiteHostingTarget,suffix:string) { return '/api/hosting/v1/accounts/'+hostingPath(t.config.username)+'/websites/'+hostingPath(t.remoteId)+suffix; }
  async validateTarget(t:WebsiteHostingTarget,c?:HostingConnection) { await this.checkTarget(t,c); }
  private async checkTarget(t:WebsiteHostingTarget,c?:HostingConnection,check:Check=checkDirect) {
    const token=await check('identity','Account access and website identity',async()=>{
      const token=await this.token(c),url=new URL(t.publicUrl);
      if(t.accountId!==c!.accountId||url.protocol!=='https:'||url.hostname!==t.remoteId||url.port||url.pathname!=='/'||t.basePath!=='/'||url.search||url.hash||!['replace_root','replace_existing_root'].includes(t.config.adoption))throw new WebsiteError('hostinger_adoption_required','Select a website in this Hostinger account and acknowledge whole-site replacement.');
      return token;
    });
    await check('hosting','Supported file-based hosting',async()=>{
      const site=(await this.discover(token)).find(row=>row.domain===t.remoteId&&String(row.client_id)===t.accountId);
      if(!site||site.website_type!=='other'||site.is_enabled!==true||!['main','addon'].includes(site.vhost_type??'')||site.username!==t.config.username)throw new WebsiteError('unsupported_target','Hostinger identity or type changed. Builder, WordPress, Node.js, aliases and unknown sites cannot be replaced.');
    });
    await check('setup','Hostinger setup completed',async()=>{
      const setups=await this.http.request('/api/hosting/v1/onboardings?domain='+hostingPath(t.remoteId),token),rows=Array.isArray(setups)?setups:setups.data;
      if(!Array.isArray(rows)||rows.some((row:any)=>row.domain===t.remoteId&&row.status!=='completed'))throw new WebsiteError('setup_pending','Wait for Hostinger website setup to complete, then validate again.');
    });
    await check('git','No conflicting Git deployment',async()=>{
      const git=await this.http.request(this.path(t,'/git/auto-deployments/settings'),token);
      if(git&&(git.repository||git.repository_url||git.installation_uuid||git.is_enabled===true))throw new WebsiteError('remote_git_conflict','Disconnect the existing Git deployment in Hostinger, then validate again.');
      const repositories=await this.http.request(this.path(t,'/git/repositories'),token),configured=Array.isArray(repositories)?repositories:repositories.data;
      if(!Array.isArray(configured)||configured.length)throw new WebsiteError('remote_git_conflict','Remove conflicting Git repositories from this website in Hostinger, then validate again.');
    });
  }
  async validateAdoption(t:WebsiteHostingTarget,c?:HostingConnection,archive?:string) { await this.checkAdoption(t,c,archive); }
  private async checkAdoption(t:WebsiteHostingTarget,c?:HostingConnection,archive?:string,check:Check=checkDirect) {
    await this.checkTarget(t,c,check);
    await check('root','Website folder safe to replace',async()=>{
      const token=await this.token(c),fileRoot='/api/hosting/v1/accounts/'+hostingPath(t.config.username)+'/domains/'+hostingPath(t.remoteId)+'/files';
      const listing=await this.http.request(fileRoot+'?max_depth=1&max_items=1',token);
      if(!Array.isArray(listing.items)||!Number.isSafeInteger(listing.total_items)||listing.total_items<0||listing.total_items>0&&!listing.items.length)throw new WebsiteError('root_unknown','Hostinger website contents could not be assessed. Try validating again.');
      if(listing.total_items>0&&!(listing.total_items===1&&archive&&listing.items[0]?.name===archive&&listing.items[0]?.type==='file')){
        if(!t.activeReleaseId){
          if(t.config.adoption==='replace_existing_root')return;
          throw new WebsiteError('root_not_empty','This website already contains files. Back up the current files, then confirm Replace existing website contents to allow overwriting, or choose an empty website. Validation does not remove files.');
        }
        const marker=await this.http.request(fileRoot+'/content?path=ubeeq-release.json&max_lines=10',token);
        let release;try{release=JSON.parse(marker.content).release;}catch{throw new WebsiteError('remote_drift','The managed release marker is missing. Review the website contents before replacing them.');}
        if(release!==t.activeReleaseId)throw new WebsiteError('remote_drift','Hostinger content changed outside this publisher. Review it before replacing it.');
      }
    });
  }
  async validateDestination(t:WebsiteHostingTarget,c:HostingConnection) {
    const checks:HostingerDestinationCheck[]=[];
    const check:Check=async(id,label,operation)=>{try{const value=await operation();checks.push({id,label,status:'passed'});return value;}catch(error){checks.push({id,label,status:'failed',code:error instanceof WebsiteError?error.code:'validation_failed',message:error instanceof WebsiteError?error.message:'This check could not be completed. Try validating again.'});throw error;}};
    try{
      await this.checkAdoption(t,c,undefined,check);
      await check('upload','Secure Hostinger upload endpoint',async()=>{const session=await this.uploadSession(t,c);await this.ports.authorizeUploadUrl?.(session.url);});
    }catch{return {valid:false,checkedAt:new Date().toISOString(),checks};}
    return {valid:true,checkedAt:new Date().toISOString(),checks};
  }
  private uploadUrl(value:string) {
    let u:URL;try{u=new URL(value);}catch{throw new WebsiteError('unsafe_upload_host','Hostinger returned an invalid upload endpoint.');}
    // Hostinger OpenAPI UploadUrlResource documents srv12345-files.hstgr.io.
    const providerHost=/^srv[0-9]+-files\.hstgr\.io$/.test(u.hostname);
    if(u.protocol!=='https:'||u.username||u.password||u.port||u.search||u.hash||!providerHost&&!this.ports.uploadHosts?.includes(u.hostname))throw new WebsiteError('unsafe_upload_host','Hostinger returned an unsupported upload endpoint. No upload credentials were sent to it.');
    return u;
  }
  private async uploadSession(t:WebsiteHostingTarget,c?:HostingConnection) {
    const session=await this.http.request('/api/hosting/v1/files/upload-urls',await this.token(c),{method:'POST',...hostingJson({username:t.config.username,domain:t.remoteId})});
    if(typeof session.auth_key!=='string'||!session.auth_key||typeof session.rest_auth_key!=='string'||!session.rest_auth_key||typeof session.url!=='string')throw new WebsiteError('provider_invalid_response','Hostinger did not return a complete upload session.');
    return {url:this.uploadUrl(session.url),auth:session.auth_key,restAuth:session.rest_auth_key};
  }
  async prepare(c:HostingDeploymentContext) {
    await this.validateAdoption(c.target,c.connection,c.checkpoint.data?.archive);
    if(c.checkpoint.data?.uploaded==='true')return c.checkpoint;
    const artifact=c.artifact!;
    if(artifact.zip.length>this.capabilities.maxBytes||artifact.files.size>this.capabilities.maxFiles||!artifact.files.has('index.html'))throw new WebsiteError('provider_limit','Hostinger static artifact exceeds the configured limits.');
    for(const path of artifact.files.keys())if(path.startsWith('/')||path.split('/').some(p=>p==='..'||p==='.'||!p)||/[\\\x00-\x1f]/.test(path)||/\.(php\d*|phtml|phar|cgi|py|sh|env|map)$/i.test(path))throw new WebsiteError('unsafe_artifact','Only generated public static files can be deployed.');
    const startedAt=c.checkpoint.data?.uploadStartedAt??new Date().toISOString();
    if(Date.now()-Date.parse(startedAt)>600000)throw new WebsiteError('upload_deadline','Hostinger upload expired. Review the partial archive before starting a new release.');
    const archive='ubeeq-'+createHash('sha256').update(c.attemptId).digest('hex')+'.zip';
    await c.beforeUpload?.();
    const session=await this.uploadSession(c.target,c.connection),url=session.url;
    url.pathname=url.pathname.replace(/\/$/,'')+'/'+archive;url.search='override=true';
    const transport=this.ports.fetch??fetch;
    const headers={'Tus-Resumable':'1.0.0','X-Auth':session.auth,'X-Auth-Rest':session.restAuth};
    const request=async(method:string,extra:Record<string,string>={},body?:Uint8Array)=>{
      let response:Response;try{response=await transport(url.href,{method,headers:{...headers,...extra},body:body?Buffer.from(body):undefined,redirect:'error',signal:AbortSignal.timeout(30000)});}catch{throw new HostingProviderError('upload_interrupted');}
      if(!response.ok&&response.status!==404){await response.body?.cancel();throw new HostingProviderError(response.status===429?'rate_limited':'upload_interrupted',parseRetryAfterSeconds(response.headers.get('retry-after')));}return response;
    };
    // On resume, ask TUS for the authoritative offset. Secrets/URLs never enter checkpoints.
    let offset=0;
    if(c.checkpoint.data?.archive===archive) {
      const head=await request('HEAD');
      if(head.status!==404) {offset=Number(head.headers.get('upload-offset'));if(Number(head.headers.get('upload-length'))!==artifact.zip.length||!head.headers.has('upload-offset'))throw new WebsiteError('upload_identity_changed','TUS upload length changed.');}await head.body?.cancel();
      if(head.status===404)offset=-1;
    } else offset=-1;
    if(offset<0){await c.beforeUpload?.();await c.saveCheckpoint({data:{...c.checkpoint.data,archive,uploadStartedAt:startedAt,uploaded:'false'}});const created=await request('POST',{'Upload-Length':String(artifact.zip.length),'Upload-Offset':'0'});if(created.status!==201)throw new WebsiteError('upload_interrupted','Hostinger did not create the upload.');await created.body?.cancel();offset=0;}
    const deadline=Date.now()+600000;
    while(offset<artifact.zip.length){
      if(!Number.isSafeInteger(offset)||offset<0||Date.now()>deadline)throw new WebsiteError('upload_interrupted','Hostinger upload needs to resume.');
      await c.beforeUpload?.();
      const end=Math.min(offset+1024*1024,artifact.zip.length),response=await request('PATCH',{'Content-Type':'application/offset+octet-stream','Upload-Offset':String(offset)},artifact.zip.subarray(offset,end));
      const received=Number(response.headers.get('upload-offset'));await response.body?.cancel();
      if(response.status!==204||received!==end)throw new WebsiteError('upload_interrupted','Hostinger did not confirm the uploaded byte count.');offset=end;
      await c.saveCheckpoint({data:{...c.checkpoint.data,archive,uploadStartedAt:startedAt,uploaded:'false',offset:String(offset)}});
    }
    if(offset!==artifact.zip.length)throw new WebsiteError('upload_identity_changed','TUS offset exceeds the selected artifact.');
    return {data:{...c.checkpoint.data,archive,uploadStartedAt:startedAt,uploaded:'true'}};
  }
  async activate(c:HostingDeploymentContext) {
    if(c.checkpoint.data?.uploaded!=='true'||!/^ubeeq-[a-f0-9]{64}\.zip$/.test(c.checkpoint.data.archive??''))throw new WebsiteError('upload_incomplete','Upload must complete before deployment.');
    // Validate discovery again, but root includes our uploaded archive now. Root eligibility was checked before upload.
    await this.validateAdoption(c.target,c.connection,c.checkpoint.data?.archive);
    const rows=await this.discover(await this.token(c.connection));
    if(!rows.some(s=>s.domain===c.target.remoteId&&s.username===c.target.config.username&&String(s.client_id)===c.target.accountId&&s.website_type==='other'&&s.is_enabled===true))throw new WebsiteError('target_identity_changed','Hostinger target changed during upload.');
    await c.beforeActivation();await c.saveCheckpoint({...c.checkpoint,data:{...c.checkpoint.data,deployRequested:'true',requestedAt:new Date().toISOString()}});
    await this.http.request(this.path(c.target,'/deploy'),await this.token(c.connection),{method:'POST',...hostingJson({archive_path:c.checkpoint.data.archive})});
    return {state:'pending' as const,reason:'hostinger_verification_pending'};
  }
  async reconcile(c:HostingDeploymentContext) {
    const probe=await this.ports.probe(c);
    return probe.publicConfirmed?{state:'activated' as const,releaseId:c.artifact!.marker,publicUrl:c.target.publicUrl}:{state:'unknown' as const,reason:'hostinger_live_version_unconfirmed'};
  }
  async verify(c:HostingDeploymentContext) { return this.ports.probe(c); }
}
