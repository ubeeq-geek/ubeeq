import { createHash, randomUUID } from 'node:crypto';
import { repositoryItems, type AssetRecord, type HostRecord, type UbeeqRepositories, type WorkRecord } from '@ubeeq/persistence';
import { cellScopedObjectKey, requireCreatorScopedObject, type StoredObject, type UploadAdapter, type UploadContentAdapter, type UploadInitiation } from '@ubeeq/storage';
import type { DurableJob, JobQueue } from '@ubeeq/jobs';

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
  phase: 'prepared' | 'issued' | 'completed'; assetId: string; completedObject?: StoredObject;
  queueState: 'pending' | 'queued'; jobId?: string;
}
export class UploadLifecycle {
  private readonly records: NonNullable<UbeeqRepositories['hostRecords']>;
  constructor(private readonly repositories: UbeeqRepositories, private readonly uploads: UploadAdapter & Partial<UploadContentAdapter>, private readonly jobs: JobQueue,
    private readonly instanceId: string, private readonly cellId: string, private readonly publicBaseUrl: string) {
    if (!repositories.hostRecords) throw new Error('Durable upload records are required.');
    this.records = repositories.hostRecords;
  }
  private id(uploadId: string) { return `upload-${hash([this.instanceId,namespace,uploadId])}`; }
  private value(row: HostRecord): UploadIntent {
    const value = row.value as unknown as UploadIntent;
    if (row.id !== this.id(value?.uploadId) || row.namespace !== namespace || row.instanceId !== this.instanceId || row.homeCellId !== this.cellId || row.scopeId !== value.creatorId || row.key !== value.uploadId
      || value.schemaVersion !== 1 || value.assetId !== `asset-${hash([this.instanceId,value.uploadId])}` || !['prepared','issued','completed'].includes(value.phase)
      || !['pending','queued'].includes(value.queueState) || !instant(value.expiresAt)
      || value.requestHash !== hash([value.workId,value.creatorId,value.expected]) || value.phase !== 'prepared' && !value.provider
      || value.phase === 'completed' && !value.completedObject) throw new Error('Invalid upload lifecycle evidence.');
    requireCreatorScopedObject(value.object.key,{cellId:this.cellId,creatorId:value.creatorId});
    return value;
  }
  private async read(uploadId: string, work?: WorkRecord): Promise<HostRecord> {
    const row = await this.records.get(this.id(uploadId));
    if (!row) throw new UploadLifecycleError('upload_not_found',404,'Upload session was not found.');
    const value = this.value(row);
    if (work && (value.workId !== work.id || value.creatorId !== work.creatorId || work.instanceId !== this.instanceId || work.homeCellId !== this.cellId)) throw new UploadLifecycleError('upload_scope_conflict',409,'Upload belongs to a different Work or Creator.');
    return row;
  }
  private response(value: UploadIntent): UploadInitiation & {completed:boolean} {
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
        phase:'prepared',assetId:`asset-${hash([this.instanceId,uploadId])}`,queueState:'pending'};
      try { row = await this.records.create({id:this.id(uploadId),instanceId:this.instanceId,namespace,scopeId:work.creatorId,key:uploadId,homeCellId:work.homeCellId,dataHomeRegion:work.dataHomeRegion,dataHomeAssignedAt:work.dataHomeAssignedAt,routingRevision:work.routingRevision,value:value as unknown as Record<string,unknown>}); }
      catch (error) { row = await this.records.get(this.id(uploadId)); if (!row) throw error; }
    }
    let value = this.value(row);
    if (value.requestHash !== requestHash || value.actorId !== actorId) throw new UploadLifecycleError('upload_idempotency_conflict',409,'Upload request identity already belongs to different input.');
    if (value.provider) return this.response(value);
    const provider = await this.uploads.initiate({object:structuredClone(value.object),checksumAlgorithm:'sha256',expiresAt:value.expiresAt,idempotencyKey:uploadId});
    if (!provider.uploadId || provider.expiresAt !== value.expiresAt || provider.object.scope !== 'private' || provider.object.key !== value.object.key || provider.object.byteLength !== value.expected.byteLength || provider.object.contentType !== value.expected.mimeType || provider.object.checksum !== value.expected.checksum) throw new Error('Provider upload initiation differs from the owned request.');
    for (let attempt=0;attempt<5;attempt++) {
      row = await this.read(uploadId,work); value = this.value(row);
      if (value.provider) return this.response(value);
      try { const saved = await this.records.update(row.id,row.revision,{value:{...row.value,provider,phase:'issued'}}); return this.response(this.value(saved)); }
      catch (error) { const saved = this.value(await this.read(uploadId,work)); if (saved.provider) return this.response(saved); if (!conflict(error) || attempt===4) throw error; }
    }
    throw new Error('Upload initiation contention.');
  }
  async accept(uploadId: string, creatorId: string, body: Uint8Array): Promise<void> {
    const value = this.value(await this.read(uploadId));
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
  }
  async complete(uploadId: string, work: WorkRecord, actorId: string, input: Completion): Promise<{asset:AssetRecord;job:DurableJob | null;queuePending:boolean}> {
    if (!/^[a-f0-9]{64}$/.test(input.checksum) || !Number.isSafeInteger(input.byteLength) || input.byteLength<0) throw new UploadLifecycleError('invalid_upload_completion',400,'An exact checksum and byte length are required.');
    let row = await this.read(uploadId,work), value = this.value(row);
    if (!value.provider) throw new UploadLifecycleError('upload_not_issued',409,'Upload initiation must finish first.');
    if (input.byteLength !== value.expected.byteLength || value.expected.checksum && input.checksum !== value.expected.checksum) throw new UploadLifecycleError('upload_completion_conflict',409,'Upload completion differs from its requested size or checksum.');
    for (let attempt=0;!value.completion && attempt<5;attempt++) {
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
      let object = await this.uploads.recoverCompletion?.(completion);
      if (!object) try { object = await this.uploads.complete(completion); }
      catch (error) { object = await this.uploads.recoverCompletion?.(completion); if (!object) throw error; }
      this.proveObject(value,object);
      for (let attempt=0;attempt<5;attempt++) {
        try { await this.repositories.transaction(async transaction => {
          const current = await this.records.get(row.id,{transaction}); if (!current) throw new Error('Upload lifecycle record disappeared.');
          const saved = this.value(current); if (saved.phase === 'completed') return;
          if (hash(saved.completion)!==hash(input)) throw new Error('Completion intent changed.');
          const currentWork = await this.repositories.works.get(work.id,{transaction});
          if (!currentWork || currentWork.instanceId !== this.instanceId || currentWork.creatorId !== value.creatorId || currentWork.status === 'deleted' || !this.repositories.works.checkRevision) throw new UploadLifecycleError('upload_work_unavailable',409,'The upload Work is no longer writable.');
          await this.repositories.works.checkRevision(currentWork.id,currentWork.revision,{transaction});
          const home = {homeCellId:current.homeCellId,dataHomeRegion:current.dataHomeRegion,dataHomeAssignedAt:current.dataHomeAssignedAt,routingRevision:current.routingRevision};
          await this.repositories.assets.create({id:saved.assetId,instanceId:this.instanceId,...home,creatorId:value.creatorId,workId:work.id,mimeType:object!.contentType,checksum:object!.checksum!,objectVersion:object!.versionId!,status:'pending',storage:object,uploadId} as AssetRecord & {storage:StoredObject;uploadId:string},{transaction});
          await this.repositories.moderationEvidence.create({id:`upload-evidence-${uploadId}`,instanceId:this.instanceId,...home,subjectType:'asset',subjectId:saved.assetId,source:'reference.upload',payload:{checksum:object!.checksum,byteLength:object!.byteLength}},{transaction});
          await this.repositories.auditEvents.create({id:`upload-audit-${uploadId}`,instanceId:this.instanceId,...home,action:'asset.upload_completed',actorId,subjectId:saved.assetId,payload:{workId:work.id,uploadId}},{transaction});
          await this.records.update(current.id,current.revision,{value:{...current.value,completedObject:object,phase:'completed',completedAt:new Date().toISOString()}},{transaction});
        }); break; }
        catch (error) { row = await this.read(uploadId,work); if (this.value(row).phase==='completed') break; if (!conflict(error) || attempt===4) throw error; }
      }
    }
    row = await this.read(uploadId,work); value = this.value(row);
    const asset = await this.repositories.assets.get(value.assetId);
    if (!asset || asset.instanceId !== this.instanceId || asset.creatorId !== value.creatorId || asset.workId !== value.workId || asset.homeCellId !== this.cellId || asset.objectVersion !== value.completedObject!.versionId) throw new Error('Completed upload asset requires reconciliation.');
    let job:DurableJob | null = null;
    try { job = await this.ensureQueue(row); } catch { /* The committed pending intent is independently recoverable. */ }
    return {asset,job,queuePending:!job && value.queueState!=='queued'};
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
    const job = await this.jobs.enqueue({cellId:this.cellId,type:'asset.process',payload:{assetId:asset.id},idempotencyKey:`asset-process:${asset.id}:${asset.objectVersion}`,maxAttempts:3});
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
      if (row.instanceId!==this.instanceId || row.homeCellId!==this.cellId || row.namespace!==namespace || row.value.phase!=='completed' || row.value.queueState!=='pending') continue;
      try { await this.ensureQueue(row); } catch(error) { failure ??= error; }
      if (++count>=limit) break;
    }
    if (failure) throw failure;
    return count;
  }
}
