import {createHash} from 'node:crypto';
import type {AssetRecord, HostRecord, UbeeqRepositories} from '@ubeeq/persistence';
import type {MediaProcessor, ProcessedRendition} from '@ubeeq/processing';
import {cellScopedObjectKey, requireCreatorScopedObject, type ObjectStorage, type StoredObject} from '@ubeeq/storage';
import {ownedEvidenceHash as hash, type OwnedObjectWrites} from './owned-object-writes.js';

type Result = Awaited<ReturnType<MediaProcessor['process']>>;
type Evidence = Omit<Result, 'renditions'> & {renditions: Omit<ProcessedRendition,'body'>[]};
interface Output {id:string; contentType:string; byteLength:number; checksum:string; scope:StoredObject['scope'];}
interface Plan {binding:string; result:Evidence; primary:string; outputs:Output[]; aliases:Record<string,string>;}
interface Journal {plan:Plan; fingerprint:string; objects:Record<string,StoredObject>;}
export interface ProcessedOutputReference {id:string; sourceVersionId:string; role:ProcessedRendition['role']; storage:StoredObject;}
export interface ProcessedOutputs {result:Evidence; storage:StoredObject; renditions:ProcessedOutputReference[];}
const namespace='runtime-processed-outputs';
const checksum=(body:Uint8Array)=>createHash('sha256').update(body).digest('hex');
const conflict=(error:unknown)=>/conflict|revision|conditional|already exists|transaction.*cancel/i.test(String(error));

/** Binds a complete output set before writing bytes. The physical-write journal
 * owns accounting independently, even when the final asset transaction fails. */
export async function persistProcessedOutputs(input:{
  repositories:UbeeqRepositories; storage:ObjectStorage; owned?:OwnedObjectWrites;
  asset:AssetRecord; source:StoredObject; usageKey:string;
  assertCurrent():Promise<void>;
  produce():Promise<{result:Result; fallback():Promise<{bytes:Uint8Array;mimeType:string}>}>;
  transform(bytes:Uint8Array,mimeType:string):Promise<{bytes:Uint8Array;mimeType:string}>;
}):Promise<ProcessedOutputs>{
  const {repositories,asset,source,usageKey}=input, records=repositories.hostRecords;
  const identity={creatorId:asset.creatorId,operation:'asset.rendition',idempotencyKey:usageKey};
  const binding=hash([asset.instanceId,asset.homeCellId,asset.dataHomeRegion,asset.dataHomeAssignedAt,asset.routingRevision,asset.creatorId,asset.id,asset.objectVersion,asset.checksum,asset.mimeType,source,usageKey]);
  const id=`processed-outputs-${hash([asset.instanceId,asset.homeCellId,asset.creatorId,usageKey])}`;
  let row=await records?.get(id);
  const read=(record:HostRecord):Journal=>{
    const value=record.value as unknown as Journal;
    if(record.namespace!==namespace||record.instanceId!==asset.instanceId||record.homeCellId!==asset.homeCellId||record.scopeId!==asset.creatorId||record.key!==usageKey
      || !value?.plan || value.plan.binding!==binding || value.fingerprint!==hash(value.plan) || !value.objects
      || !Array.isArray(value.plan.outputs) || value.plan.outputs.length<1 || value.plan.outputs.length>65
      || new Set(value.plan.outputs.map(output=>output.id)).size!==value.plan.outputs.length
      || !value.plan.outputs.some(output=>output.id===value.plan.primary))throw new Error('Processed output journal requires reconciliation.');
    for(const [key,object]of Object.entries(value.objects))prove(value.plan,key,object);
    return value;
  };
  const prove=(plan:Plan,key:string,object:StoredObject)=>{
    const output=plan.outputs.find(value=>value.id===key);
    if(!output||!object.versionId||object.bucket!==source.bucket||object.contentType!==output.contentType||object.byteLength!==output.byteLength||object.checksum!==output.checksum||object.scope!==output.scope)throw new Error('Processed output receipt conflicts.');
    requireCreatorScopedObject(object.key,{cellId:asset.homeCellId,creatorId:asset.creatorId});
  };
  let journal=row?read(row):undefined;
  // Receipts from the preceding single-output implementation remain recoverable.
  // A new journal always takes precedence over this legacy compatibility path.
  if(!row){
    const legacy=await input.owned?.recover(identity);
    if(legacy){
      if(legacy.metadata.outputSet!==undefined)throw new Error('Processed output set journal is missing; reconciliation is required.');
      const result=legacy.metadata.processingResult as Evidence;
      if(!result?.metadata||!Array.isArray(result.renditions))throw new Error('Recovered processing evidence requires reconciliation.');
      return {result,storage:legacy.object,renditions:[]};
    }
  }
  const identityFor=(output:Output,plan:Plan)=>output.id===plan.primary?identity:{creatorId:asset.creatorId,operation:'asset.rendition-output',idempotencyKey:hash([usageKey,output.id])};
  const save=async(key:string,object:StoredObject)=>{
    prove(journal!.plan,key,object);
    if(!records){journal!.objects[key]=object;return;}
    for(let attempt=0;attempt<5;attempt++){
      row=(await records.get(id))!;const current=read(row), previous=current.objects[key];
      if(previous){if(hash(previous)!==hash(object))throw new Error('Processed output immutable versions conflict.');journal=current;return;}
      try{row=await records.update(id,row.revision,{value:{...row.value,objects:{...current.objects,[key]:object}}});journal=read(row);return;}
      catch(error){if(!conflict(error)||attempt===4)throw error;}
    }
  };
  if(journal&&input.owned)for(const output of journal.plan.outputs)if(!journal.objects[output.id]){
    const recovered=await input.owned.recover(identityFor(output,journal.plan));
    if(recovered){if(recovered.metadata.outputSet!==journal.fingerprint)throw new Error('Processed output set conflicts.');await save(output.id,recovered.object);}
  }
  if(!journal||journal.plan.outputs.some(output=>!journal!.objects[output.id])){
    const produced=await input.produce(), result=produced.result;
    if(!result||!result.metadata||!Array.isArray(result.renditions)||result.renditions.length>64||!Number.isFinite(result.measuredUnits)||result.measuredUnits<0)throw new Error('Invalid processed output result.');
    const ids=new Set<string>();
    for(const rendition of result.renditions){
      if(typeof rendition.id!=='string'||!rendition.id.trim()||rendition.id.length>200||ids.has(rendition.id)||rendition.sourceVersionId!==asset.objectVersion
        ||!['source','preview','poster'].includes(rendition.role)||typeof rendition.contentType!=='string'||!/^[-\w.+]+\/[-\w.+]+$/.test(rendition.contentType)
        ||!Number.isSafeInteger(rendition.byteLength)||rendition.byteLength<0
        ||rendition.body!==undefined&&(!(rendition.body instanceof Uint8Array)||!rendition.body.byteLength||rendition.body.byteLength!==rendition.byteLength))throw new Error('Invalid processed rendition identity, source version or bytes.');
      ids.add(rendition.id);
    }
    if(result.renditions.some(value=>value.body)&&(!records||!input.owned))throw new Error('Encoded outputs require a durable journal and recoverable physical output writes.');
    const serial:Evidence={...result,renditions:result.renditions.map(({body:_body,...value})=>value)};
    // Validate JSON before any object write; no transient bytes enter the journal.
    hash(serial);
    if(Buffer.byteLength(JSON.stringify(serial))>96*1024)throw new Error('Processed output evidence exceeds its journal budget.');
    const previews=result.renditions.filter(value=>value.role==='preview'&&value.body);
    const selected=result.primaryRenditionId===undefined?(previews.length===1?previews[0]:undefined):previews.find(value=>value.id===result.primaryRenditionId);
    if(result.primaryRenditionId!==undefined&&!selected)throw new Error('Primary rendition must identify an encoded preview.');
    const outputs:Output[]=[],aliases:Record<string,string>=Object.create(null),bodies=new Map<string,Uint8Array>();
    const add=(bytes:Uint8Array,contentType:string,scope:StoredObject['scope'])=>{
      if(!(bytes instanceof Uint8Array)||!bytes.byteLength||!/^[-\w.+]+\/[-\w.+]+$/.test(contentType))throw new Error('Invalid transformed output.');
      const digest=checksum(bytes),key=hash([contentType,bytes.byteLength,digest,scope]);
      if(!bodies.has(key)){outputs.push({id:key,contentType,byteLength:bytes.byteLength,checksum:digest,scope});bodies.set(key,Uint8Array.from(bytes));}
      return key;
    };
    let primary:string|undefined;
    for(const rendition of result.renditions)if(rendition.body){
      const transformed=await input.transform(Uint8Array.from(rendition.body),rendition.contentType);
      const key=add(transformed.bytes,transformed.mimeType,rendition===selected?'public':'private');aliases[rendition.id]=key;
      if(rendition===selected)primary=key;
    }
    if(!primary){const fallback=await produced.fallback();primary=add(fallback.bytes,fallback.mimeType,'public');}
    const plan:Plan={binding,result:serial,primary,outputs,aliases},fingerprint=hash(plan);
    if(journal){if(journal.fingerprint!==fingerprint)throw new Error('Processed output recipe or bytes changed during recovery.');}
    else{
      journal={plan,fingerprint,objects:{}};
      if(records){
        try{row=await records.create({id,instanceId:asset.instanceId,homeCellId:asset.homeCellId,dataHomeRegion:asset.dataHomeRegion,dataHomeAssignedAt:asset.dataHomeAssignedAt,routingRevision:asset.routingRevision,namespace,scopeId:asset.creatorId,key:usageKey,value:journal as unknown as Record<string,unknown>});}
        catch(error){row=await records.get(id);if(!row)throw error;}
        journal=read(row!);if(journal.fingerprint!==fingerprint)throw new Error('Concurrent processed output sets conflict.');
      }
    }
    for(const output of journal.plan.outputs)if(!journal.objects[output.id]){
      await input.assertCurrent();
      const body=bodies.get(output.id)!;
      let object:StoredObject;
      if(input.owned)object=(await input.owned.write({...identityFor(output,journal.plan),home:asset,bucket:source.bucket,kind:'renditions',scope:output.scope,contentType:output.contentType,body,metadata:{outputSet:journal.fingerprint,processingResult:serial}})).object;
      else{
        object={bucket:source.bucket,key:cellScopedObjectKey({cellId:asset.homeCellId,creatorId:asset.creatorId,kind:'renditions',objectId:`processed-${hash([id,output.id])}`}),versionId:hash([id,output.id]),contentType:output.contentType,byteLength:output.byteLength,checksum:output.checksum,scope:output.scope};
        await input.storage.put({object,body});
      }
      await save(output.id,object);
    }
  }
  await input.assertCurrent();
  return {result:journal.plan.result,storage:journal.objects[journal.plan.primary]!,renditions:journal.plan.result.renditions.filter(value=>journal!.plan.aliases[value.id]).map(value=>({id:value.id,sourceVersionId:value.sourceVersionId,role:value.role,storage:journal!.objects[journal!.plan.aliases[value.id]]!}))};
}
