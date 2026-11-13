import {createHash} from 'node:crypto';
import {repositoryItems, type CellOwnedRecord, type HostRecord, type UbeeqRepositories} from '@ubeeq/persistence';
import {cellScopedObjectKey, requireCreatorScopedObject, writeBoundedUploadContent, type StoredObject, type UploadAdapter, type UploadContentAdapter, type UploadInitiation, type UploadSealResult} from '@ubeeq/storage';
import type {UsageQuotaPort} from '@ubeeq/extension-sdk';
import {UsageSettlementOutbox} from './usage-settlement-outbox.js';
import {StorageClosureOutbox} from './storage-closure-outbox.js';

const namespace = 'runtime-owned-object';
const instant = (value: string) => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const canonical = (value: unknown): unknown => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))) return Object.fromEntries(Object.entries(value).filter(([,v]) => v !== undefined).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([k,v]) => [k,canonical(v)]));
  throw new Error('Owned object evidence must contain plain JSON facts.');
};
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const conflict = (error: unknown) => /conflict|revision|conditional|already exists|transaction.*cancel/i.test(String(error));
/** A host quota decision is distinct from an uncertain provider write. */
export class OwnedObjectQuotaError extends Error {
  constructor(readonly reasonCode:string,readonly stage:'reservation'|'admission'){super(reasonCode);this.name='OwnedObjectQuotaError';}
}
export interface OwnedObjectIdentity {creatorId: string; operation: string; idempotencyKey: string;}
export interface OwnedObjectWrite extends OwnedObjectIdentity {
  home: CellOwnedRecord; bucket: string; kind: 'renditions' | 'exports'; scope: StoredObject['scope'];
  contentType: string; body: Uint8Array; metadata?: Record<string, unknown>;
}
export interface OwnedObjectResult {object: StoredObject; metadata: Record<string, unknown>;}
interface Intent extends OwnedObjectIdentity {
  generation: number; previousProof?: string; requestHash: string; object: StoredObject; metadata: Record<string, unknown>;
  phase: 'prepared' | 'issued' | 'closing' | 'sealed' | 'completed'; expiresAt: string; closingAt?: string;
  provider?: UploadInitiation; completedObject?: StoredObject; seal?: UploadSealResult;
  usageIntentId?: string; closureIntentId?: string;
}

/** Owns physical outputs independently of their logical parent. A retry can
 * reuse an accepted version; it must seal an empty generation before replacing
 * its key. Storage settlement survives failed asset/job transactions. */
export class OwnedObjectWrites {
  private readonly records: NonNullable<UbeeqRepositories['hostRecords']>;
  private readonly usage: UsageSettlementOutbox;
  private readonly closures: StorageClosureOutbox;
  constructor(private readonly repositories: UbeeqRepositories, private readonly uploads: UploadAdapter & Partial<UploadContentAdapter>, private readonly quota: UsageQuotaPort, private readonly instanceId: string, private readonly cellId: string) {
    if (!repositories.hostRecords || !uploads.seal || !uploads.recoverCompletion || !quota.closeStorageReservation) throw new Error('Owned object writes require durable receipts, physical sealing and terminal storage reservations.');
    this.records = repositories.hostRecords;
    this.usage = new UsageSettlementOutbox(repositories,quota,instanceId,cellId);
    this.closures = new StorageClosureOutbox(repositories,quota,instanceId,cellId);
  }
  private base(input: OwnedObjectIdentity) {
    if ([input.creatorId,input.operation,input.idempotencyKey].some(value=>typeof value!=='string'||!value.trim()||value.length>200)) throw new Error('Owned object identity is required.');
    return hash([this.instanceId,this.cellId,input.creatorId,input.operation,input.idempotencyKey]);
  }
  private id(input: OwnedObjectIdentity, generation: number) {return `owned-object-${this.base(input)}-${generation}`;}
  private usageKey(row: HostRecord) {return `physical-object:${row.id}`;}
  private value(row: HostRecord): Intent {
    const value = row.value as unknown as Intent;
    if (row.namespace !== namespace || row.instanceId !== this.instanceId || row.homeCellId !== this.cellId || !value
      || !Number.isSafeInteger(value.generation) || value.generation < 0 || value.generation >= 1000
      || row.id !== this.id(value,value.generation) || row.scopeId !== value.creatorId || row.key !== value.idempotencyKey
      || !['prepared','issued','closing','sealed','completed'].includes(value.phase) || !instant(value.expiresAt)
      || !value.object || typeof value.object.bucket !== 'string' || !value.object.bucket.trim()
      || typeof value.object.key !== 'string' || typeof value.object.contentType !== 'string' || !value.object.contentType.trim()
      || !['private','restricted','public'].includes(value.object.scope)
      || !/^[a-f0-9]{64}$/.test(value.object.checksum ?? '') || !Number.isSafeInteger(value.object.byteLength) || value.object.byteLength <= 0
      || value.requestHash !== hash([value.object.bucket,value.object.contentType,value.object.byteLength,value.object.checksum,value.object.scope,value.object.key.split('/').at(-2),value.metadata])
      || value.object.key !== this.objectKey(value,value.object.key.split('/').at(-2) as 'renditions' | 'exports')
      || (value.phase === 'issued' && !value.provider) || (value.phase === 'closing' && !instant(value.closingAt!))
      || (value.phase === 'sealed' && value.seal?.state !== 'sealed') || (value.phase === 'completed' && !value.completedObject)) throw new Error('Owned object journal requires reconciliation.');
    requireCreatorScopedObject(value.object.key,{cellId:this.cellId,creatorId:value.creatorId});
    if (value.provider) this.proveProvider(value,value.provider);
    if (value.completedObject) this.proveObject(value,value.completedObject);
    return value;
  }
  private objectKey(value: OwnedObjectIdentity & {generation: number}, kind: 'renditions' | 'exports') {
    if (!['renditions','exports'].includes(kind)) throw new Error('Invalid owned output kind.');
    return cellScopedObjectKey({cellId:this.cellId,creatorId:value.creatorId,kind,objectId:`output-${this.base(value)}-${value.generation}`});
  }
  private proveProvider(value: Intent, provider: UploadInitiation) {
    if (!provider.uploadId || provider.expiresAt !== value.expiresAt || provider.object.key !== value.object.key || provider.object.contentType !== value.object.contentType || provider.object.byteLength !== value.object.byteLength || provider.object.checksum !== value.object.checksum || provider.object.scope !== value.object.scope || !provider.object.bucket) throw new Error('Owned output provider capability conflicts.');
  }
  private proveObject(value: Intent, object: StoredObject) {
    if (!value.provider || !object.versionId || object.bucket !== value.provider.object.bucket || object.key !== value.object.key || object.contentType !== value.object.contentType || object.byteLength !== value.object.byteLength || object.checksum !== value.object.checksum || object.scope !== value.object.scope || !instant(object.writtenAt!)) throw new Error('Owned output physical receipt conflicts.');
  }
  private async latest(input: OwnedObjectIdentity): Promise<HostRecord | undefined> {
    for (let generation=0; generation<1000; generation++) {
      const row = await this.records.get(this.id(input,generation));
      if (!row) return undefined;
      const value = this.value(row);
      if (value.phase !== 'sealed') return row;
      const next = await this.records.get(this.id(input,generation+1));
      if (!next) return row;
      const following = this.value(next);
      if (following.previousProof !== (value.seal as {proofId:string}).proofId || following.requestHash !== value.requestHash) throw new Error('Owned output generations conflict.');
    }
    throw new Error('Owned output generation limit requires reconciliation.');
  }
  private async deliver(row: HostRecord) {
    const value = this.value(row), id = value.usageIntentId ?? value.closureIntentId;
    if (!id) return;
    const intent = await this.records.get(id);
    if (!intent || intent.scopeId !== value.creatorId || (intent.value.input as {idempotencyKey?:string})?.idempotencyKey !== this.usageKey(row)) throw new Error('Owned output accounting intent requires reconciliation.');
    try {if (value.usageIntentId) await this.usage.deliver(intent); else await this.closures.deliver(intent);} catch {/* The receipt and independently replayable intent are already committed. */}
  }
  private async commitObject(initial: HostRecord, object: StoredObject): Promise<OwnedObjectResult> {
    this.proveObject(this.value(initial),object);
    for (let attempt=0; attempt<5; attempt++) {
      try {
        await this.repositories.transaction(async transaction => {
          const row = await this.records.get(initial.id,{transaction}); if (!row) throw new Error('Owned output disappeared.');
          const value = this.value(row);
          if (value.phase === 'completed') {if (hash(value.completedObject) !== hash(object)) throw new Error('Owned output versions conflict.'); return;}
          if (!['issued','closing'].includes(value.phase)) throw new Error('Owned output is no longer writable.');
          const intent = await this.usage.enqueue({creatorId:value.creatorId,operation:value.operation,idempotencyKey:this.usageKey(row),storageBytesDelta:object.byteLength,observedAt:object.writtenAt!},row,transaction);
          await this.records.update(row.id,row.revision,{value:{...row.value,phase:'completed',completedObject:object,usageIntentId:intent.id}},{transaction});
        }); break;
      } catch (error) {if (!conflict(error) || attempt===4) throw error;}
    }
    const saved = (await this.records.get(initial.id))!, value = this.value(saved);
    await this.deliver(saved);
    return {object:structuredClone(value.completedObject!),metadata:structuredClone(value.metadata)};
  }
  private async close(initial: HostRecord): Promise<void> {
    let row=initial, value=this.value(row);
    for (let attempt=0; attempt<5; attempt++) {
      if (['completed','sealed'].includes(value.phase)) {await this.deliver(row); return;}
      if (value.phase === 'closing') break;
      try {row=await this.records.update(row.id,row.revision,{value:{...row.value,phase:'closing',closingAt:new Date().toISOString()}});value=this.value(row);break;}
      catch(error) {row=(await this.records.get(row.id))!;value=this.value(row);if(!conflict(error)||attempt===4)throw error;}
    }
    if (value.phase !== 'closing') throw new Error('Owned output closure is pending.');
    const seal: UploadSealResult = value.provider ? await this.uploads.seal!({uploadId:value.provider.uploadId,cellId:this.cellId,creatorId:value.creatorId}) : {state:'sealed',proofId:hash([row.id,'never-issued',value.closingAt]),closedAt:value.closingAt!};
    if (seal.state === 'completed') {await this.commitObject(row,seal.object);return;}
    if (!seal.proofId?.trim() || seal.proofId.length>200 || !instant(seal.closedAt)) throw new Error('Owned output closure proof is required.');
    if (seal.retainedFence && (!value.provider || seal.retainedFence.bucket!==value.provider.object.bucket || seal.retainedFence.key!==value.object.key || !seal.retainedFence.versionId || seal.retainedFence.byteLength!==0 || seal.retainedFence.scope!=='private' || seal.retainedFence.writtenAt!==seal.closedAt)) throw new Error('Owned output fence conflicts.');
    for (let attempt=0;attempt<5;attempt++) {
      try {
        await this.repositories.transaction(async transaction=>{
          const current=(await this.records.get(row.id,{transaction}))!, saved=this.value(current);
          if (saved.phase==='sealed') {if(hash(saved.seal)!==hash(seal))throw new Error('Owned closure proofs conflict.');return;}
          if (saved.phase!=='closing') throw new Error('Owned closure phase conflicts.');
          const intent=await this.closures.enqueue({creatorId:saved.creatorId,operation:saved.operation,idempotencyKey:this.usageKey(current),reservedBytes:saved.object.byteLength,proofId:seal.proofId,observedAt:seal.closedAt},current,transaction);
          await this.records.update(current.id,current.revision,{value:{...current.value,phase:'sealed',seal,closureIntentId:intent.id}},{transaction});
        });break;
      } catch(error){if(!conflict(error)||attempt===4)throw error;}
    }
    await this.deliver((await this.records.get(row.id))!);
  }
  /** Reconcile a prior attempt without regenerating or repeating provider work. */
  async recover(input: OwnedObjectIdentity): Promise<OwnedObjectResult | undefined> {
    let row=await this.latest(input);if(!row)return;
    let value=this.value(row);
    if (!['completed','sealed'].includes(value.phase)) {await this.close(row);row=(await this.records.get(row.id))!;value=this.value(row);}
    await this.deliver(row);
    if(value.phase==='completed')return {object:structuredClone(value.completedObject!),metadata:structuredClone(value.metadata)};
  }
  async write(input: OwnedObjectWrite): Promise<OwnedObjectResult> {
    if(input.home.homeCellId!==this.cellId || !input.bucket || !input.contentType.trim() || !['private','restricted','public'].includes(input.scope) || input.body.byteLength<=0) throw new Error('Invalid owned output request.');
    const body=Uint8Array.from(input.body), checksum=createHash('sha256').update(body).digest('hex'), metadata=JSON.parse(JSON.stringify(canonical(input.metadata??{}))) as Record<string,unknown>;
    const requestHash=hash([input.bucket,input.contentType,body.byteLength,checksum,input.scope,input.kind,metadata]);
    let row=await this.latest(input), value=row?this.value(row):undefined;
    if(value && value.requestHash!==requestHash)throw new Error('Owned output request identity conflicts.');
    if(row && value && (value.phase==='closing'||!['completed','sealed'].includes(value.phase)&&Date.parse(value.expiresAt)<=Date.now())){await this.close(row);row=(await this.records.get(row.id))!;value=this.value(row);}
    if(value?.phase==='completed'){await this.deliver(row!);return {object:structuredClone(value.completedObject!),metadata:structuredClone(value.metadata)};}
    if(!row || value?.phase==='sealed') {
      if(row)await this.deliver(row);
      const generation=value?value.generation+1:0;
      if(generation>=1000)throw new Error('Owned output generation limit requires reconciliation.');
      const intent:Intent={creatorId:input.creatorId,operation:input.operation,idempotencyKey:input.idempotencyKey,generation,...(value?.seal?.state==='sealed'?{previousProof:value.seal.proofId}:{}),requestHash,metadata,phase:'prepared',expiresAt:new Date(Date.now()+15*60_000).toISOString(),object:{bucket:input.bucket,key:this.objectKey({...input,generation},input.kind),contentType:input.contentType,byteLength:body.byteLength,checksum,scope:input.scope}};
      try {row=await this.records.create({id:this.id(input,generation),instanceId:this.instanceId,namespace,scopeId:input.creatorId,key:input.idempotencyKey,homeCellId:input.home.homeCellId,dataHomeRegion:input.home.dataHomeRegion,dataHomeAssignedAt:input.home.dataHomeAssignedAt,routingRevision:input.home.routingRevision,value:intent as unknown as Record<string,unknown>});}
      catch(error){row=await this.records.get(this.id(input,generation));if(!row)throw error;}
      value=this.value(row);if(value.requestHash!==requestHash)throw new Error('Owned output request identity conflicts.');
    }
    const reservation=await this.quota.checkAndReserveQuota({creatorId:input.creatorId,operation:input.operation,idempotencyKey:this.usageKey(row!),storageBytesDelta:body.byteLength});
    if(!reservation.allowed){await this.close(row!);throw new OwnedObjectQuotaError(reservation.reasonCode??'Output storage quota exceeded.','reservation');}
    // This re-read fences a late reserve or capability reply after closure.
    row=(await this.records.get(row!.id))!;value=this.value(row);
    if(value.phase==='completed')return this.commitObject(row,value.completedObject!);
    if(!['prepared','issued'].includes(value.phase))throw new Error('Owned output was closed. Retry the same operation.');
    if(this.quota.checkCurrentAdmission){const current=await this.quota.checkCurrentAdmission({creatorId:input.creatorId,operation:input.operation,idempotencyKey:this.usageKey(row)});if(!current.allowed){await this.close(row);throw new OwnedObjectQuotaError(current.reasonCode??'Output storage admission denied.','admission');}}
    if(!value.provider){
      const provider=await this.uploads.initiate({object:structuredClone(value.object),checksumAlgorithm:'sha256',expiresAt:value.expiresAt,idempotencyKey:row.id});this.proveProvider(value,provider);
      for(let attempt=0;attempt<5;attempt++){
        row=(await this.records.get(row.id))!;value=this.value(row);
        if(value.phase==='completed')return this.commitObject(row,value.completedObject!);
        if(!['prepared','issued'].includes(value.phase))throw new Error('Owned output was closed before capability publication.');
        if(value.provider)break;
        try{row=await this.records.update(row.id,row.revision,{value:{...row.value,phase:'issued',provider}});value=this.value(row);break;}
        catch(error){if(!conflict(error)||attempt===4)throw error;}
      }
    }
    const completion={uploadId:value.provider!.uploadId,cellId:this.cellId,creatorId:input.creatorId,checksum,byteLength:body.byteLength};
    const recovered=await this.uploads.recoverCompletion!(completion);if(recovered)return this.commitObject(row,recovered);
    let writeError:unknown;
    try {
      await writeBoundedUploadContent({uploads:this.uploads,upload:value.provider!,cellId:this.cellId,creatorId:input.creatorId,body});
    }catch(error){writeError=error;}
    let object:StoredObject|undefined;
    try{object=writeError ? await this.uploads.recoverCompletion!(completion) : await this.uploads.complete(completion);}
    catch(error){object=await this.uploads.recoverCompletion!(completion);if(!object)throw error;}
    if(!object)throw writeError??new Error('Output upload requires recovery.');
    return this.commitObject(row,object);
  }
  async repair(limit=25):Promise<number>{
    let count=0,failure:unknown;
    for await(const row of repositoryItems(request=>this.records.list(request))){
      if(row.namespace!==namespace||row.instanceId!==this.instanceId||row.homeCellId!==this.cellId)continue;
      const value=this.value(row);
      if(!['closing'].includes(value.phase)&&!(['prepared','issued'].includes(value.phase)&&Date.parse(value.expiresAt)<=Date.now()))continue;
      try{await this.close(row);}catch(error){failure??=error;}
      if(++count>=limit)break;
    }
    try{await this.usage.drain(limit);await this.closures.drain(limit);}catch(error){failure??=error;}
    if(failure)throw failure;return count;
  }
}
