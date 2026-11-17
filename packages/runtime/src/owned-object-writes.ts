import {createHash,randomUUID} from 'node:crypto';
import {withRepositoryRead,repositoryItems, type CellOwnedRecord, type HostRecord, type PersistenceTransaction, type UbeeqRepositories} from '@ubeeq/persistence';
import {cellScopedObjectKey, requireCreatorScopedObject, writeBoundedUploadContent, type StoredObject, type UploadAdapter, type UploadContentAdapter, type UploadInitiation, type UploadSealResult} from '@ubeeq/storage';
import type {UsageQuotaPort} from '@ubeeq/extension-sdk';
import {UsageSettlementOutbox} from './usage-settlement-outbox.js';
import {StorageClosureOutbox} from './storage-closure-outbox.js';

const thenable=(value:unknown):value is PromiseLike<unknown>=>!!value&&typeof value==='object'&&'then'in value&&typeof value.then==='function';
const namespace = 'runtime-owned-object';
const instant = (value: string) => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const canonical = (value: unknown): unknown => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))) return Object.fromEntries(Object.entries(value).filter(([,v]) => v !== undefined).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([k,v]) => [k,canonical(v)]));
  throw new Error('Owned object evidence must contain plain JSON facts.');
};
export const ownedEvidenceHash = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const hash = ownedEvidenceHash;
const conflict = (error: unknown) => /conflict|revision|conditional|already exists|transaction.*cancel/i.test(String(error));
/** A host quota decision is distinct from an uncertain provider write. */
export class OwnedObjectQuotaError extends Error {
  constructor(readonly reasonCode:string,readonly stage:'reservation'|'admission'){super(reasonCode);this.name='OwnedObjectQuotaError';}
}
export interface OwnedObjectIdentity {creatorId: string; operation: string; idempotencyKey: string;}
export interface OwnedObjectWriteRestriction {
  /** Fresh caller Source/member/hold restriction, after quota and metadata IO. */
  beforeNewPhysicalWrite():Promise<void>;
  /** Immediately before the actual adapter invocation; only throws/void. */
  assertNewPhysicalWriteActive():void;
}
export interface OwnedObjectWrite extends OwnedObjectIdentity {
  home: CellOwnedRecord; bucket: string; kind: 'renditions' | 'exports'; scope: StoredObject['scope'];
  contentType: string; body: Uint8Array; metadata?: Record<string, unknown>;
  /** Optional as a PAIR; runtime validation rejects only one or a non-void callback. */
  beforeNewPhysicalWrite?:OwnedObjectWriteRestriction['beforeNewPhysicalWrite'];
  assertNewPhysicalWriteActive?:OwnedObjectWriteRestriction['assertNewPhysicalWriteActive'];
}
/** Opt-in compile-time pair; the original extendable interface stays additive. */
export type RestrictedOwnedObjectWrite = OwnedObjectWrite & OwnedObjectWriteRestriction;
export interface OwnedObjectResult {object: StoredObject; metadata: Record<string, unknown>;}
interface Intent extends OwnedObjectIdentity {
  generation: number; previousProof?: string; requestHash: string; object: StoredObject; metadata: Record<string, unknown>;
  phase: 'prepared' | 'issued' | 'closing' | 'sealed' | 'completed'; expiresAt: string; closingAt?: string;
  provider?: UploadInitiation; completedObject?: StoredObject; seal?: UploadSealResult;
  usageIntentId?: string; closureIntentId?: string;
  /** Physical invocation history, never caller permission or persisted hooks. */
  restrictedWriteProtocol?:1;initiationHistoryUnknown?:true;
  initiation?:{id:string;preparedAt:string};initiationCancelled?:{id:string;preparedAt:string;proofId:string;cancelledAt:string};
  bodyInvocation?:{id:string;preparedAt:string};
}

/** Owns physical outputs independently of their logical parent. A retry can
 * reuse an accepted version; it must seal an empty generation before replacing
 * its key. Storage settlement survives failed asset/job transactions. */
export class OwnedObjectWrites {
  private readonly records: NonNullable<UbeeqRepositories['hostRecords']>;
  private readonly usage: UsageSettlementOutbox;
  private readonly closures: StorageClosureOutbox;
  private readonly initiating=new Map<string,{rowId:string;requestHash:string;invocation:{id:string;preparedAt:string};state:'unstarted'|'started'|'cancelled'}>();
  private readonly bodies=new Map<string,{cancelled:boolean}>();
  constructor(private readonly repositories: UbeeqRepositories, private readonly uploads: UploadAdapter & Partial<UploadContentAdapter>, private readonly quota: UsageQuotaPort, private readonly instanceId: string, private readonly cellId: string) {
    if (!repositories.hostRecords || !uploads.seal || !uploads.recoverCompletion || !quota.closeStorageReservation) throw new Error('Owned object writes require durable receipts, physical sealing and terminal storage reservations.');
    this.records = repositories.hostRecords;
    this.usage = new UsageSettlementOutbox(repositories,quota,instanceId,cellId);
    this.closures = new StorageClosureOutbox(repositories,quota,instanceId,cellId);
  }
  /** Adapter readScope queues Local metadata only; managed point reads retain
   * their ordinary semantics. No physical upload/seal/quota call is enclosed. */
  private readRecord(id:string){return withRepositoryRead(this.repositories,transaction=>this.records.get(id,{transaction}));}
  private createRecord(input:Parameters<NonNullable<UbeeqRepositories['hostRecords']>['create']>[0]){return this.repositories.transaction(transaction=>this.records.create(input,{transaction}));}
  private updateRecord(id:string,revision:number,patch:Parameters<NonNullable<UbeeqRepositories['hostRecords']>['update']>[2]){return this.repositories.transaction(transaction=>this.records.update(id,revision,patch,{transaction}));}
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
      || value.restrictedWriteProtocol!==undefined&&value.restrictedWriteProtocol!==1
      || value.initiationHistoryUnknown!==undefined&&value.initiationHistoryUnknown!==true
      || value.initiation!==undefined&&(!value.initiation.id||!instant(value.initiation.preparedAt))
      || value.bodyInvocation!==undefined&&(!value.bodyInvocation.id||!instant(value.bodyInvocation.preparedAt))
      || value.initiationCancelled!==undefined&&(!value.initiation||value.initiationCancelled.id!==value.initiation.id||value.initiationCancelled.preparedAt!==value.initiation.preparedAt||!instant(value.initiationCancelled.cancelledAt)||value.initiationCancelled.cancelledAt<value.initiationCancelled.preparedAt||value.initiationCancelled.proofId!==hash([row.id,value.requestHash,value.initiation,'initiation-never-invoked']))
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
  private async latest(input: OwnedObjectIdentity, transaction?: PersistenceTransaction): Promise<HostRecord | undefined> {
    const read = async (id:string) => {
      if (!transaction) return this.readRecord(id);
      // An accepting caller needs the actual commit-time lineage, including
      // missing generations. Ordinary managed point reads are not guards.
      if (!this.records.checkRevision || !this.records.checkAbsent) throw new Error('Owned output metadata requires actual accepting repository guards.');
      const row=await this.records.get(id,{transaction});
      if (row) await this.records.checkRevision(row.id,row.revision,{transaction});
      else await this.records.checkAbsent(id,{transaction});
      return row;
    };
    const inspect=async()=>{
    for (let generation=0; generation<1000; generation++) {
      const row = await read(this.id(input,generation));
      if (!row) return undefined;
      const value = this.value(row);
      if (value.phase !== 'sealed') return row;
      const next = await read(this.id(input,generation+1));
      if (!next) return row;
      const following = this.value(next);
      if (following.previousProof !== (value.seal as {proofId:string}).proofId || following.requestHash !== value.requestHash) throw new Error('Owned output generations conflict.');
    }
    throw new Error('Owned output generation limit requires reconciliation.');

    };
    return transaction ? inspect() : withRepositoryRead(this.repositories,inspect);
  }
  /** Read the original completed immutable receipt without attempting recovery,
   * physical/provider IO, quota settlement, or any metadata mutation. Passing
   * an actual accepting transaction binds every inspected generation/absence
   * until that transaction commits. This grants no logical attachment access. */
  async readCompleted(input:OwnedObjectIdentity,transaction?:PersistenceTransaction):Promise<OwnedObjectResult|undefined>{
    try {
      const row=await this.latest(input,transaction);if(!row)return;
      const value=this.value(row);
      if(value.phase==='completed')return {object:structuredClone(value.completedObject!),metadata:structuredClone(value.metadata)};
    } catch(error) {
      if(transaction)this.records.failTransaction?.();
      throw error;
    }
  }
  private async deliver(row: HostRecord) {
    const value = this.value(row), id = value.usageIntentId ?? value.closureIntentId;
    if (!id) return;
    const intent = await this.readRecord(id);
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
    const saved = (await this.readRecord(initial.id))!, value = this.value(saved);
    await this.deliver(saved);
    return {object:structuredClone(value.completedObject!),metadata:structuredClone(value.metadata)};
  }
  private restrictions(input:OwnedObjectWrite):Readonly<OwnedObjectWriteRestriction>|undefined{
    const before=input.beforeNewPhysicalWrite,active=input.assertNewPhysicalWriteActive;
    if(before===undefined&&active===undefined)return;
    if(typeof before!=='function'||typeof active!=='function')throw new Error('Supply both actual physical-write restrictions, or neither.');
    return Object.freeze({beforeNewPhysicalWrite:before,assertNewPhysicalWriteActive:active});
  }
  private async beforePhysical(restriction:Readonly<OwnedObjectWriteRestriction>){const pending:unknown=restriction.beforeNewPhysicalWrite();if(!thenable(pending))throw new Error('The current physical-write restriction must return a void promise.');if(await pending!==undefined)throw new Error('A physical-write restriction cannot return a grant or result.');}
  private assertPhysical(restriction:Readonly<OwnedObjectWriteRestriction>){const result:unknown=restriction.assertNewPhysicalWriteActive();if(result!==undefined){if(thenable(result))void Promise.resolve(result).catch(()=>{});throw new Error('The physical-write lifetime restriction must synchronously return void.');}}
  private async cancelInitiation(permit:{rowId:string;requestHash:string;invocation:{id:string;preparedAt:string};state:'unstarted'|'started'|'cancelled'}){
    if(this.initiating.get(permit.rowId)!==permit||permit.state==='started')throw new Error('The actual privately unstarted initiation is required.');permit.state='cancelled';
    for(let attempt=0;attempt<5;attempt++){
      const row=await this.readRecord(permit.rowId);if(!row)throw new Error('Owned output disappeared.');const value=this.value(row);
      if(value.requestHash!==permit.requestHash||hash(value.initiation)!==hash(permit.invocation))throw new Error('The original unstarted initiation changed.');
      if(value.provider||value.initiationCancelled)return;
      const initiationCancelled={...permit.invocation,proofId:hash([row.id,value.requestHash,permit.invocation,'initiation-never-invoked']),cancelledAt:new Date().toISOString()};
      try{await this.updateRecord(row.id,row.revision,{value:{...row.value,initiationCancelled}});return;}catch(error){if(!conflict(error)||attempt===4)throw error;}
    }
  }
  private async denyPhysical(initial:HostRecord,error:unknown):Promise<never>{
    try{
      let row=(await this.readRecord(initial.id))!;let value=this.value(row);
      // A newly restricted call cannot turn missing legacy initiation history
      // into a never-invoked fact. Preserve it explicitly for reconciliation.
      if(!value.provider&&!value.restrictedWriteProtocol&&!value.initiationHistoryUnknown){row=await this.updateRecord(row.id,row.revision,{value:{...row.value,initiationHistoryUnknown:true}});value=this.value(row);}
      await this.close(row);
    }catch(closureError){throw new AggregateError([error,closureError],'Owned output restriction denied; original physical closure requires reconciliation.');}
    throw error;
  }
  private async close(initial: HostRecord): Promise<void> {
    const pending=this.initiating.get(initial.id),body=this.bodies.get(initial.id);if(body)body.cancelled=true;if(pending&&pending.state!=='started')await this.cancelInitiation(pending);
    let row=(await this.readRecord(initial.id))??initial, value=this.value(row);
    for (let attempt=0; attempt<5; attempt++) {
      if (['completed','sealed'].includes(value.phase)) {await this.deliver(row); return;}
      if (value.phase === 'closing') break;
      try {row=await this.updateRecord(row.id,row.revision,{value:{...row.value,phase:'closing',closingAt:new Date().toISOString()}});value=this.value(row);break;}
      catch(error) {row=(await this.readRecord(row.id))!;value=this.value(row);if(!conflict(error)||attempt===4)throw error;}
    }
    if (value.phase !== 'closing') throw new Error('Owned output closure is pending.');
    if(!value.provider&&(value.initiationHistoryUnknown||value.initiation&&!value.initiationCancelled))throw new Error('The original physical initiation outcome is unknown; retain its reservation and await its actual provider receipt.');
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
    await this.deliver((await this.readRecord(row.id))!);
  }
  /** Reconcile a prior attempt without regenerating or repeating provider work. */
  async recover(input: OwnedObjectIdentity): Promise<OwnedObjectResult | undefined> {
    let row=await this.latest(input);if(!row)return;
    let value=this.value(row);
    if (!['completed','sealed'].includes(value.phase)) {await this.close(row);row=(await this.readRecord(row.id))!;value=this.value(row);}
    await this.deliver(row);
    if(value.phase==='completed')return {object:structuredClone(value.completedObject!),metadata:structuredClone(value.metadata)};
  }
  /** A failed old body may observe an independently accepted successor, but
   * only as a factual read. It never revives that old physical capability or
   * issues/settles/closes any generation. Ordinary return/denial paths precede it. */
  private async completedSuccessor(initial:HostRecord,restriction:Readonly<OwnedObjectWriteRestriction>|undefined):Promise<OwnedObjectResult|undefined>{
    const original=this.value(initial),policy=this.quota.checkCurrentPolicy;
    if(!policy)return;
    const active=()=>{if(restriction)this.assertPhysical(restriction);};
    active();const initialPolicy=await policy.call(this.quota,{creatorId:original.creatorId,operation:original.operation});active();if(initialPolicy.allowed!==true)return;
    const home=(row:CellOwnedRecord)=>({homeCellId:row.homeCellId,dataHomeRegion:row.dataHomeRegion,dataHomeAssignedAt:row.dataHomeAssignedAt,routingRevision:row.routingRevision});
    const immutable=(value:Intent)=>{const {phase,closingAt,seal,completedObject,usageIntentId,closureIntentId,...identity}=value;return identity;};
    const request=(value:Intent)=>{const {key,...object}=value.object;return{creatorId:value.creatorId,operation:value.operation,idempotencyKey:value.idempotencyKey,requestHash:value.requestHash,metadata:value.metadata,object};};
    const capture=()=>withRepositoryRead(this.repositories,async transaction=>{
      const read=(id:string)=>this.records.get(id,{transaction});
      let row=await read(initial.id);if(!row)return;
      let value=this.value(row);
      if(value.phase!=='sealed'||hash(immutable(value))!==hash(immutable(original))||hash(home(row))!==hash(home(initial))||row.createdAt!==initial.createdAt)return;
      const rows:HostRecord[]=[];
      for(let generation=original.generation;generation<1000;generation++){
        if(value.generation!==generation||hash(home(row))!==hash(home(initial))||hash(request(value))!==hash(request(original))||value.provider&&hash(value.provider.object)!==hash(value.object))return;
        rows.push(row);
        if(value.phase==='completed'){
          if(generation===original.generation||!value.provider||!value.completedObject||!value.usageIntentId||value.seal!==undefined||value.closureIntentId!==undefined)return;
          const writtenAt=value.completedObject.writtenAt;if(typeof writtenAt!=='string')return;
          const input={creatorId:value.creatorId,operation:value.operation,idempotencyKey:this.usageKey(row),storageBytesDelta:value.completedObject.byteLength,observedAt:writtenAt};
          const id=createHash('sha256').update(JSON.stringify([this.instanceId,'runtime-usage-settlement',input.creatorId,input.idempotencyKey])).digest('hex'),intent=await read(id);
          if(!intent||intent.id!==value.usageIntentId||intent.namespace!=='runtime-usage-settlement'||intent.instanceId!==this.instanceId||intent.scopeId!==input.creatorId||intent.key!==input.idempotencyKey||hash(home(intent))!==hash(home(initial))||!['pending','settled'].includes(String(intent.value.state))||hash(intent.value.input)!==hash(input)||intent.value.fingerprint!==JSON.stringify([input.creatorId,input.operation,input.idempotencyKey,0,input.storageBytesDelta,0,input.observedAt]))return;
          return{rows,row,value};
        }
        if(value.phase!=='sealed'||value.completedObject!==undefined||value.usageIntentId!==undefined||value.seal?.state!=='sealed'||!value.provider||!value.seal.proofId?.trim()||value.seal.proofId.length>200||!instant(value.seal.closedAt)||!value.closureIntentId)return;
        if(value.seal.retainedFence&&(value.seal.retainedFence.bucket!==value.provider.object.bucket||value.seal.retainedFence.key!==value.object.key||!value.seal.retainedFence.versionId||value.seal.retainedFence.byteLength!==0||value.seal.retainedFence.scope!=='private'||value.seal.retainedFence.writtenAt!==value.seal.closedAt))return;
        const input={creatorId:value.creatorId,operation:value.operation,idempotencyKey:this.usageKey(row),reservedBytes:value.object.byteLength,proofId:value.seal.proofId,observedAt:value.seal.closedAt};
        const id='storage-close-'+createHash('sha256').update(JSON.stringify(['runtime-storage-closure',this.instanceId,input.creatorId,input.idempotencyKey])).digest('hex'),intent=await read(id);
        if(!intent||intent.id!==value.closureIntentId||intent.namespace!=='runtime-storage-closure'||intent.instanceId!==this.instanceId||intent.scopeId!==input.creatorId||intent.key!==input.idempotencyKey||hash(home(intent))!==hash(home(initial))||!['pending','closed'].includes(String(intent.value.state))||hash(intent.value.input)!==hash(input)||intent.value.fingerprint!==JSON.stringify([input.creatorId,input.operation,input.idempotencyKey,input.reservedBytes,input.proofId,input.observedAt]))return;
        const following=await read(this.id(original,generation+1));if(!following)return;
        const next=this.value(following);if(next.generation!==generation+1||next.previousProof!==value.seal.proofId)return;
        row=following;value=next;
      }
    });
    // Validation failures cannot yield a successful fallback. These scopes
    // perform metadata reads only; repository rollback-only state is unchanged.
    let before:Awaited<ReturnType<typeof capture>>;try{before=await capture();}catch{active();return;}active();if(!before)return;
    const provider=before.value.provider,checksum=before.value.object.checksum;if(!provider||typeof checksum!=='string')return;
    let physical:StoredObject|undefined;
    try{physical=await this.uploads.recoverCompletion!({uploadId:provider.uploadId,cellId:this.cellId,creatorId:original.creatorId,checksum,byteLength:before.value.object.byteLength});}catch{active();return;}
    active();if(!physical||hash(physical)!==hash(before.value.completedObject))return;
    this.proveObject(before.value,physical);
    let after:Awaited<ReturnType<typeof capture>>;try{after=await capture();}catch{active();return;}active();if(!after||hash(after.rows)!==hash(before.rows))return;
    const finalPolicy=await policy.call(this.quota,{creatorId:original.creatorId,operation:original.operation});active();if(finalPolicy.allowed!==true)return;
    // Exact terminal rows and actual immutable provider bytes were re-read;
    // pending/settled outbox acknowledgment is never inferred or delivered.
    return{object:structuredClone(physical),metadata:structuredClone(after.value.metadata)};
  }
  async write(input: OwnedObjectWrite): Promise<OwnedObjectResult> {
    const restriction=this.restrictions(input);
    if(input.home.homeCellId!==this.cellId || !input.bucket || !input.contentType.trim() || !['private','restricted','public'].includes(input.scope) || input.body.byteLength<=0) throw new Error('Invalid owned output request.');
    const body=Uint8Array.from(input.body), checksum=createHash('sha256').update(body).digest('hex'), metadata=JSON.parse(JSON.stringify(canonical(input.metadata??{}))) as Record<string,unknown>;
    const requestHash=hash([input.bucket,input.contentType,body.byteLength,checksum,input.scope,input.kind,metadata]);
    let row=await this.latest(input), value=row?this.value(row):undefined;
    if(value && value.requestHash!==requestHash)throw new Error('Owned output request identity conflicts.');
    if(restriction&&row&&value&&!value.restrictedWriteProtocol&&!['completed','sealed'].includes(value.phase)){
      // A fresh caller restriction does not prove an OLD invocation absent.
      // Known capabilities must actually seal/recover before replacement;
      // missing legacy initiation history stays unresolved, never resent.
      if(!value.provider)return this.denyPhysical(row,new Error('The original legacy initiation history is unknown.'));
      await this.close(row);row=(await this.readRecord(row.id))!;value=this.value(row);
    }
    if(row && value && (value.phase==='closing'||!['completed','sealed'].includes(value.phase)&&(Date.parse(value.expiresAt)<=Date.now()||value.initiation&&!value.provider&&!value.initiationCancelled||value.bodyInvocation!==undefined))){await this.close(row);row=(await this.readRecord(row.id))!;value=this.value(row);}
    if(value?.phase==='completed'){await this.deliver(row!);return {object:structuredClone(value.completedObject!),metadata:structuredClone(value.metadata)};}
    if(row&&value?.restrictedWriteProtocol&&!restriction){
      // Omitting callbacks cannot reopen a restricted physical generation.
      // Its real already-completed receipt remains factual and recoverable.
      if(value.provider&&value.phase!=='sealed'){const recovered=await this.uploads.recoverCompletion!({uploadId:value.provider.uploadId,cellId:this.cellId,creatorId:input.creatorId,checksum,byteLength:body.byteLength});if(recovered)return this.commitObject(row,recovered);}
      throw new Error('The actual paired restrictions are required for new work on this owned output.');
    }
    if(!row || value?.phase==='sealed') {
      if(row)await this.deliver(row);
      const generation=value?value.generation+1:0;
      if(generation>=1000)throw new Error('Owned output generation limit requires reconciliation.');
      const intent:Intent={creatorId:input.creatorId,operation:input.operation,idempotencyKey:input.idempotencyKey,generation,...(value?.seal?.state==='sealed'?{previousProof:value.seal.proofId}:{}),requestHash,metadata,...(restriction?{restrictedWriteProtocol:1 as const}:{}),phase:'prepared',expiresAt:new Date(Date.now()+15*60_000).toISOString(),object:{bucket:input.bucket,key:this.objectKey({...input,generation},input.kind),contentType:input.contentType,byteLength:body.byteLength,checksum,scope:input.scope}};
      try {row=await this.createRecord({id:this.id(input,generation),instanceId:this.instanceId,namespace,scopeId:input.creatorId,key:input.idempotencyKey,homeCellId:input.home.homeCellId,dataHomeRegion:input.home.dataHomeRegion,dataHomeAssignedAt:input.home.dataHomeAssignedAt,routingRevision:input.home.routingRevision,value:intent as unknown as Record<string,unknown>});}
      catch(error){row=await this.readRecord(this.id(input,generation));if(!row)throw error;}
      value=this.value(row);if(value.requestHash!==requestHash)throw new Error('Owned output request identity conflicts.');
    }
    if(!row||!value)throw new Error('The actual original owned intent is unavailable.');
    // Another writer may win the initial create after latest() read absence.
    // Recheck the REAL winning row; a candidate's local protocol is not proof.
    if(restriction||value.restrictedWriteProtocol){
      if(value.phase==='completed')return this.commitObject(row,value.completedObject!);
      if(value.phase==='sealed')throw new Error('Owned output was closed during allocation. Retry the same operation.');
      if(!restriction){if(value.provider){const recovered=await this.uploads.recoverCompletion!({uploadId:value.provider.uploadId,cellId:this.cellId,creatorId:input.creatorId,checksum,byteLength:body.byteLength});if(recovered)return this.commitObject(row,recovered);}throw new Error('The actual paired restrictions are required for new work on this owned output.');}
      if(!value.restrictedWriteProtocol){if(!value.provider)return this.denyPhysical(row,new Error('The original legacy initiation history is unknown.'));await this.close(row);const closed=(await this.readRecord(row.id))!,facts=this.value(closed);if(facts.phase==='completed')return this.commitObject(closed,facts.completedObject!);throw new Error('The original legacy capability was sealed. Retry the same restricted operation.');}
    }
    const reservation=await this.quota.checkAndReserveQuota({creatorId:input.creatorId,operation:input.operation,idempotencyKey:this.usageKey(row),storageBytesDelta:body.byteLength});
    if(!reservation.allowed){const error=new OwnedObjectQuotaError(reservation.reasonCode??'Output storage quota exceeded.','reservation');if(restriction)return this.denyPhysical(row!,error);await this.close(row!);throw error;}
    // This re-read fences a late reserve or capability reply after closure.
    row=(await this.readRecord(row!.id))!;value=this.value(row);
    if(value.phase==='completed')return this.commitObject(row,value.completedObject!);
    if(!['prepared','issued'].includes(value.phase))throw new Error('Owned output was closed. Retry the same operation.');
    if(this.quota.checkCurrentAdmission){const current=await this.quota.checkCurrentAdmission({creatorId:input.creatorId,operation:input.operation,idempotencyKey:this.usageKey(row)});if(!current.allowed){const error=new OwnedObjectQuotaError(current.reasonCode??'Output storage admission denied.','admission');if(restriction)return this.denyPhysical(row,error);await this.close(row);throw error;}}
    if(!value.provider){
      let permit:{rowId:string;requestHash:string;invocation:{id:string;preparedAt:string};state:'unstarted'|'started'|'cancelled'}|undefined;
      if(restriction){
        const invocation={id:randomUUID(),preparedAt:new Date().toISOString()};
        row=await this.updateRecord(row.id,row.revision,{value:{...row.value,initiation:invocation}});value=this.value(row);
        permit={rowId:row.id,requestHash:value.requestHash,invocation,state:'unstarted'};this.initiating.set(row.id,permit);
        try{
          // This is the last awaited check before actual initiation. Closing
          // may cancel only this same private never-started permit.
          await this.beforePhysical(restriction);
          if(permit.state!=='unstarted')throw new Error('The original owned initiation was cancelled.');
          if(Date.parse(value.expiresAt)<=Date.now())throw new Error('The original owned initiation expired.');
          this.assertPhysical(restriction);
        }catch(error){try{await this.cancelInitiation(permit);}catch(closureError){throw new AggregateError([error,closureError],'The actual unstarted initiation requires reconciliation.');}finally{this.initiating.delete(row.id);}return this.denyPhysical(row,error);}
        permit.state='started';
      }
      let provider:UploadInitiation;
      try{provider=await this.uploads.initiate({object:structuredClone(value.object),checksumAlgorithm:'sha256',expiresAt:value.expiresAt,idempotencyKey:row.id});this.proveProvider(value,provider);}
      catch(error){if(permit)this.initiating.delete(permit.rowId);throw error;}
      try{for(let attempt=0;attempt<5;attempt++){
        row=(await this.readRecord(row.id))!;value=this.value(row);
        if(value.phase==='completed')return this.commitObject(row,value.completedObject!);
        const lateClosing=value.phase==='closing'&&permit?.state==='started'&&hash(value.initiation)===hash(permit.invocation);
        if(!['prepared','issued'].includes(value.phase)&&!lateClosing)throw new Error('Owned output was closed before capability publication.');
        if(value.provider){if(restriction&&value.provider.uploadId!==provider.uploadId)throw new Error('Owned output provider capabilities conflict.');break;}
        try{row=await this.updateRecord(row.id,row.revision,{value:{...row.value,phase:lateClosing?'closing':'issued',provider}});value=this.value(row);break;}
        catch(error){if(!conflict(error)||attempt===4)throw error;}
      }}finally{if(permit)this.initiating.delete(permit.rowId);}
      if(value.phase==='closing'){await this.close(row);const closed=(await this.readRecord(row.id))!,facts=this.value(closed);if(facts.phase==='completed')return this.commitObject(closed,facts.completedObject!);throw new Error('Owned output was closed before new body invocation.');}
    }
    const completion={uploadId:value.provider!.uploadId,cellId:this.cellId,creatorId:input.creatorId,checksum,byteLength:body.byteLength};
    const recovered=await this.uploads.recoverCompletion!(completion);if(recovered)return this.commitObject(row,recovered);
    let writeError:unknown,writeFailed=false,bodyPermit:{cancelled:boolean}|undefined;
    if(restriction){
      row=await this.updateRecord(row.id,row.revision,{value:{...row.value,bodyInvocation:{id:randomUUID(),preparedAt:new Date().toISOString()}}});value=this.value(row);bodyPermit={cancelled:false};this.bodies.set(row.id,bodyPermit);
      try{await this.beforePhysical(restriction);}catch(error){this.bodies.delete(row.id);return this.denyPhysical(row,error);}
    }
    const bodyExpiresAt=value.expiresAt;
    let lifetimeDenied=false,lifetimeError:unknown;
    try {
      await writeBoundedUploadContent({uploads:this.uploads,upload:value.provider!,cellId:this.cellId,creatorId:input.creatorId,body,...(restriction?{assertNewPhysicalWriteActive:()=>{try{if(bodyPermit?.cancelled)throw new Error('The original owned body invocation was cancelled.');if(Date.parse(bodyExpiresAt)<=Date.now())throw new Error('The original owned body capability expired.');this.assertPhysical(restriction);}catch(error){lifetimeDenied=true;lifetimeError=error;throw error;}}}:{})});
    }catch(error){writeFailed=true;writeError=error;}
    finally{if(bodyPermit)this.bodies.delete(row.id);}
    if(lifetimeDenied&&restriction)return this.denyPhysical(row,lifetimeError);
    let object:StoredObject|undefined;
    try{object=writeFailed ? await this.uploads.recoverCompletion!(completion) : await this.uploads.complete(completion);}
    catch(error){object=await this.uploads.recoverCompletion!(completion);if(!object){if(writeFailed){const successor=await this.completedSuccessor(row,restriction);if(successor)return successor;}throw error;}}
    if(!object){if(writeFailed){const successor=await this.completedSuccessor(row,restriction);if(successor)return successor;throw writeError;}throw new Error('Output upload requires recovery.');}
    return this.commitObject(row,object);
  }
  async repair(limit=25):Promise<number>{
    let count=0,failure:unknown;
    for await(const row of repositoryItems(request=>withRepositoryRead(this.repositories,transaction=>this.records.list(request,{transaction})))){
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
