import {WEBSITE_PREVIEW_MAX_ARTIFACT_BYTES} from '@ubeeq/core';
export interface WebsitePreviewManifest {
  digest:string;files:Readonly<Record<string,{checksum:string;byteLength:number}>>;maxFileBytes?:number;
}
export interface WebsitePreviewFiles {digest:string;files:Record<string,string>;}
export interface WebsitePreviewSource {buildId:string;channel:string;manifest:WebsitePreviewManifest;}
export const validateWebsitePreviewManifest=(manifest:WebsitePreviewManifest):WebsitePreviewManifest=>{
  if(!manifest||!/^[a-f0-9]{64}$/.test(manifest.digest)||!manifest.files||typeof manifest.files!=='object'||Array.isArray(manifest.files))throw new Error('Invalid website preview manifest.');
  if(manifest.maxFileBytes!==undefined&&(!Number.isSafeInteger(manifest.maxFileBytes)||manifest.maxFileBytes<1||manifest.maxFileBytes>WEBSITE_PREVIEW_MAX_ARTIFACT_BYTES))throw new Error('Invalid website preview file limit.');
  const entries=Object.entries(manifest.files);let total=0;
  if(!Object.hasOwn(manifest.files,'index.html')||entries.length>5000)throw new Error('Invalid website preview manifest.');
  for(const [path,entry]of entries){
    if(!path||path.length>2000||path.startsWith('/')||/[\\\x00-\x1f]/.test(path)||path.split('/').some(part=>!part||part==='.'||part==='..')||!entry||!/^[a-f0-9]{64}$/.test(entry.checksum)||!Number.isSafeInteger(entry.byteLength)||entry.byteLength<0||(total+=entry.byteLength)>512*1024*1024)throw new Error('Invalid website preview manifest.');
  }return manifest;
};
/** A bounded file broker shared by preview tabs. It batches visible-image requests;
 * every batch goes through the authenticated client, including browser-cache hits. */
export function createWebsitePreviewFileBroker(load:(buildId:string,paths:readonly string[],progress?:()=>void)=>Promise<WebsitePreviewFiles>){
  const sessions=new Map<string,{manifest:WebsitePreviewManifest;expiresAt:number}>();
  type Request={buildId:string;path:string;resolve:(base64:string)=>void;reject:(error:unknown)=>void;progress?:()=>void};
  const queue:Request[]=[];let running=0,scheduled=false;
  const pump=()=>{
    scheduled=false;
    while(running<2&&queue.length){
      const first=queue.shift()!,requests=[first],paths=[first.path];let bytes=sessions.get(first.buildId)?.manifest.files[first.path]?.byteLength??0;
      for(let index=0;index<queue.length&&paths.length<8;){const candidate=queue[index],entry=sessions.get(first.buildId)?.manifest.files[candidate.path];
        if(candidate.buildId===first.buildId&&entry&&bytes+entry.byteLength<=32*1024*1024){queue.splice(index,1);requests.push(candidate);if(!paths.includes(candidate.path)){paths.push(candidate.path);bytes+=entry.byteLength;}}else index++;
      }
      running++;
      void load(first.buildId,paths,()=>{for(const request of requests)request.progress?.();}).then(result=>{
        const session=sessions.get(first.buildId);if(!session||session.expiresAt<=Date.now()||result.digest!==session.manifest.digest)throw new Error('This preview has expired. Open it again from the website editor.');
        for(const path of paths)if(!Object.hasOwn(result.files,path)||typeof result.files[path]!=='string')throw new Error('A website preview file is missing.');
        for(const request of requests)request.resolve(result.files[request.path]);
      }).catch(error=>{for(const request of requests)request.reject(error);}).finally(()=>{running--;pump();});
    }
  };
  return {
    register(buildId:string,manifest:WebsitePreviewManifest){
      validateWebsitePreviewManifest(manifest);sessions.set(buildId,{manifest,expiresAt:Date.now()+30*60*1000});
      for(const [id,session]of sessions)if(session.expiresAt<=Date.now())sessions.delete(id);
      if(sessions.size>30)sessions.delete(sessions.keys().next().value!);
    },
    request(buildId:string,path:string,progress?:()=>void):Promise<string>{
      const session=sessions.get(buildId);
      if(!session||session.expiresAt<=Date.now()||!Object.hasOwn(session.manifest.files,path))return Promise.reject(new Error('This preview has expired. Open it again from the website editor.'));
      if(queue.length>=256)return Promise.reject(new Error('Too many preview files are waiting. Try again.'));
      return new Promise((resolve,reject)=>{queue.push({buildId,path,resolve,reject,progress});if(!scheduled){scheduled=true;queueMicrotask(pump);}});
    }
  };
}
