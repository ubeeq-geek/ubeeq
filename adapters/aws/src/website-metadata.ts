import {createHash} from 'node:crypto';
import {GetCommand,PutCommand} from '@aws-sdk/lib-dynamodb';
import {WebsiteError} from '@ubeeq/core';
import type {WebsiteBlobStore} from '@ubeeq/persistence';
import type {AwsCommandClient} from './client-port.js';

const sha=(bytes:string|Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const chunkBytes=128*1024,maxBytes=512*1024*1024;
interface Header {pk:string;sk:string;payloadType:'website_metadata_manifest';instanceId:string;cellId:string;workspace:string;checksum:string;byteLength:number;chunkCount:number;}

/** Platform-owned database metadata, independent of customer file quota.
 * Stage immutable bounded rows before the small record-pointer transaction.
 * The base client deliberately bypasses that transaction's write accumulator. */
export class DynamoWebsiteMetadata implements WebsiteBlobStore {
  constructor(private readonly client:AwsCommandClient,private readonly table:string,private readonly instanceId:string,private readonly cellId:string){}
  partition(workspace:string,checksum:string){if(!workspace||!/^[a-f0-9]{64}$/.test(checksum))throw new WebsiteError('invalid_media','Website metadata identity is required.');return 'website-json-v1#'+sha(JSON.stringify([this.instanceId,this.cellId,workspace,checksum]));}
  private facts(workspace:string,checksum:string){return {pk:this.partition(workspace,checksum),instanceId:this.instanceId,cellId:this.cellId,workspace,checksum};}
  private async read(pk:string,sk:string){return (await this.client.send(new GetCommand({TableName:this.table,Key:{pk,sk},ConsistentRead:true}))).Item;}
  private matches(item:Record<string,unknown>,facts:Record<string,unknown>){return Object.entries(facts).every(([key,value])=>item[key]===value);}
  private async header(workspace:string,checksum:string):Promise<Header|undefined>{
    const facts=this.facts(workspace,checksum),item=await this.read(facts.pk,'manifest');if(!item)return;
    if(!this.matches(item,{...facts,sk:'manifest',payloadType:'website_metadata_manifest'})||!Number.isSafeInteger(item.byteLength)||item.byteLength<0||item.byteLength>maxBytes||item.chunkCount!==Math.ceil(item.byteLength/chunkBytes))throw new WebsiteError('artifact_unavailable','Website metadata manifest is corrupt.');return item;
  }
  private async immutable(item:Record<string,unknown>,verify:(saved:Record<string,unknown>)=>boolean){
    try{await this.client.send(new PutCommand({TableName:this.table,Item:item,ConditionExpression:'attribute_not_exists(pk)'}));}
    catch(error){const saved=await this.read(String(item.pk),String(item.sk));if(!saved)throw error;if(!verify(saved))throw new WebsiteError('artifact_conflict','Immutable website metadata conflicts.');}
  }
  async put(workspace:string,checksum:string,body:Uint8Array){
    if(body.length>maxBytes)throw new WebsiteError('quota_exceeded','Website metadata exceeds its supported byte budget.');body=Uint8Array.from(body);
    if(sha(body)!==checksum)throw new WebsiteError('invalid_media','Website metadata checksum changed.');const facts=this.facts(workspace,checksum),existing=await this.header(workspace,checksum);
    if(existing){if(existing.byteLength!==body.length)throw new WebsiteError('artifact_conflict','Website metadata length conflicts.');return;}
    for(let index=0,offset=0;offset<body.length;index++,offset+=chunkBytes){const bytes=body.slice(offset,offset+chunkBytes),item={...facts,sk:'chunk#'+index.toString().padStart(8,'0'),payloadType:'website_metadata_chunk',byteLength:bytes.length,chunkChecksum:sha(bytes),bytes};
      await this.immutable(item,saved=>this.matches(saved,{...facts,sk:item.sk,payloadType:item.payloadType,byteLength:bytes.length,chunkChecksum:item.chunkChecksum})&&saved.bytes instanceof Uint8Array&&sha(saved.bytes)===item.chunkChecksum);
    }
    const item:Header={...facts,sk:'manifest',payloadType:'website_metadata_manifest',byteLength:body.length,chunkCount:Math.ceil(body.length/chunkBytes)};
    await this.immutable(item as unknown as Record<string,unknown>,saved=>this.matches(saved,item as unknown as Record<string,unknown>));
  }
  private async chunk(header:Header,index:number):Promise<Uint8Array>{
    const item=await this.read(header.pk,'chunk#'+index.toString().padStart(8,'0')),size=Math.min(chunkBytes,header.byteLength-index*chunkBytes);
    if(!item||!this.matches(item,{...this.facts(header.workspace,header.checksum),sk:'chunk#'+index.toString().padStart(8,'0'),payloadType:'website_metadata_chunk',byteLength:size})||!(item.bytes instanceof Uint8Array)||item.bytes.length!==size||sha(item.bytes)!==item.chunkChecksum)throw new WebsiteError('artifact_unavailable','Website metadata chunk is missing or corrupt.');return item.bytes;
  }
  async get(workspace:string,checksum:string){
    const header=await this.header(workspace,checksum);if(!header)return;const body=new Uint8Array(header.byteLength);
    for(let index=0;index<header.chunkCount;index++)body.set(await this.chunk(header,index),index*chunkBytes);
    if(sha(body)!==checksum)throw new WebsiteError('artifact_unavailable','Website metadata failed integrity verification.');return body;
  }
  async getRange(workspace:string,checksum:string,start:number,end:number){
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<=start||end-start>2*1024*1024)throw new WebsiteError('invalid_range','Invalid website metadata range.');
    const header=await this.header(workspace,checksum);if(!header)return;if(end>header.byteLength)throw new WebsiteError('invalid_range','Website metadata range exceeds its length.');
    const body=new Uint8Array(end-start);for(let index=Math.floor(start/chunkBytes);index*chunkBytes<end;index++){const offset=index*chunkBytes,bytes=await this.chunk(header,index),from=Math.max(start,offset),to=Math.min(end,offset+bytes.length);body.set(bytes.subarray(from-offset,to-offset),from-start);}return body;
  }
}
