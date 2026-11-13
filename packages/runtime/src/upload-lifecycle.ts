import { createHash, randomUUID } from 'node:crypto';
import { repositoryItems, type AssetRecord, type HostRecord, type UbeeqRepositories, type WorkRecord } from '@ubeeq/persistence';
import { cellScopedObjectKey, requireCreatorScopedObject, type StoredObject, type UploadAdapter, type UploadContentAdapter, type UploadInitiation } from '@ubeeq/storage';
import type { DurableJob, JobQueue } from '@ubeeq/jobs';
import type {UsageQuotaPort} from '@ubeeq/extension-sdk';
import {UsageSettlementOutbox} from './usage-settlement-outbox.js';
import {StorageClosureOutbox} from './storage-closure-outbox.js';
import type {UploadSealResult} from '@ubeeq/storage';

const namespace = 'runtime-upload';
const hash = (value: unknown) => {
  const canonical = (input:unknown):unknown => {
    if (input===null || typeof input==='string' || typeof input==='boolean' || typeof input==='number' && Number.isFinite(input)) return input;
    if (Array.isArray(input)) return input.map(canonical);
    if (input && typeof input==='object') return Object.fromEntries(Object.entries(input).filter(([,v])=>v!==undefined).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>[k,canonical(v)]));
    throw new Error('Upload evidence must contain plain JSON facts.');
  };
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
};
const instant = (value: string) => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const conflict = (error: unknown) => error instanceof Error && ['OptimisticConcurrencyError','UniqueConstraintError','ConditionalCheckFailedException','TransactionCanceledException'].includes(error.name);
export class UploadLifecycleError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) { super(message); }
}
interface Completion { checksum: string; byteLength: number }
interface UploadIntent {
  schemaVersion: 1; uploadId: string; actorId: string; workId: string; creatorId: string;
  expected: { mimeType: string; byteLength: number; checksum?: string }; requestHash: string;
  expiresAt: string; object: StoredObject; provider?: UploadInitiation; completion?: Completion;
  phase: 'prepared' | 'issued' | 'completed' | 'closing' | 'sealed' | 'retained'; assetId: string; completedObject?: StoredObject;
  queueState: 'pending' | 'queued' | 'none'; jobId?: string; correlationId?: string;
  accounting?:{key:string;state:'pending'|'reserved'}; closingAt?:string; seal?:UploadSealResult;
  usageIntentId?:string; closureIntentId?:string;
}
export interface UploadAccounting {quota:UsageQuotaPort;usageOutbox:UsageSettlementOutbox;closureOutbox:StorageClosureOutbox}
export class UploadLifecycle {
  private readonly records: NonNullable<UbeeqRepositories['hostRecords']>;
  constructor(private readonly repositories: UbeeqRepositories, private readonly uploads: UploadAdapter & Partial<UploadContentAdapter>, private readonly jobs: JobQueue,
    private readonly instanceId: string, private readonly cellId: string, private readonly publicBaseUrl: string, private readonly accounting?:UploadAccounting) {
    if (!repositories.hostRecords) throw new Error('Durable upload records are required.');
    if(accounting && (!uploads.seal || !accounting.quota.closeStorageReservation))throw new Error('Physical upload closure and terminal storage reservations are required.');
    this.records = repositories.hostRecords;
  }
  private id(uploadId: string) { return `upload-${hash([this.instanceId,namespace,uploadId])}`; }
  private value(row: HostRecord): UploadIntent {
    const value = row.value as unknown as UploadIntent;
    if (row.id !== this.id(value?.uploadId) || row.namespace !== namespace || row.instanceId !== this.instanceId || row.homeCellId !== this.cellId || row.scopeId !== value.creatorId || row.key !== value.uploadId
      || value.schemaVersion !== 1 || value.assetId !== `asset-${hash([this.instanceId,value.uploadId])}` || !['prepared','issued','completed','closing','sealed','retained'].includes(value.phase)
      || !['pending','queued','none'].includes(value.queueState) || !instant(value.expiresAt)
      || value.requestHash !== hash([value.workId,value.creatorId,value.expected]) || ['issued','completed','retained'].includes(value.phase) && !value.provider
      || ['completed','retained'].includes(value.phase) && !value.completedObject
      || value.accounting && (value.accounting.key!==this.usageKey(value.uploadId) || !['pending','reserved'].includes(value.accounting.state))
      || value.accounting && value.provider && value.accounting.state!=='reserved'
      || value.queueState==='none' && !['sealed','retained'].includes(value.phase)
      || ['closing','sealed','retained'].includes(value.phase) && (!value.accounting || !instant(value.closingAt!))
      || value.phase==='sealed' && value.seal?.state!=='sealed') throw new Error('Invalid upload lifecycle evidence.');
    requireCreatorScopedObject(value.object.key,{cellId:this.cellId,creatorId:value.creatorId});
    return value;
  }
  private usageKey(uploadId:string){return 'upload-original:'+hash([this.instanceId,uploadId]);}
  private open(value:UploadIntent):void{
    if(value.phase==='sealed')throw new UploadLifecycleError('upload_closed',409,'That upload was closed before any data was saved. Retry the file.');
    if(value.phase==='closing')throw new UploadLifecycleError('upload_recovery_pending',409,'This upload is being recovered. Retry shortly.');
    if(value.phase==='retained')throw new UploadLifecycleError('upload_retained',409,'Your original is saved. Contact support to recover it.');
    if(this.accounting && !value.accounting && value.phase!=='completed')throw new UploadLifecycleError('upload_previous_writer_required',409,'This earlier upload needs recovery before it can continue. Contact support.');
  }
  private async reserve(row:HostRecord):Promise<HostRecord>{
    let value=this.value(row);this.open(value);
    if(!this.accounting || value.phase==='completed' || value.accounting?.state==='reserved')return row;
    const result=await this.accounting.quota.checkAndReserveQuota({creatorId:value.creatorId,operation:'upload.original',idempotencyKey:value.accounting!.key,storageBytesDelta:value.expected.byteLength});
    if(!result.allowed)throw new UploadLifecycleError(result.reasonCode??'upload_quota_denied',403,'This upload exceeds the current storage allowance or is no longer available.');
    for(let attempt=0;attempt<5;attempt++){
      row=await this.read(value.uploadId);const current=this.value(row);this.open(current);value=current;
      if(current.accounting?.state==='reserved')return row;
      try{return await this.records.update(row.id,row.revision,{value:{...row.value,accounting:{...value.accounting,state:'reserved'}}});}
      catch(error){if(!conflict(error) || attempt===4)throw error;}
    }
    throw new Error('Upload reservation acknowledgement requires reconciliation.');
  }
  private async read(uploadId: string, work?: WorkRecord): Promise<HostRecord> {
    const row = await this.records.get(this.id(uploadId));
    if (!row) throw new UploadLifecycleError('upload_not_found',404,'Upload session was not found.');
    const value = this.value(row);
    if (work && (value.workId !== work.id || value.creatorId !== work.creatorId || work.instanceId !== this.instanceId || work.homeCellId !== this.cellId)) throw new UploadLifecycleError('upload_scope_conflict',409,'Upload belongs to a different Work or Creator.');
    return row;
  }
  private response(value: UploadIntent): UploadInitiation & {completed:boolean} {
    this.open(value);
    if (!value.provider) throw new UploadLifecycleError('upload_not_issued',409,'Upload initiation is not complete. Retry the same request.');
    return {...value.provider,completed:value.phase==='completed',uploadId:value.uploadId,completeUrl:`${this.publicBaseUrl.replace(/\/$/,'')}/v1/uploads/${value.uploadId}/complete`};
  }
  async initiate(work: WorkRecord, actorId: string, expected: UploadIntent['expected'], idempotencyKey?: string): Promise<UploadInitiation & {completed:boolean}> {
    if (!actorId || work.instanceId !== this.instanceId || work.homeCellId !== this.cellId || work.status === 'deleted') throw new UploadLifecycleError('upload_access_denied',403,'Current Work access is required.');
    if (!expected.mimeType?.trim() || !Number.isSafeInteger(expected.byteLength) || expected.byteLength < 0 || expected.checksum !== undefined && !/^[a-f0-9]{64}$/.test(expected.checksum)
      || idempotencyKey !== undefined && (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(idempotencyKey))) throw new UploadLifecycleError('invalid_upload',400,'Upload type, size, checksum or request identity is invalid.');
    const uploadId = idempotencyKey ? hash([this.instanceId,work.creatorId,idempotencyKey]) : randomUUID(), requestHash = hash([work.id,work.creatorId,expected]);
    let row = await this.records.get(this.id(uploadId));
    if (!row) {
      const value: UploadIntent = {schemaVersion:1,uploadId,actorId,workId:work.id,creatorId:work.creatorId,expected:{...expected},requestHash,
        expiresAt:new Date(Date.now()+15*60_000).toISOString(),object:{bucket:this.cellId,key:cellScopedObjectKey({cellId:this.cellId,creatorId:work.creatorId,kind:'uploads',objectId:uploadId}),contentType:expected.mimeType,byteLength:expected.byteLength,...(expected.checksum ? {checksum:expected.checksum} : {}),scope:'private'},
        phase:'prepared',assetId:`asset-${hash([this.instanceId,uploadId])}`,queueState:'pending',...(this.accounting ? {accounting:{key:this.usageKey(uploadId),state:'pending' as const}} : {})};
      try { row = await this.records.create({id:this.id(uploadId),instanceId:this.instanceId,namespace,scopeId:work.creatorId,key:uploadId,homeCellId:work.homeCellId,dataHomeRegion:work.dataHomeRegion,dataHomeAssignedAt:work.dataHomeAssignedAt,routingRevision:work.routingRevision,value:value as unknown as Record<string,unknown>}); }
      catch (error) { row = await this.records.get(this.id(uploadId)); if (!row) throw error; }
    }
    let value = this.value(row);
    if (value.requestHash !== requestHash || value.actorId !== actorId) throw new UploadLifecycleError('upload_idempotency_conflict',409,'Upload request identity already belongs to different input.');
    if(this.accounting && value.accounting && (value.phase==='closing' || ['prepared','issued'].includes(value.phase) && Date.parse(value.expiresAt)<=Date.now())){await this.recoverExpired(row);row=await this.read(uploadId,work);value=this.value(row);}
    row=await this.reserve(row);value=this.value(row);
    if(this.accounting && value.accounting && value.phase!=='completed' && this.accounting.quota.checkCurrentAdmission){
      const decision=await this.accounting.quota.checkCurrentAdmission({creatorId:value.creatorId,operation:'upload.original',idempotencyKey:value.accounting.key});
      if(!decision.allowed){await this.recoverExpired(row,true);throw new UploadLifecycleError(decision.reasonCode??'upload_quota_denied',403,'This upload is no longer allowed by the current storage policy.');}
    }
    if (value.provider) return this.response(value);
    const provider = await this.uploads.initiate({object:structuredClone(value.object),checksumAlgorithm:'sha256',expiresAt:value.expiresAt,idempotencyKey:uploadId});
    if (!provider.uploadId || provider.expiresAt !== value.expiresAt || provider.object.scope !== 'private' || provider.object.key !== value.object.key || provider.object.byteLength !== value.expected.byteLength || provider.object.contentType !== value.expected.mimeType || provider.object.checksum !== value.expected.checksum) throw new Error('Provider upload initiation differs from the owned request.');
    for (let attempt=0;attempt<5;attempt++) {
      row = await this.read(uploadId,work); value = this.value(row);
      this.open(value);
      if (value.provider) return this.response(value);
      try { const saved = await this.records.update(row.id,row.revision,{value:{...row.value,provider,phase:'issued'}}); return this.response(this.value(saved)); }
      catch (error) { const saved = this.value(await this.read(uploadId,work)); if (saved.provider) return this.response(saved); if (!conflict(error) || attempt===4) throw error; }
    }
    throw new Error('Upload initiation contention.');
  }
  async accept(uploadId: string, creatorId: string, body: Uint8Array): Promise<void> {
    const value = this.value(await this.read(uploadId));
    if(value.creatorId!==creatorId)throw new UploadLifecycleError('upload_scope_conflict',409,'Upload is not writable by this Creator.');
    this.open(value);
    if (value.creatorId !== creatorId || value.phase === 'prepared' || !value.provider) throw new UploadLifecycleError('upload_scope_conflict',409,'Upload is not writable by this Creator.');
    const checksum=value.completion?.checksum ?? value.expected.checksum;
    if (body.byteLength!==value.expected.byteLength || checksum && createHash('sha256').update(body).digest('hex')!==checksum) throw new UploadLifecycleError('upload_content_conflict',400,'Upload content differs from the requested bytes.');
    if (value.phase==='completed') return;
    if (!this.uploads.accept) throw new UploadLifecycleError('direct_upload_required',405,'Upload content must be sent to the issued direct-upload URL.');
    await this.uploads.accept({uploadId:value.provider.uploadId,cellId:this.cellId,creatorId,body,operation:'upload_content'});
  }
  private proveObject(value: UploadIntent, object: StoredObject): void {
    const completion=value.completion; if(!completion)throw new Error('Completion intent is required.');
    if (!object.versionId || object.key !== value.provider!.object.key || object.bucket !== value.provider!.object.bucket || object.scope !== 'private' || object.contentType !== value.expected.mimeType || object.checksum !== completion.checksum || object.byteLength !== completion.byteLength) throw new Error('Completed object differs from the owned upload.');
    requireCreatorScopedObject(object.key,{cellId:this.cellId,creatorId:value.creatorId});
    if(this.accounting && value.accounting && !instant(object.writtenAt!))throw new Error('A trusted physical write time is required for storage settlement.');
  }
  async complete(uploadId: string, work: WorkRecord, actorId: string, input: Completion, correlationId?: string): Promise<{asset:AssetRecord;job:DurableJob | null;queuePending:boolean}> {
    return this.completeOwned(uploadId,work,actorId,input,correlationId);
  }
  private async completeOwned(uploadId: string, work: WorkRecord, actorId: string, input: Completion, correlationId?: string, recoveredObject?:StoredObject): Promise<{asset:AssetRecord;job:DurableJob | null;queuePending:boolean}> {
    if (!/^[a-f0-9]{64}$/.test(input.checksum) || !Number.isSafeInteger(input.byteLength) || input.byteLength<0) throw new UploadLifecycleError('invalid_upload_completion',400,'An exact checksum and byte length are required.');
    let row = await this.read(uploadId,work), value = this.value(row);
    if(!recoveredObject)this.open(value);
    if(this.accounting && value.accounting && value.accounting.state!=='reserved')throw new Error('Owned upload storage reservation requires reconciliation.');
    if (!value.provider) throw new UploadLifecycleError('upload_not_issued',409,'Upload initiation must finish first.');
    if (input.byteLength !== value.expected.byteLength || value.expected.checksum && input.checksum !== value.expected.checksum) throw new UploadLifecycleError('upload_completion_conflict',409,'Upload completion differs from its requested size or checksum.');
    for (let attempt=0;!value.completion && attempt<5;attempt++) {
      if(!recoveredObject)this.open(value);
      try { row = await this.records.update(row.id,row.revision,{value:{...row.value,completion:{...input}}}); }
      catch (error) {
        const latest=await this.read(uploadId,work);
        if (!this.value(latest).completion && (!conflict(error) || attempt===4)) throw error;
        row=latest;
      }
      value = this.value(row);
    }
    if (!value.completion) throw new Error('Upload completion intent was not persisted.');
    if (hash(value.completion) !== hash(input)) throw new UploadLifecycleError('upload_completion_conflict',409,'A different completion is already recorded.');
    if (!value.provider) throw new UploadLifecycleError('upload_not_issued',409,'Upload initiation must finish first.');
    if (value.phase !== 'completed') {
      const completion = {uploadId:value.provider.uploadId,cellId:this.cellId,creatorId:value.creatorId,...input};
      let object = recoveredObject ?? await this.uploads.recoverCompletion?.(completion);
      if (!object) try { object = await this.uploads.complete(completion); }
      catch (error) { object = await this.uploads.recoverCompletion?.(completion); if (!object) throw error; }
      this.proveObject(value,object);
      for (let attempt=0;attempt<5;attempt++) {
        try { await this.repositories.transaction(async transaction => {
          const current = await this.records.get(row.id,{transaction}); if (!current) throw new Error('Upload lifecycle record disappeared.');
          const saved = this.value(current); if (saved.phase === 'completed') return;
          if(!recoveredObject)this.open(saved);
          else if(saved.phase!=='closing')throw new Error('Recovered upload state requires reconciliation.');
          if (hash(saved.completion)!==hash(input)) throw new Error('Completion intent changed.');
          const currentWork = await this.repositories.works.get(work.id,{transaction});
          if (!currentWork || currentWork.instanceId !== this.instanceId || currentWork.creatorId !== value.creatorId || currentWork.status === 'deleted' || !this.repositories.works.checkRevision) throw new UploadLifecycleError('upload_work_unavailable',409,'The upload Work is no longer writable.');
          await this.repositories.works.checkRevision(currentWork.id,currentWork.revision,{transaction});
          const home = {homeCellId:current.homeCellId,dataHomeRegion:current.dataHomeRegion,dataHomeAssignedAt:current.dataHomeAssignedAt,routingRevision:current.routingRevision};
          await this.repositories.assets.create({id:saved.assetId,instanceId:this.instanceId,...home,creatorId:value.creatorId,workId:work.id,mimeType:object!.contentType,checksum:object!.checksum!,objectVersion:object!.versionId!,status:'pending',storage:object,uploadId} as AssetRecord & {storage:StoredObject;uploadId:string},{transaction});
          await this.repositories.moderationEvidence.create({id:`upload-evidence-${uploadId}`,instanceId:this.instanceId,...home,subjectType:'asset',subjectId:saved.assetId,source:'reference.upload',payload:{checksum:object!.checksum,byteLength:object!.byteLength}},{transaction});
          await this.repositories.auditEvents.create({id:`upload-audit-${uploadId}`,instanceId:this.instanceId,...home,action:'asset.upload_completed',actorId,subjectId:saved.assetId,payload:{workId:work.id,uploadId}},{transaction});
          const usageIntent=this.accounting && saved.accounting ? await this.accounting.usageOutbox.enqueue({creatorId:saved.creatorId,operation:'upload.original',idempotencyKey:saved.accounting.key,storageBytesDelta:object!.byteLength,observedAt:object!.writtenAt!},home,transaction) : undefined;
          await this.records.update(current.id,current.revision,{value:{...current.value,completedObject:object,phase:'completed',completedAt:new Date().toISOString(),...(usageIntent ? {usageIntentId:usageIntent.id} : {}),...(correlationId ? {correlationId} : {})}},{transaction});
        }); break; }
        catch (error) { row = await this.read(uploadId,work); if (this.value(row).phase==='completed') break; if (!conflict(error) || attempt===4) throw error; }
      }
    }
    row = await this.read(uploadId,work); value = this.value(row);
    if(this.accounting && value.usageIntentId){
      const intent=await this.records.get(value.usageIntentId);
      if(!intent || intent.scopeId!==value.creatorId || (intent.value.input as {idempotencyKey?:string})?.idempotencyKey!==value.accounting?.key)throw new Error('Upload storage settlement intent requires reconciliation.');
      try{await this.accounting.usageOutbox.deliver(intent);}catch{/* The owned physical effect and settlement intent remain durable. */}
    }
    const asset = await this.repositories.assets.get(value.assetId);
    if (!asset || asset.instanceId !== this.instanceId || asset.creatorId !== value.creatorId || asset.workId !== value.workId || asset.homeCellId !== this.cellId || asset.objectVersion !== value.completedObject!.versionId) throw new Error('Completed upload asset requires reconciliation.');
    let job:DurableJob | null = null;
    try { job = await this.ensureQueue(row); } catch { /* The committed pending intent is independently recoverable. */ }
    return {asset,job,queuePending:!job && value.queueState!=='queued'};
  }
  private async recoverExpired(initial:HostRecord,force=false):Promise<void>{
    if(!this.accounting)return;
    let row=initial,value=this.value(row);
    for(let attempt=0;attempt<5;attempt++){
      if(!value.accounting || ['completed','sealed','retained'].includes(value.phase))return;
      if(value.phase==='closing')break;
      if(!force && Date.parse(value.expiresAt)>Date.now())return;
      try{row=await this.records.update(row.id,row.revision,{value:{...row.value,phase:'closing',closingAt:new Date().toISOString()}});value=this.value(row);break;}
      catch(error){row=await this.read(value.uploadId);value=this.value(row);if(!conflict(error) || attempt===4)throw error;}
    }
    if(value.phase!=='closing')return;
    const seal:UploadSealResult=value.provider ? await this.uploads.seal!({uploadId:value.provider.uploadId,cellId:this.cellId,creatorId:value.creatorId})
      : {state:'sealed',proofId:hash([row.id,'never-issued',value.closingAt]),closedAt:value.closingAt!};
    if(seal.state==='completed'){
      const object=seal.object,completion={checksum:object.checksum!,byteLength:object.byteLength};
      if(!/^[a-f0-9]{64}$/.test(completion.checksum) || value.expected.checksum && value.expected.checksum!==completion.checksum)throw new Error('Recovered original checksum requires reconciliation.');
      this.proveObject({...value,completion},object);
      const work=await this.repositories.works.get(value.workId);
      if(work && work.instanceId===this.instanceId && work.creatorId===value.creatorId && work.status!=='deleted' && (!value.completion || hash(value.completion)===hash(completion))){
        try{await this.completeOwned(value.uploadId,work,value.actorId,completion,value.correlationId,object);return;}
        catch(error){if(!(error instanceof UploadLifecycleError) || error.code!=='upload_work_unavailable')throw error;}
      }
      // A disappeared/deleted Work or conflicting completion does not erase
      // accepted bytes or their charge. Retain the original for reconciliation.
      for(let attempt=0;attempt<5;attempt++){
        try{await this.repositories.transaction(async transaction=>{
          const current=await this.records.get(row.id,{transaction});if(!current)throw new Error('Upload disappeared.');
          const saved=this.value(current);if(['completed','retained'].includes(saved.phase))return;
          if(saved.phase!=='closing')throw new Error('Retained upload state conflicts.');
          const intent=await this.accounting!.usageOutbox.enqueue({creatorId:saved.creatorId,operation:'upload.original',idempotencyKey:saved.accounting!.key,storageBytesDelta:object.byteLength,observedAt:object.writtenAt!},current,transaction);
          await this.records.update(current.id,current.revision,{value:{...current.value,phase:'retained',queueState:'none',completedObject:object,seal,usageIntentId:intent.id}},{transaction});
        });break;}
        catch(error){if(!conflict(error) || attempt===4)throw error;}
      }
      return;
    }
    if(typeof seal.proofId!=='string' || !seal.proofId.trim() || seal.proofId.length>200 || !instant(seal.closedAt))throw new Error('Trusted upload closure proof is required.');
    if(seal.retainedFence && (!value.provider || seal.retainedFence.bucket!==value.provider.object.bucket || seal.retainedFence.key!==value.provider.object.key || !seal.retainedFence.versionId || seal.retainedFence.byteLength!==0 || seal.retainedFence.scope!=='private' || seal.retainedFence.writtenAt!==seal.closedAt))throw new Error('Retained upload fence requires reconciliation.');
    for(let attempt=0;attempt<5;attempt++){
      try{await this.repositories.transaction(async transaction=>{
        const current=await this.records.get(row.id,{transaction});if(!current)throw new Error('Upload disappeared.');
        const saved=this.value(current);if(saved.phase==='sealed')return;
        if(saved.phase!=='closing')throw new Error('Upload closure state conflicts.');
        const intent=await this.accounting!.closureOutbox.enqueue({creatorId:saved.creatorId,operation:'upload.original',idempotencyKey:saved.accounting!.key,reservedBytes:saved.expected.byteLength,proofId:seal.proofId,observedAt:seal.closedAt},current,transaction);
        await this.records.update(current.id,current.revision,{value:{...current.value,phase:'sealed',queueState:'none',seal,closureIntentId:intent.id}},{transaction});
      });break;}
      catch(error){if(!conflict(error) || attempt===4)throw error;}
    }
    const saved=this.value(await this.read(value.uploadId)),intent=saved.closureIntentId ? await this.records.get(saved.closureIntentId) : undefined;
    if(!intent || intent.scopeId!==value.creatorId || (intent.value.input as {idempotencyKey?:string})?.idempotencyKey!==value.accounting!.key)throw new Error('Upload closure intent requires reconciliation.');
    try{await this.accounting.closureOutbox.deliver(intent);}catch{/* Retry the durable proof; never infer a released reservation. */}
  }
  private proveJob(value:UploadIntent,job:DurableJob):void {
    if (!job.id || job.cellId!==this.cellId || job.type!=='asset.process' || (job.payload as {assetId?:string})?.assetId!==value.assetId || job.idempotencyKey!==`asset-process:${value.assetId}:${value.completedObject!.versionId}`) throw new Error('Upload processing acknowledgement conflicts.');
  }
  private async ensureQueue(row: HostRecord): Promise<DurableJob | null> {
    const value = this.value(row);
    if (value.phase!=='completed') return null;
    if (value.queueState==='queued') { const job=value.jobId ? await this.jobs.get(value.jobId) : undefined; if(job)this.proveJob(value,job); return job??null; }
    const asset = await this.repositories.assets.get(value.assetId);
    if (!asset || asset.instanceId !== this.instanceId || asset.creatorId !== value.creatorId || asset.homeCellId !== this.cellId) throw new Error('Upload processing intent requires its owned asset.');
    const job = await this.jobs.enqueue({cellId:this.cellId,type:'asset.process',payload:{assetId:asset.id},idempotencyKey:`asset-process:${asset.id}:${asset.objectVersion}`,maxAttempts:3,...(value.correlationId ? {correlationId:value.correlationId} : {})});
    this.proveJob(value,job);
    for (let attempt=0;attempt<5;attempt++) {
      const current = await this.read(value.uploadId), saved = this.value(current);
      if (saved.queueState==='queued') { if (saved.jobId!==job.id) throw new Error('Upload processing receipt conflicts.'); return job; }
      try { await this.records.update(current.id,current.revision,{value:{...current.value,queueState:'queued',jobId:job.id}}); return job; }
      catch (error) { if (!conflict(error) || attempt===4) { const latest=this.value(await this.read(value.uploadId)); if(latest.queueState==='queued'&&latest.jobId===job.id)return job; throw error; } }
    }
    throw new Error('Upload queue receipt contention.');
  }
  async repair(limit=25): Promise<number> {
    let count=0, failure:unknown;
    for await (const row of repositoryItems(request=>this.records.list(request))) {
      if (row.instanceId!==this.instanceId || row.homeCellId!==this.cellId || row.namespace!==namespace) continue;
      const needsQueue=row.value.phase==='completed' && row.value.queueState==='pending';
      const needsClosure=this.accounting && row.value.accounting && (row.value.phase==='closing' || ['prepared','issued'].includes(row.value.phase as string) && Date.parse(row.value.expiresAt as string)<=Date.now());
      if(!needsQueue && !needsClosure)continue;
      try { if(needsClosure)await this.recoverExpired(row);else await this.ensureQueue(row); } catch(error) { failure ??= error; }
      if (++count>=limit) break;
    }
    if(this.accounting)try{await this.accounting.closureOutbox.drain(limit);}catch(error){failure??=error;}
    if (failure) throw failure;
    return count;
  }
}
