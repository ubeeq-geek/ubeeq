import {createHash} from 'node:crypto';
import {WebsiteError, WEBSITE_PREVIEW_CHUNK_BYTES} from '@ubeeq/core';
import type {HostRecord, UbeeqRepositories, WebsiteBlobStore} from '@ubeeq/persistence';
import {requireCreatorScopedObject, type ObjectStorage, type StoredObject} from '@ubeeq/storage';
import {OwnedObjectWrites} from './owned-object-writes.js';

const digest=(body:Uint8Array)=>createHash('sha256').update(body).digest('hex');
// The 256 MiB website file budget also needs ZIP headers and directory entries.
const maxBytes=512*1024*1024;
interface BlobRecord {checksum:string;byteLength:number;chunkCount:number;}

/** Constant-size immutable manifests identify independently owned, verified chunks.
 * Removing a website's references never removes or refunds retained versions. */
export class OwnedWebsiteBlobs implements WebsiteBlobStore {
  constructor(private readonly repositories:UbeeqRepositories,private readonly writes:OwnedObjectWrites,private readonly storage:ObjectStorage,private readonly instanceId:string,private readonly cellId:string,private readonly bucket:string){
    if(!repositories.hostRecords)throw new Error('Website bytes require durable object manifests.');
  }
  private id(workspace:string,checksum:string){
    if(!workspace||!/^[a-f0-9]{64}$/.test(checksum))throw new WebsiteError('invalid_media','Website byte identity is required.');
    return 'website-blob-'+digest(Buffer.from(JSON.stringify([this.instanceId,this.cellId,workspace,checksum])));
  }
  private async owner(workspace:string){
    const creator=await this.repositories.creators.get(workspace);
    if(!creator||creator.instanceId!==this.instanceId||creator.homeCellId!==this.cellId)throw new WebsiteError('foreign_reference','Website bytes belong to another workspace or cell.');
    return creator;
  }
  private value(row:HostRecord,workspace:string,checksum:string):BlobRecord {
    const value=row.value as unknown as BlobRecord;
    if(row.id!==this.id(workspace,checksum)||row.namespace!=='runtime-website-blob'||row.instanceId!==this.instanceId||row.homeCellId!==this.cellId||row.scopeId!==workspace||row.key!==checksum||!value||value.checksum!==checksum||!Number.isSafeInteger(value.byteLength)||value.byteLength<0||value.byteLength>maxBytes||value.chunkCount!==Math.ceil(value.byteLength/WEBSITE_PREVIEW_CHUNK_BYTES))throw new WebsiteError('artifact_unavailable','Website byte manifest needs recovery.');
    return value;
  }
  private async manifest(workspace:string,checksum:string){
    await this.owner(workspace);const row=await this.repositories.hostRecords!.get(this.id(workspace,checksum));return row?this.value(row,workspace,checksum):undefined;
  }
  async put(workspace:string,checksum:string,bytes:Uint8Array):Promise<void>{
    if(bytes.length>maxBytes)throw new WebsiteError('invalid_media','Website bytes are oversized.');
    bytes=Uint8Array.from(bytes);
    const owner=await this.owner(workspace),id=this.id(workspace,checksum);
    if(digest(bytes)!==checksum)throw new WebsiteError('invalid_media','Website bytes are oversized or changed.');
    const existing=await this.repositories.hostRecords!.get(id);
    if(existing){if(this.value(existing,workspace,checksum).byteLength!==bytes.length)throw new WebsiteError('artifact_conflict','Website byte identity conflicts.');return;}
    let chunkCount=0;
    for(let offset=0;offset<bytes.length;offset+=WEBSITE_PREVIEW_CHUNK_BYTES){
      const index=chunkCount;try{await this.writes.write({creatorId:workspace,operation:'website.blob',idempotencyKey:`${checksum}:${index}`,home:owner,bucket:this.bucket,kind:'exports',scope:'private',contentType:'application/octet-stream',body:bytes.subarray(offset,offset+WEBSITE_PREVIEW_CHUNK_BYTES),metadata:{checksum,index,byteLength:bytes.length}});}catch(error){if(error instanceof Error&&error.message==='STORAGE_QUOTA_EXCEEDED')throw new WebsiteError('quota_exceeded','Website storage quota exceeded.');throw error;}
      chunkCount++;
    }
    const value:BlobRecord={checksum,byteLength:bytes.length,chunkCount};
    try{await this.repositories.hostRecords!.create({id,instanceId:this.instanceId,homeCellId:owner.homeCellId,dataHomeRegion:owner.dataHomeRegion,dataHomeAssignedAt:owner.dataHomeAssignedAt,routingRevision:owner.routingRevision,namespace:'runtime-website-blob',scopeId:workspace,key:checksum,value:value as unknown as Record<string,unknown>});}
    catch(error){const saved=await this.repositories.hostRecords!.get(id);if(!saved||JSON.stringify(this.value(saved,workspace,checksum))!==JSON.stringify(value))throw error;}
  }
  private async chunk(workspace:string,manifest:BlobRecord,index:number){
    const saved=await this.writes.recover({creatorId:workspace,operation:'website.blob',idempotencyKey:`${manifest.checksum}:${index}`});
    if(!saved)throw new WebsiteError('artifact_unavailable','Owned website chunk needs recovery.');
    const object=saved.object;
    requireCreatorScopedObject(object.key,{cellId:this.cellId,creatorId:workspace});
    if(saved.metadata.checksum!==manifest.checksum||saved.metadata.index!==index||saved.metadata.byteLength!==manifest.byteLength||object.scope!=='private'||object.contentType!=='application/octet-stream'||object.byteLength!==Math.min(WEBSITE_PREVIEW_CHUNK_BYTES,manifest.byteLength-index*WEBSITE_PREVIEW_CHUNK_BYTES))throw new WebsiteError('artifact_unavailable','Owned website chunk identity conflicts.');
    const loaded=await this.storage.get(object);
    if(['bucket','key','versionId','scope','contentType','checksum','byteLength'].some(key=>loaded.object[key as keyof StoredObject]!==object[key as keyof StoredObject])||loaded.body.length!==object.byteLength||digest(loaded.body)!==object.checksum)throw new WebsiteError('artifact_unavailable','Owned website chunk is missing or corrupt.');
    return loaded.body;
  }
  async get(workspace:string,checksum:string):Promise<Uint8Array|undefined>{
    const manifest=await this.manifest(workspace,checksum);if(!manifest)return;
    const bytes=new Uint8Array(manifest.byteLength);let offset=0;
    for(let index=0;index<manifest.chunkCount;index++){const body=await this.chunk(workspace,manifest,index);bytes.set(body,offset);offset+=body.length;}
    if(digest(bytes)!==checksum)throw new WebsiteError('artifact_unavailable','Website bytes failed integrity verification.');return bytes;
  }
  async getRange(workspace:string,checksum:string,start:number,end:number):Promise<Uint8Array|undefined>{
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<=start||end-start>WEBSITE_PREVIEW_CHUNK_BYTES)throw new WebsiteError('invalid_range','Invalid website byte range.');
    const manifest=await this.manifest(workspace,checksum);if(!manifest)return;
    if(end>manifest.byteLength)throw new WebsiteError('invalid_range','Website byte range exceeds its file.');
    const bytes=new Uint8Array(end-start);
    for(let index=Math.floor(start/WEBSITE_PREVIEW_CHUNK_BYTES);index*WEBSITE_PREVIEW_CHUNK_BYTES<end;index++){
      const offset=index*WEBSITE_PREVIEW_CHUNK_BYTES,body=await this.chunk(workspace,manifest,index);
      const from=Math.max(start,offset),to=Math.min(end,offset+body.length);bytes.set(body.subarray(from-offset,to-offset),from-start);
    }
    return bytes;
  }
}
