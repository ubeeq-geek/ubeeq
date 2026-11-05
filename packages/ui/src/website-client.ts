import type { Website, WebsiteDocument } from '@ubeeq/core';
import type { WebsiteWorkspaceClient } from './website-workspace.js';
import {validateWebsitePreviewManifest,type WebsitePreviewManifest,type WebsitePreviewFiles} from './website-preview-files.js';

/** In-memory bearer provider, same-origin API transport; no credentials enter preview HTML. */
export class WebsiteClient implements WebsiteWorkspaceClient {
  private previewManifests=new Map<string,WebsitePreviewManifest>();
  private previewBytes=new Map<string,{base64:string;size:number}>();
  private previewByteCount=0;
  private previewCredential?:string;
  constructor(private readonly websiteId: string, private readonly token: () => string | undefined, private readonly basePath = '/api/v1/websites') {
    if(!websiteId || !basePath.startsWith('/') || basePath.startsWith('//') || /[?#\\]/.test(basePath)) throw new Error('A website ID and same-origin API path are required.');
  }
  private async request(path:string,method='GET',body?:unknown) {
    const credential=this.token();
    if(credential!==this.previewCredential){this.previewManifests.clear();this.previewBytes.clear();this.previewByteCount=0;this.previewCredential=credential;}
    if(!credential)throw new Error('Sign in to manage a website.');
    const response=await fetch(this.basePath+path,{method,headers:{authorization:`Bearer ${credential}`,...(body===undefined?{}:{'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),cache:'no-store',redirect:'error'});
    if(!response.ok){let message='Website operation failed.';try{message=(await response.json()).error?.message??message;}catch{}throw new Error(message);}
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
  async previewFiles(id:string,paths:readonly string[]):Promise<WebsitePreviewFiles>{
    const credential=this.token(),manifest=this.previewCredential===credential?this.previewManifests.get(id)??await this.previewManifest(id):await this.previewManifest(id),knownChecksums:Record<string,string>={},cachedFiles=new Map<string,{base64:string;size:number}>();
    for(const path of paths){const entry=manifest.files[path];if(!Object.hasOwn(manifest.files,path))throw new Error('Unknown website preview file.');const cached=this.previewBytes.get(entry.checksum);if(cached){knownChecksums[path]=entry.checksum;cachedFiles.set(path,cached);}}
    const result=await(await this.request('/builds/'+encodeURIComponent(id)+'/preview-files','POST',{paths,knownChecksums})).json();
    if(result.digest!==manifest.digest||!Array.isArray(result.files)||result.files.length!==paths.length)throw new Error('Invalid website preview response.');
    const files:Record<string,string>=Object.create(null);
    for(const file of result.files){
      const entry=Object.hasOwn(manifest.files,file.path)?manifest.files[file.path]:undefined;
      if(!entry||!paths.includes(file.path)||Object.hasOwn(files,file.path)||file.checksum!==entry.checksum)throw new Error('Invalid website preview response.');
      let base64:string;
      if(typeof file.base64==='string'){
        if(file.base64.length>Math.ceil(entry.byteLength/3)*4)throw new Error('Invalid website preview file.');
        const bytes=Uint8Array.from(atob(file.base64),character=>character.charCodeAt(0));
        const checksum=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
        if(bytes.byteLength!==entry.byteLength||checksum!==entry.checksum)throw new Error('Website preview file is corrupt.');base64=file.base64;
      }else{const cached=cachedFiles.get(file.path);if(!cached)throw new Error('Website preview cache expired. Open the preview again.');base64=cached.base64;}
      files[file.path]=base64;
      const previous=this.previewBytes.get(entry.checksum);if(previous){this.previewBytes.delete(entry.checksum);this.previewByteCount-=previous.size;}
      const size=base64.length;this.previewBytes.set(entry.checksum,{base64,size});this.previewByteCount+=size;
      while(this.previewByteCount>64*1024*1024){const key=this.previewBytes.keys().next().value!,old=this.previewBytes.get(key)!;this.previewBytes.delete(key);this.previewByteCount-=old.size;}
    }if(credential!==this.token())throw new Error('Sign-in changed while loading the preview. Open it again.');return {digest:manifest.digest,files};
  }
  async previewPages(id:string) {return (await(await this.request('/builds/'+encodeURIComponent(id)+'/pages')).json()).pages;}
  async export(id:string) {return (await this.request('/builds/'+encodeURIComponent(id)+'/export')).blob();}
  async preview(id:string,file='index.html') {return (await this.request('/builds/'+encodeURIComponent(id)+'/preview?inline=1&file='+encodeURIComponent(file))).text();}
}
