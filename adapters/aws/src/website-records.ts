import {createHash} from 'node:crypto';
import {GetCommand,PutCommand,QueryCommand} from '@aws-sdk/lib-dynamodb';
import {WebsiteError} from '@ubeeq/core';
import {DynamoWebsiteMetadata} from './website-metadata.js';
import type {AwsCommandClient} from './client-port.js';
import {createTransactionalDynamo} from './transactions.js';

const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
export interface WebsiteRecordStamp {pk:string;sk:string;workspace:string;kind:string;id:string;instanceId:string;cellId:string;revision:number;checksum:string;deleted?:boolean;}
export interface WebsiteStoredRecord<T> {value:T;stamp:WebsiteRecordStamp;}

/** Scoped indexed metadata pointers. JSON lives in immutable owned blobs so
 * a site's page list or frozen source cannot exceed one DynamoDB item. */
export class DynamoWebsiteRecords {
  readonly database:ReturnType<typeof createTransactionalDynamo>;
  readonly payloads:DynamoWebsiteMetadata;
  constructor(client:AwsCommandClient,readonly table:string,private readonly instanceId:string,private readonly cellId:string){
    if(!table||!instanceId||!cellId)throw new Error('Managed website record scope is required.');
    this.database=createTransactionalDynamo(client);
    this.payloads=new DynamoWebsiteMetadata(client,table,instanceId,cellId);
  }
  partition(workspace:string,kind:string){
    if(!workspace||!kind)throw new WebsiteError('foreign_reference','Website record scope is required.');
    return 'website#'+hash(JSON.stringify([this.instanceId,this.cellId,workspace,kind]));
  }
  key(workspace:string,kind:string,id:string){
    if(!id)throw new WebsiteError('foreign_reference','Website record identity is required.');
    return {pk:this.partition(workspace,kind),sk:'record#'+hash(id)};
  }
  private stamp(item:WebsiteRecordStamp,workspace:string,kind:string,id:string){
    const key=this.key(workspace,kind,id);
    if(item.pk!==key.pk||item.sk!==key.sk||item.workspace!==workspace||item.kind!==kind||item.id!==id||item.instanceId!==this.instanceId||item.cellId!==this.cellId||!Number.isSafeInteger(item.revision)||item.revision<1||!/^[a-f0-9]{64}$/.test(item.checksum))throw new WebsiteError('artifact_unavailable','Website metadata pointer needs recovery.');
    return item;
  }
  private async decode<T>(item:WebsiteRecordStamp,workspace:string,kind:string,id:string):Promise<WebsiteStoredRecord<T>>{
    const stamp=this.stamp(item,workspace,kind,id),bytes=await this.payloads.get(workspace,stamp.checksum);
    if(!bytes||hash(bytes)!==stamp.checksum)throw new WebsiteError('artifact_unavailable','Website metadata bytes are missing or corrupt.');
    let envelope:{workspace:string;kind:string;id:string;value:T;fields?:Record<string,string|{checksum:string;encoding:'text'}>;format?:string};
    try{envelope=JSON.parse(Buffer.from(bytes).toString('utf8'));}catch{throw new WebsiteError('artifact_unavailable','Website metadata encoding is corrupt.');}
    if(!envelope||envelope.workspace!==workspace||envelope.kind!==kind||envelope.id!==id||envelope.format!==undefined&&envelope.format!=='managed-website-v1')throw new WebsiteError('foreign_reference','Website metadata belongs to another scope.');
    if(envelope.fields){
      if(!envelope.value||typeof envelope.value!=='object'||Array.isArray(envelope.value)||typeof envelope.fields!=='object'||Array.isArray(envelope.fields))throw new WebsiteError('artifact_unavailable','Website metadata field references are corrupt.');
      for(const [key,reference]of Object.entries(envelope.fields)){
        const text=typeof reference!=='string',checksum=text?reference?.checksum:reference;
        if(text&&(!reference||reference.encoding!=='text'||Object.keys(reference).length!==2))throw new WebsiteError('artifact_unavailable','Website metadata field encoding is unsupported.');
        if(Object.hasOwn(envelope.value,key)||!/^[a-f0-9]{64}$/.test(checksum))throw new WebsiteError('artifact_unavailable','Website metadata field identity conflicts.');
        const field=await this.payloads.get(workspace,checksum);if(!field||hash(field)!==checksum)throw new WebsiteError('artifact_unavailable','Website metadata field is missing or corrupt.');
        let decoded:unknown;try{decoded=text?Buffer.from(field).toString('utf8'):JSON.parse(Buffer.from(field).toString('utf8'));}catch{throw new WebsiteError('artifact_unavailable','Website metadata field encoding is corrupt.');}
        Object.defineProperty(envelope.value,key,{value:decoded,enumerable:true,configurable:true,writable:true});
      }
    }
    return {value:envelope.value,stamp};
  }
  async get<T>(workspace:string,kind:string,id:string):Promise<WebsiteStoredRecord<T>|undefined>{
    const result=await this.database.client.send(new GetCommand({TableName:this.table,Key:this.key(workspace,kind,id),ConsistentRead:true}));
    return result.Item&&!result.Item.deleted?this.decode<T>(result.Item,workspace,kind,id):undefined;
  }
  async list<T>(workspace:string,kind:string):Promise<WebsiteStoredRecord<T>[]>{
    const result:WebsiteStoredRecord<T>[]=[],seen=new Set<string>();let cursor:Record<string,unknown>|undefined;
    do{
      const page=await this.database.client.send(new QueryCommand({TableName:this.table,KeyConditionExpression:'pk = :pk',ExpressionAttributeValues:{':pk':this.partition(workspace,kind)},ConsistentRead:true,ExclusiveStartKey:cursor,Limit:100}));
      for(const item of page.Items??[]){this.stamp(item,workspace,kind,item.id);if(!item.deleted)result.push(await this.decode<T>(item,workspace,kind,item.id));}
      cursor=page.LastEvaluatedKey;
      if(cursor){const key=JSON.stringify(cursor);if(seen.has(key))throw new WebsiteError('artifact_unavailable','Website metadata pagination did not advance.');seen.add(key);}
    }while(cursor);
    return result.sort((a,b)=>a.stamp.id<b.stamp.id?-1:a.stamp.id>b.stamp.id?1:0);
  }
  async put<T>(workspace:string,kind:string,id:string,value:T,previous?:WebsiteRecordStamp):Promise<WebsiteRecordStamp>{
    const key=this.key(workspace,kind,id);if(previous)this.stamp(previous,workspace,kind,id);
    // Retain the row revision across delete/recreate so stale authority guards
    // cannot match a new record that happens to reuse the same public ID.
    if(!previous){const current=await this.database.client.send(new GetCommand({TableName:this.table,Key:key,ConsistentRead:true}));if(current.Item?.deleted)previous=this.stamp(current.Item,workspace,kind,id);}
    // Common large arrays (for example frozen dependency lists) are shared by
    // attempts instead of charging another physical JSON copy for each target.
    const fields:Record<string,string|{checksum:string;encoding:'text'}>=Object.create(null),staged=new Map<string,Uint8Array>();let captured:unknown=value;
    if(value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value))&&typeof (value as {toJSON?:unknown}).toJSON!=='function'){
      const object:Record<string,unknown>=Object.create(null);
      for(const [key,entry]of Object.entries(value)){
        const text=typeof entry==='string'&&(entry as string&{isWellFormed?:()=>boolean}).isWellFormed?.()===true;
        const encoded=text?String(entry):JSON.stringify(entry);if(encoded===undefined)continue;const body=Buffer.from(encoded);
        if(body.length>=64*1024){const checksum=hash(body);staged.set(checksum,body);fields[key]=text?{checksum,encoding:'text'}:checksum;}else object[key]=text?entry:JSON.parse(encoded);
      }
      captured=object;
    }
    const bytes=Buffer.from(JSON.stringify({format:'managed-website-v1',workspace,kind,id,value:captured,...(Object.keys(fields).length?{fields}:{})})),checksum=hash(bytes);
    for(const [checksum,body]of staged)await this.payloads.put(workspace,checksum,body);
    await this.payloads.put(workspace,checksum,bytes);
    const stamp:WebsiteRecordStamp={...key,workspace,kind,id,instanceId:this.instanceId,cellId:this.cellId,revision:(previous?.revision??0)+1,checksum};
    await this.database.client.send(new PutCommand({TableName:this.table,Item:stamp,ConditionExpression:previous?'attribute_exists(pk) AND #revision = :revision':'attribute_not_exists(pk)',...(previous?{ExpressionAttributeNames:{'#revision':'revision'},ExpressionAttributeValues:{':revision':previous.revision}}:{})}));
    return stamp;
  }
  guard(stamp:WebsiteRecordStamp):void{
    this.stamp(stamp,stamp.workspace,stamp.kind,stamp.id);
    this.database.client.checkRevision!(this.table,{pk:stamp.pk,sk:stamp.sk},stamp.revision);
  }
  async remove(stamp:WebsiteRecordStamp):Promise<void>{
    this.stamp(stamp,stamp.workspace,stamp.kind,stamp.id);
    await this.database.client.send(new PutCommand({TableName:this.table,Item:{...stamp,revision:stamp.revision+1,deleted:true},ConditionExpression:'attribute_exists(pk) AND #revision = :revision',ExpressionAttributeNames:{'#revision':'revision'},ExpressionAttributeValues:{':revision':stamp.revision}}));
  }
}
