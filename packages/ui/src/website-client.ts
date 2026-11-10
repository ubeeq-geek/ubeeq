import {WEBSITE_PREVIEW_CHUNK_BYTES,WEBSITE_PREVIEW_MAX_FILE_BYTES,WEBSITE_PREVIEW_MAX_ARTIFACT_BYTES,type Website,type WebsiteDocument} from '@ubeeq/core';
import type { WebsiteWorkspaceClient } from './website-workspace.js';
import {validateWebsitePreviewManifest,type WebsitePreviewManifest,type WebsitePreviewFiles} from './website-preview-files.js';

export interface WebsiteClientOptions {previewMaxFileBytes?:number;}
class WebsiteRequestError extends Error {constructor(message:string,readonly status:number){super(message);}}
const checksum=async(bytes:Uint8Array<ArrayBuffer>)=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
const base64=(bytes:Uint8Array)=>{const parts:string[]=[];for(let at=0;at<bytes.length;at+=32768)parts.push(String.fromCharCode(...bytes.subarray(at,at+32768)));return btoa(parts.join(''));};

/** In-memory bearer provider, same-origin API transport; no credentials enter preview HTML. */
export class WebsiteClient implements WebsiteWorkspaceClient {
  private previewManifests=new Map<string,WebsitePreviewManifest>();
  private previewBytes=new Map<string,{base64:string;size:number}>();
  private previewByteCount=0;
  private previewCredential?:string;
  private rangeActive=0;
  private rangeWaiters:Array<()=>void>=[];
  private readonly previewMaxFileBytes:number;
  constructor(private readonly websiteId: string, private readonly token: () => string | undefined, private readonly basePath = '/api/v1/websites',options:WebsiteClientOptions={}) {
    if(!websiteId || !basePath.startsWith('/') || basePath.startsWith('//') || /[?#\\]/.test(basePath)) throw new Error('A website ID and same-origin API path are required.');
    this.previewMaxFileBytes=options.previewMaxFileBytes??WEBSITE_PREVIEW_MAX_FILE_BYTES;
    if(!Number.isSafeInteger(this.previewMaxFileBytes)||this.previewMaxFileBytes<1||this.previewMaxFileBytes>WEBSITE_PREVIEW_MAX_ARTIFACT_BYTES)throw new Error('Preview file limit must be between 1 byte and 512 MiB.');
  }
  private async request(path:string,method='GET',body?:unknown,options:{headers?:Record<string,string>;signal?:AbortSignal;credential?:string}={}) {
    const credential=this.token();
    if(options.credential!==undefined&&credential!==options.credential)throw new Error('Sign-in changed while loading the preview. Open it again.');
    if(credential!==this.previewCredential){this.previewManifests.clear();this.previewBytes.clear();this.previewByteCount=0;this.previewCredential=credential;}
    if(!credential)throw new Error('Sign in to manage a website.');
    const response=await fetch(this.basePath+path,{method,headers:{...options.headers,authorization:`Bearer ${credential}`,...(body===undefined?{}:{'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),cache:'no-store',redirect:'error',signal:options.signal});
    if(!response.ok){let message='Website operation failed.';try{message=(await response.json()).error?.message??message;}catch{}throw new WebsiteRequestError(message,response.status);}
    return response;
  }
  private hosting(path:string,method='GET',body?:unknown){return this.request('/'+encodeURIComponent(this.websiteId)+'/hosting/'+path,method,body);}
  async hostingConnections(){return (await(await this.request('/hosting-connections')).json()).connections;}
  async hostingConnectionAction(action:string,body:Record<string,unknown>){return (await this.request('/hosting-connections/'+encodeURIComponent(action),'POST',body)).json();}
  async hostingChoices(){return (await(await this.hosting('choices')).json()).choices;}
  async hostingHistory(){return (await this.hosting('history')).json();}
  async createNativeTarget(adapterId:string,label:string){await this.hosting('native-target','POST',{adapterId,label,ownershipConfirmed:true});}
  async reviewBinding(bindingId:string,bindingRevision:number,expectedRevision:number){return (await this.hosting('binding-review','POST',{bindingId,bindingRevision,expectedRevision})).json();}
  async reviewPublication(expectedRevision:number,targetIds:readonly string[]){return (await this.hosting('review','POST',{expectedRevision,targetIds})).json();}
  async publishWebsite(planId:string,fingerprint:string,idempotencyKey:string){await this.hosting('publish','POST',{planId,fingerprint,idempotencyKey});}
  async hostingAction(action:string,id:string,body:unknown={}){await this.hosting(encodeURIComponent(action)+'/'+encodeURIComponent(id),'POST',body);}
  async get() {return (await(await this.request('/'+encodeURIComponent(this.websiteId))).json()).website as Website;}
  async catalogue() {return (await(await this.request('/catalogue')).json()).publications as {id:string;title:string}[];}
  async save(website:Website,expectedRevision:number) {return (await(await this.request('/'+encodeURIComponent(this.websiteId),'PUT',{website,expectedRevision})).json()).website as Website;}
  async document(id:string) {return (await this.request('/documents/'+encodeURIComponent(id))).json();}
  async saveDocument(document:WebsiteDocument,expectedRevision:number) {return (await(await this.request('/documents/'+encodeURIComponent(document.id),'PUT',{document,expectedRevision})).json()).document as WebsiteDocument;}
  async requestBuild(expectedRevision:number,idempotencyKey:string) {return (await(await this.request('/'+encodeURIComponent(this.websiteId)+'/builds','POST',{expectedRevision,idempotencyKey})).json()).build;}
  async build(id:string) {return (await(await this.request('/builds/'+encodeURIComponent(id))).json()).build;}
  async builds(previewRevision?:number) {return (await(await this.request('/'+encodeURIComponent(this.websiteId)+'/builds'+(previewRevision===undefined?'':'?previewRevision='+previewRevision))).json()).builds;}
  async previewSite(id:string) {return (await this.request('/builds/'+encodeURIComponent(id)+'/preview-site')).blob();}
  async previewManifest(id:string):Promise<WebsitePreviewManifest>{
    const manifest=validateWebsitePreviewManifest(await(await this.request('/builds/'+encodeURIComponent(id)+'/preview-manifest')).json());
    this.previewManifests.set(id,manifest);if(this.previewManifests.size>30)this.previewManifests.delete(this.previewManifests.keys().next().value!);return manifest;
  }
  async previewFiles(id:string,paths:readonly string[],onProgress?:()=>void):Promise<WebsitePreviewFiles>{
    if(!Array.isArray(paths)||!paths.length||paths.length>8||new Set(paths).size!==paths.length)throw new Error('Select 1–8 distinct preview files.');
    const credential=this.token(),manifest=this.previewCredential===credential?this.previewManifests.get(id)??await this.previewManifest(id):await this.previewManifest(id);
    const limit=Math.min(this.previewMaxFileBytes,manifest.maxFileBytes??this.previewMaxFileBytes);
    for(const path of paths){if(!Object.hasOwn(manifest.files,path))throw new Error('Unknown website preview file.');if(manifest.files[path].byteLength>limit)throw new Error('This file exceeds the configured preview file size limit.');}
    let lastProgress=0;const progress=()=>{const now=Date.now();if(now-lastProgress>=500){lastProgress=now;onProgress?.();}};
    const files:Record<string,string>=Object.create(null);let batch:string[]=[],batchBytes=0;
    const flush=async()=>{if(batch.length)Object.assign(files,await this.previewBatch(id,batch,manifest,credential));batch=[];batchBytes=0;};
    for(const path of paths){const entry=manifest.files[path],cached=this.previewBytes.has(entry.checksum);
      if(!cached&&entry.byteLength>WEBSITE_PREVIEW_CHUNK_BYTES){await flush();const value=await this.previewLargeFile(id,path,manifest,credential,progress);files[path]=value;this.cachePreviewFile(entry.checksum,value);}
      else {const size=cached?0:entry.byteLength;if(batch.length===8||batchBytes+size>WEBSITE_PREVIEW_CHUNK_BYTES)await flush();batch.push(path);batchBytes+=size;}
    }
    await flush();if(credential!==this.token())throw new Error('Sign-in changed while loading the preview. Open it again.');
    return {digest:manifest.digest,files};
  }
  private cachePreviewFile(checksum:string,base64:string){
    const size=base64.length;if(size>64*1024*1024)return;
    const previous=this.previewBytes.get(checksum);if(previous){this.previewBytes.delete(checksum);this.previewByteCount-=previous.size;}
    this.previewBytes.set(checksum,{base64,size});this.previewByteCount+=size;
    while(this.previewByteCount>64*1024*1024){const key=this.previewBytes.keys().next().value!,old=this.previewBytes.get(key)!;this.previewBytes.delete(key);this.previewByteCount-=old.size;}
  }
  private async previewBatch(id:string,paths:readonly string[],manifest:WebsitePreviewManifest,credential:string|undefined){
    const knownChecksums:Record<string,string>={},cachedFiles=new Map<string,{base64:string;size:number}>();
    for(const path of paths){const entry=manifest.files[path];if(!Object.hasOwn(manifest.files,path))throw new Error('Unknown website preview file.');const cached=this.previewBytes.get(entry.checksum);if(cached){knownChecksums[path]=entry.checksum;cachedFiles.set(path,cached);}}
    const result=await(await this.request('/builds/'+encodeURIComponent(id)+'/preview-files','POST',{paths,knownChecksums},{credential})).json();
    if(result.digest!==manifest.digest||!Array.isArray(result.files)||result.files.length!==paths.length)throw new Error('Invalid website preview response.');
    const files:Record<string,string>=Object.create(null);
    for(const file of result.files){
      const entry=Object.hasOwn(manifest.files,file.path)?manifest.files[file.path]:undefined;
      if(!entry||!paths.includes(file.path)||Object.hasOwn(files,file.path)||file.checksum!==entry.checksum)throw new Error('Invalid website preview response.');
      let base64:string;
      if(typeof file.base64==='string'){
        if(file.base64.length>Math.ceil(entry.byteLength/3)*4)throw new Error('Invalid website preview file.');
        const bytes=Uint8Array.from(atob(file.base64),character=>character.charCodeAt(0));
        if(bytes.byteLength!==entry.byteLength||await checksum(bytes)!==entry.checksum)throw new Error('Website preview file is corrupt.');base64=file.base64;
      }else{const cached=cachedFiles.get(file.path);if(!cached)throw new Error('Website preview cache expired. Open the preview again.');base64=cached.base64;}
      files[file.path]=base64;
      if(credential!==this.token())throw new Error('Sign-in changed while loading the preview. Open it again.');
      this.cachePreviewFile(entry.checksum,base64);
    }return files;
  }
  private async rangeSlot<T>(work:()=>Promise<T>):Promise<T>{
    if(this.rangeActive>=2)await new Promise<void>(resolve=>this.rangeWaiters.push(resolve));else this.rangeActive++;
    try{return await work();}finally{const next=this.rangeWaiters.shift();if(next)next();else this.rangeActive--;}
  }
  private async previewRange(id:string,path:string,start:number,end:number,manifest:WebsitePreviewManifest,credential:string|undefined,signal:AbortSignal,progress:()=>void){
    const entry=manifest.files[path];
    for(let attempt=0;;attempt++)try{
      if(signal.aborted)throw new Error('Preview loading cancelled.');
      const response=await this.request('/builds/'+encodeURIComponent(id)+'/preview-file?file='+encodeURIComponent(path),'GET',undefined,{credential,signal,headers:{range:`bytes=${start}-${end-1}`,'if-match':`"${entry.checksum}"`}});
      if(response.status!==206||response.headers.get('content-range')!==`bytes ${start}-${end-1}/${entry.byteLength}`||response.headers.get('etag')!==`"${entry.checksum}"`||response.headers.get('x-website-artifact-digest')!==manifest.digest){await response.body?.cancel();throw new Error('Invalid website preview range response.');}
      const expected=response.headers.get('x-website-chunk-checksum');
      if(!expected||!/^[a-f0-9]{64}$/.test(expected)){await response.body?.cancel();throw new Error('Invalid website preview chunk checksum.');}
      const reader=response.body?.getReader();if(!reader)throw new Error('Missing website preview chunk.');
      const bytes=new Uint8Array(end-start);let offset=0;
      try{while(true){const {value,done}=await reader.read();if(done)break;if(offset+value.length>bytes.length)throw new Error('Website preview chunk exceeds its byte limit.');bytes.set(value,offset);offset+=value.length;progress();}}
      catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
      if(offset!==bytes.length||await checksum(bytes)!==expected)throw new Error('Website preview chunk is corrupt.');
      if(credential!==this.token())throw new Error('Sign-in changed while loading the preview. Open it again.');
      return bytes;
    }catch(error){
      if(signal.aborted||credential!==this.token()||attempt>=2||!(error instanceof TypeError||error instanceof WebsiteRequestError&&[500,502,503,504].includes(error.status)))throw error;
      await new Promise(resolve=>setTimeout(resolve,100*2**attempt));
    }
  }
  private async previewLargeFile(id:string,path:string,manifest:WebsitePreviewManifest,credential:string|undefined,progress:()=>void){
    const entry=manifest.files[path],bytes=new Uint8Array(entry.byteLength),controller=new AbortController();let next=0,failed=false,failure:unknown;
    await Promise.all([0,1].map(async()=>{while(next<bytes.length&&!failed){const start=next,end=Math.min(bytes.length,start+WEBSITE_PREVIEW_CHUNK_BYTES);next=end;
      try{bytes.set(await this.rangeSlot(()=>this.previewRange(id,path,start,end,manifest,credential,controller.signal,progress)),start);}
      catch(error){if(!failed){failed=true;failure=error;controller.abort();}}
    }}));
    if(failed)throw failure;
    if(await checksum(bytes)!==entry.checksum)throw new Error('Website preview file is corrupt.');
    if(credential!==this.token())throw new Error('Sign-in changed while loading the preview. Open it again.');
    return base64(bytes);
  }
  async previewPages(id:string) {return (await(await this.request('/builds/'+encodeURIComponent(id)+'/pages')).json()).pages;}
  async export(id:string) {return (await this.request('/builds/'+encodeURIComponent(id)+'/export')).blob();}
  async preview(id:string,file='index.html') {return (await this.request('/builds/'+encodeURIComponent(id)+'/preview?inline=1&file='+encodeURIComponent(file))).text();}
}
