import { createHash } from 'node:crypto';
import { WebsiteError, HostingActivationRejected, type HostingDeploymentContext, type HostingVerification } from '@ubeeq/core';
import { readBoundedResponseText } from './bounded-response-text.js';
import { parseRetryAfterSeconds } from './provider-errors.js';

export type HostingFetch = (url:string,init?:RequestInit)=>Promise<Response>;
export class HostingProviderError extends WebsiteError {
  constructor(code:string,readonly retryAfterSeconds?:number){super(code,'Hosting provider request failed. Reconnect, wait for the provider cooldown, or reconcile the recorded deployment.');}
}
/** Fixed provider origin, bounded responses, no redirects, no provider body/error leakage. */
export class HostingHttp {
  constructor(readonly origin:string,private readonly transport:HostingFetch=fetch){if(!origin.startsWith('https://')||new URL(origin).origin!==origin)throw new Error('A fixed HTTPS provider origin is required.');}
  async request(path:string,token:string,init:RequestInit={},raw=false):Promise<any>{
    if(!path.startsWith('/')||path.startsWith('//')||path.includes('\\'))throw new WebsiteError('invalid_provider_path','Invalid provider API path.');
    let response:Response;
    try{response=await this.transport(this.origin+path,{...init,headers:{...init.headers,authorization:'Bearer '+token,'user-agent':'Ubeeq website publishing'},redirect:'error',signal:AbortSignal.timeout(30000)});}catch{throw new HostingProviderError('provider_outcome_unknown');}
    if(!response.ok){await response.body?.cancel().catch(()=>{});const code=response.status===401||response.status===403?'reconnect_required':response.status===429?'rate_limited':response.status>=500?'provider_outcome_unknown':'provider_rejected';const cooldown=parseRetryAfterSeconds(response.headers.get('retry-after'));if(response.status<500&&['POST','PUT','PATCH','DELETE'].includes(init.method??''))throw new HostingActivationRejected(code,cooldown);throw new HostingProviderError(code,cooldown);}
    if(response.status===204){await response.body?.cancel();return {};}
    const text=await readBoundedResponseText(response,8*1024*1024);
    if(raw)return text;
    try{return text?JSON.parse(text):{};}catch{throw new HostingProviderError('provider_invalid_response');}
  }
}
export const hostingJson=(value:unknown)=>({headers:{'content-type':'application/json'},body:JSON.stringify(value)});
export const hostingPath=(value:string)=>{if(!value||value.length>500||/[\u0000-\u001f]/.test(value))throw new WebsiteError('invalid_remote_identity','A stable provider identity is required.');return encodeURIComponent(value);};
export const hostingMime=(file:string)=>({html:'text/html',css:'text/css',json:'application/json',xml:'application/xml',txt:'text/plain',jpg:'image/jpeg',png:'image/png',gif:'image/gif',webp:'image/webp',avif:'image/avif',mp4:'video/mp4',webm:'video/webm',mp3:'audio/mpeg',ogg:'audio/ogg',pdf:'application/pdf'} as Record<string,string>)[file.split('.').pop()??'']??'application/octet-stream';
export type HostingPublicProbe=(context:HostingDeploymentContext)=>Promise<HostingVerification>;
/** Caller supplies its outbound/DNS policy. Provider authorization is never sent to a public origin. */
export const createHostingPublicProbe=(input:{authorizeUrl:(url:URL)=>Promise<void>;fetch?:HostingFetch;verifyContents?:boolean}):HostingPublicProbe=>async context=>{
  const locations:string[]=[],reasons:string[]=[];const base=new URL(context.target.publicUrl),transport=input.fetch??fetch;
  const request=async(path:string,method='GET')=>{const url=new URL(path,base);if(url.origin!==base.origin||!url.pathname.startsWith(base.pathname))throw new WebsiteError('unsafe_probe','Probe escaped its exact public target.');await input.authorizeUrl(url);const res=await transport(url.href,{method,redirect:'error',signal:AbortSignal.timeout(10000),headers:input.verifyContents?{}:{'cache-control':'no-cache'}});locations.push(url.href);return res;};
  try{
    const marker=await request('ubeeq-release.json');
    if(context.operation==='unpublish'){const status=marker.status;await marker.body?.cancel();return {observedAt:new Date().toISOString(),associationConfirmed:true,publicConfirmed:status===404||status===410,locations,reasons:status===404||status===410?[]:['serving_still_enabled']};}
    if(marker.status!==200)throw new Error('marker');const bytes=await readBoundedResponseText(marker,1024);if(JSON.parse(bytes).release!==context.artifact?.marker)throw new Error('marker');
    const paths=['',...[...context.artifact!.files.keys()].filter(p=>p.endsWith('/index.html')).slice(0,1).map(p=>p.slice(0,-10)),...[...context.artifact!.files.keys()].filter(p=>p.startsWith('assets/')&&p.endsWith('.css')).slice(0,1),...[...context.artifact!.files.keys()].filter(p=>p.startsWith('assets/')&&!p.endsWith('.css')).slice(0,1)];
    for(const path of paths){const result=await request(path,input.verifyContents?'GET':'HEAD');const expected=path.startsWith('assets/')?hostingMime(path):'text/html';if(result.status!==200||!result.headers.get('content-type')?.toLowerCase().startsWith(expected))reasons.push('path_or_content_type_mismatch');if(input.verifyContents&&result.status===200){const expectedBytes=context.artifact!.files.get(path===''?'index.html':path.endsWith('/')?path+'index.html':path);const hash=createHash('sha256'),reader=result.body?.getReader();let bytes=0;if(reader)try{while(true){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.byteLength;if(bytes>8*1024*1024){await reader.cancel();throw new Error('file_limit');}hash.update(chunk.value);}}finally{reader.releaseLock();}if(!expectedBytes||hash.digest('hex')!==createHash('sha256').update(expectedBytes).digest('hex'))reasons.push('file_hash_mismatch');}else await result.body?.cancel();}
    const missing=await request('ubeeq-missing-'+context.artifact!.marker.slice(0,16)+'/','HEAD');if(missing.status!==404)reasons.push('404_behavior_mismatch');await missing.body?.cancel();
  }catch{reasons.push('public_probe_pending');}
  return {observedAt:new Date().toISOString(),associationConfirmed:true,publicConfirmed:!reasons.length,locations,reasons};
};
/** Pure provider configuration generation happens before artifact hashing, not during upload. */
export const hostingRedirectFiles=(input:ReadonlyMap<string,Uint8Array>)=>{const files=new Map(input),raw=files.get('redirects.json');if(raw){const data=JSON.parse(Buffer.from(raw).toString('utf8'));const lines=(data.redirects??[]).map((r:{from:string;to:string;status:number})=>{if(/[\r\n\s]/.test(r.from+r.to)||![301,308].includes(r.status))throw new WebsiteError('invalid_redirect','Unsafe provider redirect intention.');return `${r.from} ${r.to} ${r.status}`;});if(lines.length)files.set('_redirects',Buffer.from(lines.join('\n')+'\n'));}return files;};
