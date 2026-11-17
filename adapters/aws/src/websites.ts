import {createHash} from 'node:crypto';
import {WebsiteError,WEBSITE_PREVIEW_CHUNK_BYTES,type Website,type WebsiteDocument} from '@ubeeq/core';
import {OptimisticConcurrencyError,verifyWebsiteArtifactProjection,type WebsiteBlobStore,type WebsiteStore,type WebsiteBuildRecord,type WebsiteArtifactManifest,type WebsiteImageRecord} from '@ubeeq/persistence';
import type {AwsCommandClient} from './client-port.js';
import {DynamoWebsiteRecords} from './website-records.js';

const checksum=(body:Uint8Array)=>createHash('sha256').update(body).digest('hex');
export interface DynamoWebsiteConfiguration {client:AwsCommandClient;tableName:string;instanceId:string;cellId:string;blobs:WebsiteBlobStore;}

/** Durable workspace-indexed website metadata; all payload bytes and large JSON
 * use the host's immutable blob port. The host owns the client lifecycle. */
export class DynamoWebsiteStore implements WebsiteStore {
  protected readonly records:DynamoWebsiteRecords;
  protected readonly blobs:WebsiteBlobStore;
  constructor(protected readonly configuration:DynamoWebsiteConfiguration){
    this.blobs=configuration.blobs;
    this.records=new DynamoWebsiteRecords(configuration.client,configuration.tableName,configuration.instanceId,configuration.cellId);
  }
  protected async atomic<T>(work:()=>Promise<T>):Promise<T>{
    try{return await this.records.database.transaction(work);}
    catch(error){
      const failure=error as {name?:string;CancellationReasons?:{Code?:string}[]};
      if(error instanceof OptimisticConcurrencyError||failure.name==='ConditionalCheckFailedException'||failure.name==='TransactionCanceledException'&&failure.CancellationReasons?.some(reason=>reason.Code==='ConditionalCheckFailed')&&failure.CancellationReasons.every(reason=>['None','ConditionalCheckFailed'].includes(reason.Code??'')))throw new WebsiteError('revision_conflict','Website records changed. Review and retry the operation.');
      throw error;
    }
  }
  protected async read<T>(workspace:string,kind:string,id:string){return (await this.records.get<T>(workspace,kind,id))?.value;}
  protected async list<T>(workspace:string,kind:string){return (await this.records.list<T>(workspace,kind)).map(row=>row.value);}
  protected async save<T extends {id:string;revision:number}>(workspace:string,kind:string,value:T,expected:number){
    value=structuredClone(value);
    if(!workspace||!value.id||!Number.isSafeInteger(expected)||expected<0||value.revision!==expected+1)throw new WebsiteError('revision_conflict','Invalid record revision.');
    const previous=await this.records.get<T&{deletedAt?:string}>(workspace,kind,value.id);
    if(previous?previous.value.revision!==expected||Boolean(previous.value.deletedAt):expected!==0)throw new WebsiteError('revision_conflict','Record changed or was deleted.');
    await this.records.put(workspace,kind,value.id,value,previous?.stamp);
  }
  close():void {/* A shared host-owned client must remain open. */}
  async setWebsiteShare(identity:string,ownerId:string,websiteId:string,enabled:boolean){await this.atomic(async()=>{const id=ownerId+':'+websiteId,previous=await this.records.get(identity,'share',id);if(enabled)await this.records.put(identity,'share',id,{ownerId,websiteId},previous?.stamp);else if(previous)await this.records.remove(previous.stamp);});}
  listWebsiteShares(identity:string){return this.list<{ownerId:string;websiteId:string}>(identity,'share');}
  async getWebsite(workspace:string,id:string){const site=await this.read<Website&{deletedAt?:string}>(workspace,'website',id);return site?.deletedAt?undefined:site;}
  async listWebsites(workspace:string){return (await this.list<Website&{deletedAt?:string}>(workspace,'website')).filter(value=>!value.deletedAt);}
  saveWebsite(value:Website,expected:number){return this.atomic(()=>this.save(value.workspaceId,'website',value,expected));}
  async deleteWebsite(workspace:string,id:string,expected:number){await this.atomic(async()=>{const site=await this.getWebsite(workspace,id);if(!site)throw new WebsiteError('website_not_found','Website was not found.');await this.save(workspace,'website',{...site,revision:expected+1,deletedAt:new Date().toISOString()},expected);});}
  getDocument(workspace:string,id:string){return this.read<WebsiteDocument>(workspace,'document',id);}
  saveDocument(value:WebsiteDocument,expected:number){return this.atomic(()=>this.save(value.workspaceId,'document',value,expected));}
  getBuild(workspace:string,id:string){return this.read<WebsiteBuildRecord>(workspace,'build',id);}
  saveBuild(value:WebsiteBuildRecord,expected:number){return this.atomic(()=>this.save(value.workspaceId,'build',value,expected));}
  listWorkspaceBuilds(workspace:string){return this.list<WebsiteBuildRecord>(workspace,'build');}
  async listBuilds(workspace:string,websiteId:string){return (await this.listWorkspaceBuilds(workspace)).filter(value=>value.websiteId===websiteId);}
  async getPublicRendition(workspace:string,source:string){
    const saved=await this.read<{checksum:string;width:number;height:number}>(workspace,'rendition',source);if(!saved)return;
    const bytes=await this.blobs.get(workspace,saved.checksum);if(!bytes||checksum(bytes)!==saved.checksum)throw new WebsiteError('invalid_media','Website image cache is missing or corrupt.');return {bytes,width:saved.width,height:saved.height};
  }
  async putPublicRendition(workspace:string,source:string,image:{bytes:Uint8Array;width:number;height:number}){
    const bytes=Uint8Array.from(image.bytes),digest=checksum(bytes);await this.atomic(async()=>{if(await this.read(workspace,'rendition',source))return;await this.blobs.put(workspace,digest,bytes);await this.records.put(workspace,'rendition',source,{checksum:digest,width:image.width,height:image.height});});
  }
  async putWebsiteImage(image:WebsiteImageRecord,bytes:Uint8Array){
    image=structuredClone(image);bytes=Uint8Array.from(bytes);
    if(image.id!=='website-image-'+image.checksum||checksum(bytes)!==image.checksum||bytes.length!==image.sizeBytes)throw new WebsiteError('invalid_media','Image integrity check failed.');
    await this.atomic(async()=>{if(await this.read(image.workspaceId,'image',image.id))return;await this.blobs.put(image.workspaceId,image.checksum,bytes);await this.records.put(image.workspaceId,'image',image.id,image);});
  }
  listWebsiteImages(workspace:string){return this.list<WebsiteImageRecord>(workspace,'image');}
  async getWebsiteImage(workspace:string,id:string){
    const image=await this.read<WebsiteImageRecord>(workspace,'image',id);if(!image)return;
    const bytes=await this.blobs.get(workspace,image.checksum);
    if(!bytes||bytes.length!==image.sizeBytes||checksum(bytes)!==image.checksum)throw new WebsiteError('invalid_media','Website image is missing or corrupt.');return {image,bytes};
  }
  async putArtifact(workspace:string,digest:string,zip:Uint8Array,files:ReadonlyMap<string,Uint8Array>){
    files=new Map(files);verifyWebsiteArtifactProjection(digest,zip,files,checksum);
    const entries=[...files].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([path,bytes])=>[path,{checksum:checksum(bytes),byteLength:bytes.length}] as const),manifest:WebsiteArtifactManifest={digest,files:Object.fromEntries(entries)};
    await this.atomic(async()=>{
      const previous=await this.read<WebsiteArtifactManifest>(workspace,'artifact',digest);
      if(previous){if(JSON.stringify(previous)!==JSON.stringify(manifest))throw new WebsiteError('artifact_conflict','Immutable artifact cannot be replaced.');return;}
      for(const [path,bytes]of files)await this.blobs.put(workspace,manifest.files[path].checksum,bytes);
      await this.blobs.put(workspace,digest,zip);
      verifyWebsiteArtifactProjection(digest,zip,files,checksum);
      await this.records.put(workspace,'artifact',digest,manifest);
    });
  }
  getArtifactManifest(workspace:string,digest:string){return this.read<WebsiteArtifactManifest>(workspace,'artifact',digest);}
  async getArtifact(workspace:string,digest:string){
    const manifest=await this.getArtifactManifest(workspace,digest);if(!manifest)return;
    const zip=await this.blobs.get(workspace,digest);if(!zip||checksum(zip)!==digest)throw new WebsiteError('artifact_unavailable','Website archive is missing or corrupt.');
    const files=new Map<string,Uint8Array>();for(const [path,entry]of Object.entries(manifest.files)){const body=await this.blobs.get(workspace,entry.checksum);if(!body||body.length!==entry.byteLength||checksum(body)!==entry.checksum)throw new WebsiteError('artifact_unavailable','Website file is missing or corrupt.');files.set(path,body);}
    verifyWebsiteArtifactProjection(digest,zip,files,checksum);return {zip,files};
  }
  async getArtifactFile(workspace:string,digest:string,path:string){
    const manifest=await this.getArtifactManifest(workspace,digest),entry=manifest&&Object.hasOwn(manifest.files,path)?manifest.files[path]:undefined;if(!entry)return;
    const bytes=await this.blobs.get(workspace,entry.checksum);if(!bytes||bytes.length!==entry.byteLength||checksum(bytes)!==entry.checksum)throw new WebsiteError('artifact_unavailable','Website file is missing or corrupt.');return bytes;
  }
  async getArtifactFileRange(workspace:string,digest:string,path:string,start:number,end:number){
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<=start||end-start>WEBSITE_PREVIEW_CHUNK_BYTES)throw new WebsiteError('invalid_range','Invalid website byte range.');
    const manifest=await this.getArtifactManifest(workspace,digest),entry=manifest&&Object.hasOwn(manifest.files,path)?manifest.files[path]:undefined;if(!entry)return;
    if(end>entry.byteLength)throw new WebsiteError('invalid_range','Website byte range exceeds its file.');
    const bytes=await this.blobs.getRange(workspace,entry.checksum,start,end);if(!bytes||bytes.length!==end-start)throw new WebsiteError('artifact_unavailable','Website range is missing or corrupt.');return bytes;
  }
  async removeArtifact(workspace:string,digest:string){await this.atomic(async()=>{const previous=await this.records.get(workspace,'artifact',digest);if(previous)await this.records.remove(previous.stamp);});}
}
