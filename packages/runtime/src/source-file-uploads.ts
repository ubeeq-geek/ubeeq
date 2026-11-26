import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {setTimeout as delay} from 'node:timers/promises';
import {OptimisticConcurrencyError,UniqueConstraintError,withRepositoryRead,repositoryItems,type CellOwnedRecord,type HostRecord,type PersistenceTransaction,type RetainedCreatorContentModels,type UbeeqRepositories} from '@ubeeq/persistence';
import {cellScopedObjectKey,requireCreatorScopedObject,writeBoundedUploadStream,ownedVersionFingerprint,validateOwnedVersionAbsence,type OwnedVersionRemovalAdapter,type OwnedVersionRemovalRequest,type OwnedVersionAbsenceProof,type StoredObject,type UploadAdapter,type UploadContentStreamAdapter,type UploadContentAdapter,type UploadInitiation,type UploadSealResult} from '@ubeeq/storage';
import type {UsageQuotaPort} from '@ubeeq/extension-sdk';
import {RepositoryRetainedSourceFiles,SourceFileConflict,type RetainedSourceFile,type SourceFileAudit} from './retained-source-files.js';
import {RetainedRepositoryError} from './retained-repository-store.js';
import {ownedEvidenceHash} from './owned-object-writes.js';
import {UsageSettlementOutbox} from './usage-settlement-outbox.js';
import {StorageClosureOutbox} from './storage-closure-outbox.js';
import {sourceCompletionAttempt,endSourceCompletionAttempt,sourceCompletionPreparation,hasRetiredOwnedError,consumeRetiredOwnedError} from './source-completion-observation.js';

const namespace='runtime-source-file-upload';
const winnerObservationMilliseconds=5_000,winnerObservationIntervalMilliseconds=25;
const winnerReadChanged=Symbol('actual Source winner read changed');
const instant=(value:unknown):value is string=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const same=(a:unknown,b:unknown)=>ownedEvidenceHash(a)===ownedEvidenceHash(b);
const conflict=(error:unknown)=>error instanceof SourceFileConflict||error instanceof SourceFileUploadError&&error.code==='upload_source_conflict'||error instanceof Error&&['OptimisticConcurrencyError','UniqueConstraintError','ConditionalCheckFailedException','TransactionCanceledException'].includes(error.name);
const denied=(error:unknown)=>error instanceof RetainedRepositoryError&&error.code==='access_denied';
/** Whole-command retry is narrower than the inner finalization reconciliation:
 * real repository collisions, or an explicitly condition-only Dynamo cancel. */
const completionRepositoryConflict=(error:unknown):boolean=>{
  if(error instanceof OptimisticConcurrencyError||error instanceof UniqueConstraintError)return true;
  if(!(error instanceof Error)||error.name!=='TransactionCanceledException')return false;
  const reasons:unknown=Object.getOwnPropertyDescriptor(error,'CancellationReasons')?.value;
  if(!Array.isArray(reasons)||!reasons.length||reasons.length>100)return false;
  let conditional=false;
  for(let index=0;index<reasons.length;index++){
    const reason:unknown=reasons[index];if(!reason||typeof reason!=='object'||Array.isArray(reason))return false;
    const code:unknown=Object.getOwnPropertyDescriptor(reason,'Code')?.value;
    if(code==='ConditionalCheckFailed')conditional=true;else if(code!=='None')return false;
  }
  return conditional;
};

/** Server-owned placement for NEW originals. Legacy keys are never rewritten. */
export function sourceFileOriginalCreatorPrefix(input:{instanceId:string;cellId:string;creatorId:string}):string{
  if(typeof input.instanceId!=='string'||!input.instanceId.trim()||input.instanceId.length>200)throw Error('A fixed original instance identity is required.');
  const base=cellScopedObjectKey({cellId:input.cellId,creatorId:input.creatorId,kind:'originals',objectId:'prefix'}).slice(0,-'prefix'.length);
  return `${base}instance-${ownedEvidenceHash([input.instanceId])}/`;
}
export function sourceFileOriginalObjectKey(input:{instanceId:string;cellId:string;creatorId:string;fileId:string}):string{
  if(typeof input.fileId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(input.fileId))throw new SourceFileUploadError('invalid_file_id',400,'The original file identity is invalid.');
  return `${sourceFileOriginalCreatorPrefix(input)}${input.fileId}/source`;
}
export class SourceFileUploadError extends Error {
  constructor(readonly code:string,readonly status:number,message:string){super(message);this.name='SourceFileUploadError';}
}
interface Session {
  schemaVersion:1;fileId:string;creatorId:string;actorId:string;createdAt:string;expiresAt:string;requestHash:string;
  object:StoredObject;phase:'prepared'|'issued'|'closing'|'sealed'|'retained'|'completed';reservation:'pending'|'reserved';
  provider?:UploadInitiation;closingAt?:string;completedObject?:StoredObject;seal?:UploadSealResult;
  usageIntentId?:string;closureIntentId?:string;
  removal?:{schemaVersion:1;targetFingerprint:string;requestedAt:string;cancellation:{requestedAt:string;requestedByUserId:string};request:OwnedVersionRemovalRequest;proof?:OwnedVersionAbsenceProof;accountedAt?:string};
}
export interface SourceFileCompletionPreparation {
  checksumSha256:string;sizeBytes:number;metadata?:RetainedSourceFile['metadata'];
}
/** Supplied only from the immutable actual upload journal, including repair. */
export interface SourceFileCompletionContext {readonly actorId:string}
export interface SourceFileUploadOptions<M extends RetainedCreatorContentModels,F extends RetainedSourceFile> {
  repositories:UbeeqRepositories;uploads:UploadAdapter&Partial<UploadContentAdapter>&Partial<UploadContentStreamAdapter>;quota:UsageQuotaPort;
  files:RepositoryRetainedSourceFiles<M,F>;
  /** Fixed private provider bucket, never a client-selected bucket. */
  bucket:string;
  /** Actual immutable provider removal capability, not a key-only delete. */
  removal?:OwnedVersionRemovalAdapter;now?:()=>Date;expiresInMilliseconds?:number;
  /** Read/verify the exact original and run the actual type-specific decoder,
   * credentials and idempotent owned rendition path before metadata acceptance.
   * Provider effects happen before the accepting repository transaction. */
  prepareCompletion(file:Readonly<F>,object:Readonly<StoredObject>,context:Readonly<SourceFileCompletionContext>):Promise<SourceFileCompletionPreparation>;
}
export interface SourceFileUploadResult<F extends RetainedSourceFile> {
  file:F;state:'issued'|'sealed'|'retained'|'completed';object?:StoredObject;usagePending:boolean;
}
/** Physical original ownership is independent of Works and attachments. This
 * journal contains immutable upload facts, never another editable SourceFile.
 * The existing SourceFile writer remains the sole metadata/audit authority.
 */
export class SourceFileUploads<M extends RetainedCreatorContentModels=RetainedCreatorContentModels,F extends RetainedSourceFile=RetainedSourceFile> {
  private readonly records:NonNullable<UbeeqRepositories['hostRecords']>;
  private readonly usage:UsageSettlementOutbox;
  private readonly closures:StorageClosureOutbox;
  private readonly now:()=>Date;
  private readonly duration:number;
  private readonly files:RepositoryRetainedSourceFiles<M,F>;
  private readonly instanceId:string;
  private readonly cellId:string;
  constructor(private readonly options:SourceFileUploadOptions<M,F>){
    const {repositories,uploads,quota,files}=options;
    if(!repositories.hostRecords||!uploads.recoverCompletion||!uploads.seal||!quota.closeStorageReservation||!options.bucket?.trim()||typeof options.prepareCompletion!=='function')throw Error('Original uploads require durable physical receipts, sealing, quota closure, a fixed private bucket and actual original finalization.');
    this.files=files;this.instanceId=files.scope.instanceId;this.cellId=files.scope.cellId;this.records=repositories.hostRecords;
    this.usage=new UsageSettlementOutbox(repositories,quota,this.instanceId,this.cellId);
    this.closures=new StorageClosureOutbox(repositories,quota,this.instanceId,this.cellId);
    this.now=options.now??(()=>new Date());this.duration=options.expiresInMilliseconds??15*60_000;
    if(!Number.isSafeInteger(this.duration)||this.duration<1||this.duration>15*60_000)throw Error('Original upload expiry must be bounded to fifteen minutes.');
  }
  get scope(){return Object.freeze({...this.files.scope});}
  private id(fileId:string){return 'source-upload-'+ownedEvidenceHash([this.instanceId,this.cellId,this.files.scope.tenantId,this.files.scope.creatorId,fileId]);}
  private usageKey(row:HostRecord){return 'source-original:'+row.id;}
  private home(row:CellOwnedRecord):CellOwnedRecord{return {homeCellId:row.homeCellId,dataHomeRegion:row.dataHomeRegion,dataHomeAssignedAt:row.dataHomeAssignedAt,routingRevision:row.routingRevision};}
  private key(fileId:string){return sourceFileOriginalObjectKey({...this.files.scope,fileId});}
  private value(row:HostRecord):Session{
    const value=row.value as unknown as Session;
    if(!value||value.schemaVersion!==1||row.namespace!==namespace||row.instanceId!==this.instanceId||row.homeCellId!==this.cellId||row.dataHomeRegion!==this.files.scope.region
      ||value.creatorId!==this.files.scope.creatorId||row.scopeId!==value.creatorId||row.key!==value.fileId||row.id!==this.id(value.fileId)||!value.actorId
      ||!instant(value.createdAt)||!instant(value.expiresAt)||value.expiresAt<=value.createdAt||!['prepared','issued','closing','sealed','retained','completed'].includes(value.phase)||!['pending','reserved'].includes(value.reservation)
      ||!value.object||value.object.bucket!==this.options.bucket||value.object.key!==this.key(value.fileId)||value.object.scope!=='private'||!value.object.contentType?.trim()
      ||!Number.isSafeInteger(value.object.byteLength)||value.object.byteLength<1||!/^[a-f0-9]{64}$/.test(value.object.checksum??'')||value.object.versionId!==undefined||value.object.writtenAt!==undefined
      ||value.requestHash!==ownedEvidenceHash([value.fileId,value.creatorId,value.actorId,value.object])
      ||value.provider&&value.reservation!=='reserved'||['issued','retained','completed'].includes(value.phase)&&!value.provider
      ||['retained','completed'].includes(value.phase)&&(!value.completedObject||!value.usageIntentId)||value.phase==='sealed'&&!value.closureIntentId||value.phase==='closing'&&!instant(value.closingAt)||value.phase==='sealed'&&value.seal?.state!=='sealed')throw Error('Original upload evidence requires reconciliation.');
    if(value.provider)this.proveProvider(value,value.provider);
    if(value.completedObject)this.proveObject(value,value.completedObject);
    if(value.removal){const removal=value.removal;if(removal.schemaVersion!==1||!instant(removal.requestedAt)||!instant(removal.cancellation?.requestedAt)||!removal.cancellation.requestedByUserId||!value.provider||!value.completedObject||!['completed','retained'].includes(value.phase)||removal.request.cellId!==this.cellId||removal.request.creatorId!==value.creatorId||!same(removal.request.upload,value.provider)||!same(removal.request.object,value.completedObject)||removal.targetFingerprint!==ownedVersionFingerprint(removal.request)||removal.proof&&removal.accountedAt!==undefined&&!instant(removal.accountedAt)||removal.accountedAt&&!removal.proof)throw Error('Original removal evidence requires reconciliation.');if(removal.proof)validateOwnedVersionAbsence(removal.request,removal.proof);}
    requireCreatorScopedObject(value.object.key,{cellId:this.cellId,creatorId:value.creatorId});
    return value;
  }
  private proveProvider(value:Session,provider:UploadInitiation){
    if(!provider.uploadId||provider.expiresAt!==value.expiresAt||provider.parts?.some(part=>part.expiresAt!==value.expiresAt)||!same(provider.object,value.object))throw Error('Original upload provider capability conflicts.');
  }
  private proveObject(value:Session,object:StoredObject){
    const {versionId,writtenAt,...facts}=object;
    if(!value.provider||!versionId||!instant(writtenAt)||!same(facts,value.object))throw Error('Original upload physical receipt conflicts.');
  }
  /** Queue ordinary Local metadata reads behind their real connection owner.
   * A caller's accepting transaction remains explicit; physical IO and quota
   * delivery are never enclosed by this metadata-only read scope. */
  private readRecord(id:string){return withRepositoryRead(this.options.repositories,transaction=>this.records.get(id,{transaction}));}
  private async read(fileId:string,transaction?:PersistenceTransaction):Promise<HostRecord>{
    const row=transaction?await this.records.get(this.id(fileId),{transaction}):await this.readRecord(this.id(fileId));
    if(!row)throw new SourceFileUploadError('upload_not_found',404,'This original has no owned upload session.');
    this.value(row);return row;
  }
  private async file(fileId:string):Promise<F>{
    const file=await this.files.getSourceFileById(fileId);
    if(!file)throw new SourceFileUploadError('file_not_found',404,'Original file was not found.');
    return file;
  }
  private matchFile(value:Session,file:F){
    if(file.fileId!==value.fileId||file.creatorId!==value.creatorId||file.storageKey!==value.object.key||file.mimeType!==value.object.contentType||file.sizeBytes!==value.object.byteLength||file.checksumSha256!==undefined&&file.checksumSha256!==value.object.checksum)throw new SourceFileUploadError('upload_source_conflict',409,'Original upload metadata changed. Reconcile the stored original before continuing.');
  }
  private open(value:Session){
    if(value.phase==='sealed')throw new SourceFileUploadError('upload_closed',409,'This original upload was closed. Prepare a new upload.');
    if(value.phase==='closing')throw new SourceFileUploadError('upload_recovery_pending',409,'This original upload is being recovered. Retry shortly.');
    if(value.phase==='retained')throw new SourceFileUploadError('upload_retained',409,'Original bytes are saved and await authorized recovery.');
  }
  private completion(value:Session){return {uploadId:value.provider!.uploadId,cellId:this.cellId,creatorId:value.creatorId,checksum:value.object.checksum!,byteLength:value.object.byteLength};}
  private async deliver(row:HostRecord):Promise<boolean>{
    const value=this.value(row),id=value.usageIntentId??value.closureIntentId;if(!id)return false;
    const intent=await this.readRecord(id);
    if(!intent||intent.scopeId!==value.creatorId||(intent.value.input as {idempotencyKey?:string})?.idempotencyKey!==this.usageKey(row))throw Error('Original accounting intent requires reconciliation.');
    try{if(value.usageIntentId)await this.usage.deliver(intent);else await this.closures.deliver(intent);return false;}catch{return true;}
  }
  private async result(row:HostRecord):Promise<SourceFileUploadResult<F>>{
    const value=this.value(row);
    if(!['issued','sealed','retained','completed'].includes(value.phase))throw new SourceFileUploadError('upload_recovery_pending',409,'Original upload recovery is pending.');
    return {file:await this.file(value.fileId),state:value.phase as SourceFileUploadResult<F>['state'],...(value.completedObject?{object:structuredClone(value.completedObject)}:{}),usagePending:await this.deliver(row)};
  }
  /** The authoritative pending SourceFile is created by prepareSourceFileIntake.
   * A checksum is required before a browser receives any upload capability. */
  private outsideTransaction(){if(this.files.transaction())throw new SourceFileUploadError('upload_transaction_active',409,'Issue or finalize original uploads only after the metadata transaction has committed.');}
  async initiate(input:{actorId:string;fileId:string;checksumSha256:string}):Promise<SourceFileUploadResult<F>&{upload:UploadInitiation;completed:boolean}>{
    this.outsideTransaction();
    for(let attempt=0;attempt<5;attempt++){try{return await this.initiateOwned(input);}catch(error){if(!conflict(error)||attempt===4)throw error;}}
    throw Error('Original upload initiation requires reconciliation.');
  }
  private async initiateOwned(input:{actorId:string;fileId:string;checksumSha256:string}):Promise<SourceFileUploadResult<F>&{upload:UploadInitiation;completed:boolean}>{
    if(!/^[a-f0-9]{64}$/.test(input.checksumSha256))throw new SourceFileUploadError('upload_checksum_required',400,'Compute the original SHA-256 checksum before starting its upload.');
    let row=await this.files.asActor(input.actorId,async()=>{
      await this.files.captureSourceAccess(input.actorId);
      const file=await this.file(input.fileId),transaction=this.files.transaction()!;
      let row=await this.records.get(this.id(input.fileId),{transaction});
      if(!row){
        if(file.uploadState!=='pending')throw new SourceFileUploadError('upload_not_pending',409,'Only pending originals can begin an upload.');
        if(file.storageKey!==this.key(file.fileId))throw new SourceFileUploadError('upload_legacy_storage',409,'This original requires its existing storage driver. Its stored location has been preserved.');
        const creator=await this.options.repositories.creators.get(file.creatorId,{transaction});if(!creator)throw Error('Original Creator disappeared.');
        const object:StoredObject={bucket:this.options.bucket,key:file.storageKey,contentType:file.mimeType,byteLength:file.sizeBytes!,checksum:input.checksumSha256,scope:'private'};
        const createdAt=this.now().toISOString(),expiresAt=new Date(Date.parse(createdAt)+this.duration).toISOString();
        const value:Session={schemaVersion:1,fileId:file.fileId,creatorId:file.creatorId,actorId:input.actorId,createdAt,expiresAt,requestHash:ownedEvidenceHash([file.fileId,file.creatorId,input.actorId,object]),object,phase:'prepared',reservation:'pending'};
        row=await this.records.create({id:this.id(file.fileId),instanceId:this.instanceId,...this.home(creator),namespace,scopeId:file.creatorId,key:file.fileId,value:value as unknown as Record<string,unknown>},{transaction});
      }
      const value=this.value(row);this.matchFile(value,file);
      if(value.actorId!==input.actorId||value.object.checksum!==input.checksumSha256)throw new SourceFileUploadError('upload_identity_conflict',409,'This original upload belongs to a different request or actor.');
      if(file.uploadState==='cancelled')throw new SourceFileUploadError('upload_cancelled',409,'This original upload was cancelled.');
      return row;
    });
    let value=this.value(row);
    if(value.phase==='closing'||['prepared','issued'].includes(value.phase)&&value.expiresAt<=this.now().toISOString()){await this.close(row);row=await this.read(input.fileId);value=this.value(row);}
    this.open(value);
    if(value.phase!=='completed'){
      const reservation=await this.options.quota.checkAndReserveQuota({creatorId:value.creatorId,operation:'upload.original',idempotencyKey:this.usageKey(row),storageBytesDelta:value.object.byteLength});
      if(!reservation.allowed){await this.close(row);throw new SourceFileUploadError(reservation.reasonCode??'upload_quota_denied',403,'The original exceeds the current storage allowance or is unavailable.');}
      row=await this.mutate(input.fileId,current=>{this.open(current);return current.phase==='completed'?current:{...current,reservation:'reserved'};});value=this.value(row);
      if(value.phase!=='completed'&&this.options.quota.checkCurrentAdmission){const admission=await this.options.quota.checkCurrentAdmission({creatorId:value.creatorId,operation:'upload.original',idempotencyKey:this.usageKey(row)});if(!admission.allowed){await this.close(row);throw new SourceFileUploadError(admission.reasonCode??'upload_admission_denied',403,'This original upload is currently unavailable.');}}
      if(!value.provider){
        // initiate only creates a capability. No capability is exposed until its
        // exact request/expiry is journaled and current source custody rechecked.
        const provider=await this.options.uploads.initiate({object:structuredClone(value.object),checksumAlgorithm:'sha256',expiresAt:value.expiresAt,idempotencyKey:row.id});this.proveProvider(value,provider);
        row=await this.files.asActor(input.actorId,async()=>{
          const transaction=this.files.transaction()!,current=await this.read(input.fileId,transaction),saved=this.value(current);this.open(saved);await this.files.captureSourceAccess(input.actorId);
          const file=await this.file(input.fileId);this.matchFile(saved,file);
          if(file.uploadState!=='pending')throw new SourceFileUploadError('upload_not_pending',409,'This original is no longer pending.');
          if(saved.provider)return current;
          return this.records.update(current.id,current.revision,{value:{...current.value,phase:'issued',provider}},{transaction});
        });value=this.value(row);
      }
    }
    const result=await this.files.asActor(input.actorId,async()=>{
      await this.files.captureSourceAccess(input.actorId);const saved=await this.read(input.fileId,this.files.transaction()!),current=this.value(saved);this.open(current);
      const file=await this.file(input.fileId);this.matchFile(current,file);if(file.uploadState==='cancelled')throw new SourceFileUploadError('upload_cancelled',409,'This original upload was cancelled.');
      if(!current.provider)throw Error('Original capability is not durably issued.');
      return {row:saved,upload:structuredClone(current.provider),completed:current.phase==='completed'};
    });
    return {...await this.result(result.row),upload:result.upload,completed:result.completed};
  }
  private async mutate(fileId:string,change:(value:Session)=>Session):Promise<HostRecord>{
    for(let attempt=0;attempt<5;attempt++){
      const row=await this.read(fileId),value=change(this.value(row));if(same(value,row.value))return row;
      try{return await this.records.update(row.id,row.revision,{value:value as unknown as Record<string,unknown>});}catch(error){if(!conflict(error)||attempt===4)throw error;}
    }
    throw Error('Original upload update requires reconciliation.');
  }
  async accept(input:{actorId:string;fileId:string;body:Uint8Array}):Promise<void>{
    this.outsideTransaction();
    if(!this.options.uploads.accept)throw new SourceFileUploadError('direct_upload_required',404,'Use the signed storage upload capability for this original.');
    const value=await this.files.asActor(input.actorId,async()=>{
      await this.files.captureSourceAccess(input.actorId);const value=this.value(await this.read(input.fileId,this.files.transaction()!));this.open(value);
      const file=await this.file(input.fileId);this.matchFile(value,file);
      if(value.actorId!==input.actorId||value.phase!=='issued'||file.uploadState!=='pending'||value.expiresAt<=this.now().toISOString())throw new SourceFileUploadError('upload_not_pending',409,'This original has no active upload capability.');return value;
    });
    if(input.body.byteLength!==value.object.byteLength||createHash('sha256').update(input.body).digest('hex')!==value.object.checksum)throw new SourceFileUploadError('upload_content_conflict',409,'Original bytes differ from the prepared size or checksum.');
    await this.options.uploads.accept({...this.completion(value),body:input.body,operation:'upload_content'});
    // A cancellation racing this await is resolved by seal/recover; accepted
    // bytes remain owned and charged rather than silently discarded.
  }
  /** Stream through the exact already-issued capability. No new reservation or
   * receipt is invented here; normal complete/recovery/seal settles custody. */
  async acceptStream(input:{actorId:string;fileId:string;body:AsyncIterable<Uint8Array>}):Promise<void>{
    this.outsideTransaction();
    const value=await this.files.asActor(input.actorId,async()=>{
      await this.files.captureSourceAccess(input.actorId);const value=this.value(await this.read(input.fileId,this.files.transaction()!));this.open(value);
      const file=await this.file(input.fileId);this.matchFile(value,file);
      if(value.actorId!==input.actorId||value.phase!=='issued'||file.uploadState!=='pending'||value.expiresAt<=this.now().toISOString())throw new SourceFileUploadError('upload_not_pending',409,'This original has no active upload capability.');return value;
    });
    if(!value.provider)throw new SourceFileUploadError('upload_not_pending',409,'This original has no persisted provider capability.');
    async function* verifiedBody(){
      let size=0;const checksum=createHash('sha256');
      for await(const chunk of input.body){
        if(!(chunk instanceof Uint8Array)||chunk.byteLength>value.object.byteLength-size)throw new SourceFileUploadError('upload_content_conflict',409,'Original bytes exceed the prepared size.');
        size+=chunk.byteLength;checksum.update(chunk);yield chunk;
      }
      if(size!==value.object.byteLength||checksum.digest('hex')!==value.object.checksum)throw new SourceFileUploadError('upload_content_conflict',409,'Original bytes differ from the prepared size or checksum.');
    }
    await writeBoundedUploadStream({uploads:this.options.uploads,upload:structuredClone(value.provider),cellId:this.cellId,creatorId:value.creatorId,openBody:verifiedBody});
    // A cancellation racing transfer is settled by the same permanent seal and
    // recoverable physical receipt. Accepted actual bytes remain chargeable.
  }
  private async writePhysical(row:HostRecord,object:StoredObject,ready:boolean):Promise<HostRecord>{
    this.proveObject(this.value(row),object);
    const save=async(transaction:PersistenceTransaction)=>{
      const current=await this.read(this.value(row).fileId,transaction),value=this.value(current);
      if(value.phase==='sealed')throw Error('A sealed original cannot acquire a completed physical version.');
      if(value.completedObject&&!same(value.completedObject,object))throw Error('Original physical versions conflict.');
      const intent=await this.usage.enqueue({creatorId:value.creatorId,operation:'upload.original',idempotencyKey:this.usageKey(current),storageBytesDelta:object.byteLength,observedAt:object.writtenAt!},this.home(current),transaction);
      const phase=ready||value.phase==='completed'?'completed':'retained';
      if(value.phase===phase&&value.usageIntentId===intent.id)return current;
      return this.records.update(current.id,current.revision,{value:{...current.value,phase,completedObject:object,usageIntentId:intent.id}},{transaction});
    };
    const transaction=this.files.transaction();if(transaction)return save(transaction);
    for(let attempt=0;attempt<5;attempt++){try{return await this.options.repositories.transaction(save);}catch(error){if(!conflict(error)||attempt===4)throw error;}}
    throw Error('Original physical receipt requires reconciliation.');
  }
  /** The reserved-execution port correctly rejects an already settled key.
   * A completed original may still need its Source metadata accepted. Only
   * this same actual journal's full acknowledged storage fact can enter that
   * recovery path; eligibility remains a distinct current policy decision. */
  private async finalizationAdmission(original:HostRecord,object:StoredObject):Promise<{allowed:boolean;settled?:{journal:HostRecord;intent:HostRecord}}>{
    const initial=this.value(original);this.proveObject(initial,object);
    const admission=await this.options.quota.checkCurrentAdmission?.({creatorId:initial.creatorId,operation:'upload.original',idempotencyKey:this.usageKey(original)});
    if(!admission||admission.allowed)return {allowed:true};
    const journal=await this.read(initial.fileId),current=this.value(journal);
    const identity=(value:Session)=>{const {phase,completedObject,usageIntentId,...immutable}=value;return immutable;};
    if(!same(identity(initial),identity(current))||!same(this.home(original),this.home(journal))||journal.createdAt!==original.createdAt)throw new SourceFileUploadError('upload_source_conflict',409,'The original upload lineage changed before factual finalization.');
    if(!['retained','completed'].includes(current.phase)||!current.completedObject||!same(current.completedObject,object)||!current.usageIntentId||current.closureIntentId||current.seal||current.removal)return {allowed:false};
    const input={creatorId:current.creatorId,operation:'upload.original',idempotencyKey:this.usageKey(journal),storageBytesDelta:object.byteLength,observedAt:object.writtenAt!};
    const id=createHash('sha256').update(JSON.stringify([this.instanceId,'runtime-usage-settlement',input.creatorId,input.idempotencyKey])).digest('hex');
    if(current.usageIntentId!==id)return {allowed:false};
    const intent=await this.readRecord(id),fingerprint=JSON.stringify([input.creatorId,input.operation,input.idempotencyKey,0,input.storageBytesDelta,0,input.observedAt]);
    if(!intent||intent.id!==id||intent.namespace!=='runtime-usage-settlement'||intent.instanceId!==this.instanceId||intent.scopeId!==current.creatorId||intent.key!==input.idempotencyKey||!same(this.home(intent),this.home(journal))||!Number.isSafeInteger(intent.revision)||intent.revision<1||intent.value.state!=='settled'||intent.value.fingerprint!==fingerprint||!same(intent.value.input,input))return {allowed:false};
    const policy=this.options.quota.checkCurrentPolicy;if(!policy)return {allowed:false};
    const decision=await policy.call(this.options.quota,{creatorId:current.creatorId,operation:'upload.original'});
    return decision.allowed?{allowed:true,settled:{journal:structuredClone(journal),intent:structuredClone(intent)}}:{allowed:false};
  }
  private async bindFinalizationSettlement(proof:{journal:HostRecord;intent:HostRecord},transaction:PersistenceTransaction):Promise<void>{
    const expected=this.value(proof.journal),journal=await this.read(expected.fileId,transaction),intent=await this.records.get(proof.intent.id,{transaction});
    if(!same(journal,proof.journal)||!intent||!same(intent,proof.intent))throw new SourceFileUploadError('upload_source_conflict',409,'The exact acknowledged original fact changed before metadata acceptance.');
    const check=this.records.checkRevision;if(!check)throw new SourceFileUploadError('upload_accounting_unavailable',503,'The actual acknowledged original receipt revision guard is required.');
    await check.call(this.records,intent.id,intent.revision,{transaction});
    // writePhysical supplies the real conditional write for this exact journal;
    // do not condition-check and write that same physical item twice.
  }
  private async finish(row:HostRecord,object:StoredObject,propagateAccess:boolean,observation?:{attempt:ReturnType<typeof sourceCompletionAttempt>;state:{started:boolean}}):Promise<HostRecord>{
    const value=this.value(row);this.proveObject(value,object);
    for(let attempt=0;attempt<5;attempt++){try{
      const admission=await this.finalizationAdmission(row,object);
      if(!admission.allowed)return this.writePhysical(row,object,false);
      const snapshot=await this.files.asActor(value.actorId,async()=>{
        await this.files.captureSourceAccess(value.actorId);const file=await this.file(value.fileId);this.matchFile(value,file);return file;
      });
      if(snapshot.uploadState==='cancelled')return this.writePhysical(row,object,false);
      const saved=this.value(await this.read(value.fileId));
      let prepared:SourceFileCompletionPreparation|undefined;
      if(saved.phase!=='completed'){
        // Do not hold a repository transaction while reading/decoding an original
        // or writing provider-owned renditions. Their real owner journals recover
        // those side effects if accepting source metadata later fails.
        const prepare=()=>this.options.prepareCompletion(structuredClone(snapshot),structuredClone(object),Object.freeze({actorId:value.actorId}));
        prepared=observation?await sourceCompletionPreparation(observation.attempt,{repositories:this.options.repositories,uploads:this.options.uploads,journal:row,object,actorId:value.actorId},prepare):await prepare();
        if(!prepared||Object.keys(prepared).some(key=>!['checksumSha256','sizeBytes','metadata'].includes(key))||prepared.checksumSha256!==object.checksum||prepared.sizeBytes!==object.byteLength
          ||prepared.metadata!==undefined&&(!prepared.metadata||Array.isArray(prepared.metadata)||typeof prepared.metadata!=='object'||Object.values(prepared.metadata).some(item=>item!==null&&(!['string','number','boolean'].includes(typeof item)||typeof item==='number'&&!Number.isFinite(item)))))throw new SourceFileUploadError('original_finalization_conflict',409,'Verified original metadata differs from its physical receipt.');
        for(const [key,item] of Object.entries(snapshot.metadata??{}))if(!Object.hasOwn(prepared.metadata??{},key)||!same(prepared.metadata![key],item))throw new SourceFileUploadError('original_metadata_conflict',409,'Original finalization must preserve its existing metadata.');
      }
      // Decoder/rendition IO may have overlapped a factual outbox delivery or
      // current policy change. Reopen the actual original fact after that IO.
      const finalAdmission=await this.finalizationAdmission(row,object);
      if(!finalAdmission.allowed)return this.writePhysical(row,object,false);
      return await this.files.asActor(value.actorId,async()=>{
        const transaction=this.files.transaction();if(!transaction)throw new SourceFileUploadError('upload_accounting_unavailable',503,'The actual Source metadata transaction is required.');
        if(finalAdmission.settled)await this.bindFinalizationSettlement(finalAdmission.settled,transaction);
        const access=await this.files.captureSourceAccess(value.actorId),file=await this.file(value.fileId);this.matchFile(value,file);
        if(file.uploadState==='cancelled')return this.writePhysical(row,object,false);
        if(!same(file,snapshot))throw new SourceFileUploadError('upload_source_conflict',409,'Original metadata changed while its bytes were being verified. Retry completion.');
        if(file.uploadState!=='pending'&&file.uploadState!=='ready')throw new SourceFileUploadError('upload_source_conflict',409,'Original state requires reconciliation.');
        if(prepared){
          const updated={...file,...(prepared.metadata===undefined?{}:{metadata:structuredClone(prepared.metadata)}),uploadState:'ready' as const,checksumSha256:object.checksum,revision:(file.revision??0)+1,updatedAt:this.now().toISOString()};
          const audit:SourceFileAudit={auditId:'source-completed-'+ownedEvidenceHash([row.id,object.versionId]),actorUserId:value.actorId,actorRole:access.isAdmin?'admin':'creator',action:'source_file.upload.completed',createdAt:updated.updatedAt,detail:{fileId:file.fileId,creatorId:file.creatorId,revision:updated.revision,uploadState:'ready',objectVersion:object.versionId}};
          await this.files.commitSourceFile({expected:file,file:updated,audit,access});
        }
        return this.writePhysical(row,object,true);
      });
    }catch(error){
      // Physical ownership/usage must survive a failed SourceFile transaction,
      // including loss of its initiating actor. This never mutates SourceFiles.
      // Latch before factual retention IO: its own real metadata collision must
      // not replace retired evidence and restart physical preparation outside.
      const retired=!!observation&&hasRetiredOwnedError(observation.attempt,error);
      if(retired&&observation)observation.state.started=true;
      let retained:HostRecord;
      try{retained=await this.writePhysical(row,object,false);await this.deliver(retained);}
      catch(retentionError){if(retired&&completionRepositoryConflict(retentionError))throw error;throw retentionError;}
      if(!propagateAccess&&denied(error))return retained;
      // A retired physical body is not a fresh decoder command, even when the
      // actual provider error happens to be a typed repository conflict.
      if(retired)throw error;
      if(conflict(error)&&attempt<4)continue;
      throw error;
    }}
    throw Error('Original source completion requires reconciliation.');
  }
  /** A stale decoder/rendition attempt is not permission to reuse its closed
   * output capability. Only the independently accepted SAME original may be
   * returned here, through fresh current Source and policy read authority. */
  private async completedSourceWinner(original:HostRecord,object:StoredObject,actorId:string,observing=false):Promise<SourceFileUploadResult<F>|undefined>{
    const initial=this.value(original);this.proveObject(initial,object);if(initial.actorId!==actorId)return undefined;
    const journal=await this.read(initial.fileId),current=this.value(journal),identity=(value:Session)=>{const {phase,completedObject,usageIntentId,...immutable}=value;return immutable;};
    if(current.phase!=='completed'||current.closureIntentId||current.seal||current.removal||!current.completedObject||!same(current.completedObject,object)||!same(identity(initial),identity(current))||!same(this.home(original),this.home(journal))||original.createdAt!==journal.createdAt)return undefined;
    // Immutable provider bytes are verified OUTSIDE the Source metadata Raw.
    const physical=await this.options.uploads.recoverCompletion!(this.completion(current));if(!physical||!same(physical,object))return undefined;
    const input={creatorId:current.creatorId,operation:'upload.original',idempotencyKey:this.usageKey(journal),storageBytesDelta:object.byteLength,observedAt:object.writtenAt!};
    const id=createHash('sha256').update(JSON.stringify([this.instanceId,'runtime-usage-settlement',input.creatorId,input.idempotencyKey])).digest('hex');if(current.usageIntentId!==id)return undefined;
    const intent=await this.readRecord(id),fingerprint=JSON.stringify([input.creatorId,input.operation,input.idempotencyKey,0,input.storageBytesDelta,0,input.observedAt]);
    if(!intent||intent.id!==id||intent.namespace!=='runtime-usage-settlement'||intent.instanceId!==this.instanceId||intent.scopeId!==current.creatorId||intent.key!==input.idempotencyKey||!same(this.home(intent),this.home(journal))||!Number.isSafeInteger(intent.revision)||intent.revision<1||!['pending','settled'].includes(String(intent.value.state))||intent.value.fingerprint!==fingerprint||!same(intent.value.input,input))return undefined;
    if(intent.value.state==='pending'){const admission=await this.options.quota.checkCurrentAdmission?.({creatorId:current.creatorId,operation:input.operation,idempotencyKey:input.idempotencyKey});if(!admission?.allowed)return undefined;}
    const policy=this.options.quota.checkCurrentPolicy;if(!policy||!(await policy.call(this.options.quota,{creatorId:current.creatorId,operation:input.operation})).allowed)return undefined;
    return this.files.asActor<SourceFileUploadResult<F>|undefined>(actorId,async()=>{
      await this.files.captureSourceAccess(actorId);const transaction=this.files.transaction();if(!transaction)throw new SourceFileUploadError('upload_accounting_unavailable',503,'The actual current Source metadata read is required.');
      const actual=await this.read(current.fileId,transaction),actualIntent=await this.records.get(intent.id,{transaction});if(!same(actual,journal)||!actualIntent||!same(actualIntent,intent)){if(observing)throw winnerReadChanged;throw new SourceFileUploadError('upload_source_conflict',409,'The accepted original changed before its factual response.');}
      const file=await this.file(current.fileId);this.matchFile(current,file);if(file.uploadState!=='ready'||file.checksumSha256!==object.checksum||!Number.isSafeInteger(file.revision)||!file.revision)return undefined;
      const audit=await this.files.getSourceFileAudit('source-completed-'+ownedEvidenceHash([journal.id,object.versionId])),detail=audit?.detail;
      if(!audit||audit.action!=='source_file.upload.completed'||audit.actorUserId!==actorId||!detail||typeof detail!=='object'||Array.isArray(detail)||!('fileId'in detail)||detail.fileId!==current.fileId||!('creatorId'in detail)||detail.creatorId!==current.creatorId||!('objectVersion'in detail)||detail.objectVersion!==object.versionId||!('uploadState'in detail)||detail.uploadState!=='ready'||!('revision'in detail)||typeof detail.revision!=='number'||!Number.isSafeInteger(detail.revision)||detail.revision<1||detail.revision>file.revision)return undefined;
      const check=this.records.checkRevision;if(!check)throw new SourceFileUploadError('upload_accounting_unavailable',503,'The actual original receipt read guards are required.');await check.call(this.records,journal.id,journal.revision,{transaction});await check.call(this.records,intent.id,intent.revision,{transaction});
      // This is an existing fact, not result()/deliver(): no Source/audit/journal
      // write, settlement IO, charge, output retry or old-generation reuse.
      return {file:structuredClone(file),state:'completed',object:structuredClone(physical),usagePending:intent.value.state!=='settled'};
    });
  }
  /** Observe an independently finishing original, including the real interval
   * after retirement but before its successor exists. No preparation, physical
   * recovery of outputs, settlement, or Source metadata writes occur here. */
  private async observeRetiredSourceWinner(original:HostRecord,object:StoredObject,actorId:string,error:unknown):Promise<SourceFileUploadResult<F>>{
    const initial=this.value(original);this.proveObject(initial,object);
    const identity=(value:Session)=>{const {phase,completedObject,usageIntentId,...immutable}=value;return immutable;};
    const deadline=performance.now()+winnerObservationMilliseconds;
    // The elapsed deadline and finite read count both bound observation. An
    // already accepted repository read drains normally rather than being lost.
    for(let observation=0;observation<=winnerObservationMilliseconds/winnerObservationIntervalMilliseconds;observation++){
      if(performance.now()>=deadline)break;
      try{
        await this.currentCompletionRetryPolicy();
        await this.files.asActor(actorId,async()=>{
          await this.files.captureSourceAccess(actorId);const transaction=this.files.transaction();if(!transaction)throw new SourceFileUploadError('upload_accounting_unavailable',503,'The actual current Source metadata read is required.');
          const journal=await this.read(initial.fileId,transaction),current=this.value(journal),file=await this.file(initial.fileId);
          if(current.actorId!==actorId||initial.actorId!==actorId)throw new SourceFileUploadError('upload_identity_conflict',403,'The original upload must be completed by its initiating actor.');
          if(!same(identity(initial),identity(current))||!same(this.home(original),this.home(journal))||original.createdAt!==journal.createdAt||current.completedObject&&!same(current.completedObject,object))throw new SourceFileUploadError('upload_source_conflict',409,'The original upload changed during completion observation.');
          this.matchFile(current,file);
          if(current.closureIntentId||current.seal||current.removal||!['issued','retained','completed'].includes(current.phase)||!['pending','ready'].includes(String(file.uploadState)))throw new SourceFileUploadError('upload_not_pending',409,'This original upload is cancelled or closed.');
        });
        const winner=await this.completedSourceWinner(original,object,actorId,true);if(winner)return winner;
      }catch(currentError){
        // Only real read-guard collisions, or this helper's exact changed
        // snapshot, stay within observation. They never re-enter preparation.
        if(currentError!==winnerReadChanged&&!completionRepositoryConflict(currentError))throw currentError;
      }
      const remaining=deadline-performance.now();if(remaining<=0)break;
      await delay(Math.min(winnerObservationIntervalMilliseconds,remaining));
    }
    throw error;
  }
  private async currentCompletionRetryPolicy():Promise<void>{
    const policy=this.options.quota.checkCurrentPolicy;
    if(!policy)throw new SourceFileUploadError('upload_accounting_unavailable',503,'Current original policy is required before retrying completion.');
    const decision=await policy.call(this.options.quota,{creatorId:this.files.scope.creatorId,operation:'upload.original'});
    if(decision.allowed!==true)throw new SourceFileUploadError(decision.reasonCode??'upload_admission_denied',403,'This original completion is currently unavailable.');
  }
  private async currentCompletionRetryResult(input:{actorId:string;fileId:string},result:SourceFileUploadResult<F>):Promise<SourceFileUploadResult<F>>{
    await this.currentCompletionRetryPolicy();
    // Policy IO can overlap actor/session revocation. The last accepting proof
    // must therefore be the genuine current Source scope, not a cached result.
    return this.files.asActor(input.actorId,async()=>{
      await this.files.captureSourceAccess(input.actorId);
      const transaction=this.files.transaction();if(!transaction)throw new SourceFileUploadError('upload_accounting_unavailable',503,'The actual current Source metadata read is required.');
      const row=await this.read(input.fileId,transaction),value=this.value(row),file=await this.file(input.fileId);
      if(value.actorId!==input.actorId)throw new SourceFileUploadError('upload_identity_conflict',403,'The original upload must be completed by its initiating actor.');
      this.matchFile(value,file);
      if(!same(file,result.file)||value.phase!==result.state||!result.object||!same(value.completedObject,result.object)||result.state==='completed'&&file.uploadState!=='ready')throw new SourceFileUploadError('upload_source_conflict',409,'The original changed before its completion retry response.');
      return{...result,file:structuredClone(file)};
    });
  }
  async complete(input:{actorId:string;fileId:string},recovery?:Readonly<{requireCurrentPolicy?:true}>):Promise<SourceFileUploadResult<F>>{
    // The real initiating actor and original cannot be retargeted by a caller
    // mutating its command while a genuine accepting guard is being retried.
    const command=Object.freeze({actorId:input.actorId,fileId:input.fileId});
    // Only stricter caller-side recovery eligibility; never a body field,
    // persisted permission, or a way to disable this command's own retries.
    const requireCurrentPolicy=recovery?.requireCurrentPolicy===true;
    const observationState={started:false};
    for(let attempt=0;attempt<5;attempt++){
      try{
        const recovering=requireCurrentPolicy||attempt>0,result=await this.completeOnce(command,recovering,observationState);
        // A completed phase is factual, not a current policy grant. A result
        // guard conflict must not turn a later policy denial into success.
        // An observed winner already ended with current original policy and
        // the full accepting Source/receipt/audit read inside its read budget.
        // Do not add a second, unbudgeted result read after that final proof.
        if(recovering&&!observationState.started)return await this.currentCompletionRetryResult(command,result);
        return result;
      }catch(error){
        // This same command can never re-enter physical preparation after
        // observation, including a trailing stricter-policy result read race.
        if(observationState.started||!completionRepositoryConflict(error)||attempt===4)throw error;
      }
    }
    throw new SourceFileUploadError('upload_recovery_pending',409,'Original completion requires reconciliation.');
  }
  private async completeOnce(input:{actorId:string;fileId:string},retrying:boolean,observationState:{started:boolean}):Promise<SourceFileUploadResult<F>>{
    this.outsideTransaction();
    const row=await this.files.asActor(input.actorId,async()=>{
      await this.files.captureSourceAccess(input.actorId);const row=await this.read(input.fileId,this.files.transaction()!),value=this.value(row);
      if(value.actorId!==input.actorId)throw new SourceFileUploadError('upload_identity_conflict',403,'The original upload must be completed by its initiating actor.');
      const file=await this.file(input.fileId);this.matchFile(value,file);
      if(file.uploadState==='cancelled'||value.phase==='sealed'||value.phase==='closing')throw new SourceFileUploadError('upload_not_pending',409,'This original upload is cancelled or closed.');
      if(!value.provider)throw new SourceFileUploadError('upload_not_issued',409,'The original upload capability has not been issued.');return row;
    });
    if(retrying)await this.currentCompletionRetryPolicy();
    const value=this.value(row),completion=this.completion(value);
    let object=value.completedObject??await this.options.uploads.recoverCompletion!(completion);
    if(!object){try{object=await this.options.uploads.complete(completion);}catch(error){object=await this.options.uploads.recoverCompletion!(completion);if(!object)throw error;}}
    const observation=sourceCompletionAttempt();
    try{
      let saved:HostRecord;
      try{saved=await this.finish(row,object,true,{attempt:observation,state:observationState});}
      catch(error){
        if(consumeRetiredOwnedError(observation,error)){
          observationState.started=true;
          return await this.observeRetiredSourceWinner(row,object,input.actorId,error);
        }
        // A nonconditional retention/current-authority failure after the latch
        // remains that failure; it cannot be replaced by a cached winner.
        if(observationState.started)throw error;
        const winner=await this.completedSourceWinner(row,object,input.actorId);if(winner)return winner;throw error;
      }
      return await this.result(saved);
    }finally{endSourceCompletionAttempt(observation);}
  }
  private async close(initial:HostRecord):Promise<HostRecord>{
    let row=await this.mutate(this.value(initial).fileId,value=>['completed','retained','sealed','closing'].includes(value.phase)?value:{...value,phase:'closing',closingAt:this.now().toISOString()}),value=this.value(row);
    if(['completed','retained','sealed'].includes(value.phase)){await this.deliver(row);return row;}
    const seal:UploadSealResult=value.provider?await this.options.uploads.seal!({uploadId:value.provider.uploadId,cellId:this.cellId,creatorId:value.creatorId}):{state:'sealed',proofId:ownedEvidenceHash([row.id,'never-issued',value.closingAt]),closedAt:value.closingAt!};
    if(seal.state==='completed'){row=await this.finish(row,seal.object,false);await this.deliver(row);return row;}
    if(!seal.proofId?.trim()||seal.proofId.length>200||!instant(seal.closedAt))throw Error('An actual original closure proof is required.');
    if(seal.retainedFence&&(seal.retainedFence.bucket!==this.options.bucket||seal.retainedFence.key!==value.object.key||!seal.retainedFence.versionId||seal.retainedFence.byteLength!==0||seal.retainedFence.scope!=='private'||seal.retainedFence.writtenAt!==seal.closedAt))throw Error('Original physical fence conflicts.');
    row=await this.options.repositories.transaction(async transaction=>{
      const current=await this.read(value.fileId,transaction),saved=this.value(current);
      if(saved.phase==='sealed'){if(!same(saved.seal,seal))throw Error('Original closure proofs conflict.');return current;}
      if(saved.phase!=='closing')throw Error('Original physical closure state conflicts.');
      const intent=await this.closures.enqueue({creatorId:saved.creatorId,operation:'upload.original',idempotencyKey:this.usageKey(current),reservedBytes:saved.object.byteLength,proofId:seal.proofId,observedAt:seal.closedAt},this.home(current),transaction);
      return this.records.update(current.id,current.revision,{value:{...current.value,phase:'sealed',seal,closureIntentId:intent.id}},{transaction});
    });
    // Never delete retainedFence: its current version blocks still-valid PUTs.
    await this.deliver(row);return row;
  }
  async cancel(input:{actorId:string;fileId:string;expectedRevision:number}):Promise<SourceFileUploadResult<F>>{
    this.outsideTransaction();
    const row=await this.files.asActor(input.actorId,async()=>{
      const access=await this.files.captureSourceAccess(input.actorId),file=await this.file(input.fileId),row=await this.read(input.fileId,this.files.transaction()!);this.matchFile(this.value(row),file);
      if(file.uploadState==='ready')throw new SourceFileUploadError('upload_already_completed',409,'Completed originals cannot be cancelled.');
      if(file.uploadState!=='cancelled'){
        if(file.uploadState!=='pending'||file.revision!==input.expectedRevision)throw new SourceFileUploadError('upload_revision_conflict',409,'Original upload changed. Refresh before cancelling.');
        const now=this.now().toISOString(),updated={...file,uploadState:'cancelled' as const,downloadable:false,revision:(file.revision??0)+1,updatedAt:now,cancellation:{requestedAt:now,requestedByUserId:input.actorId}};
        await this.files.commitSourceFile({expected:file,file:updated,access,audit:{auditId:'source-cancelled-'+ownedEvidenceHash([row.id,updated.revision]),actorUserId:input.actorId,actorRole:access.isAdmin?'admin':'creator',action:'source_file.upload.cancelled',createdAt:now,detail:{fileId:file.fileId,creatorId:file.creatorId,revision:updated.revision,uploadState:'cancelled'}}});
      }
      return row;
    });
    return this.result(await this.close(row));
  }
  /** A known physical result is checkpointed under a fresh real cancelled
   * Source/cohort/home scope, not a cached human request or a read-only scope.
   * Only this exact private upload journal changes; no provider IO is inside. */
  private async mutateCleanup(fileId:string,change:(value:Session)=>Session):Promise<HostRecord>{
    for(let attempt=0;attempt<5;attempt++)try{
      return await this.files.withCancelledSourceMetadata(fileId,async(_file,transaction)=>{
        const row=await this.read(fileId,transaction),value=change(this.value(row));
        if(same(value,row.value))return row;
        return this.records.update(row.id,row.revision,{value:value as unknown as Record<string,unknown>},{transaction});
      });
    }catch(error){if(!conflict(error)||attempt===4)throw error;}
    throw Error('The original cleanup metadata checkpoint requires reconciliation.');
  }
  /** Maintenance only: remove an already-cancelled owned payload version.
   * Cancellation is irreversible in the SourceFile authority. Its immutable
   * upload receipt, permanent capability fence and financial history remain.
   * No current/saved human is fabricated to recover issued physical facts. */
  async purgeCancelled(fileId:string):Promise<{state:'sealed'|'removed';bytesRemoved:number;usagePending:boolean}>{
    this.outsideTransaction();
    let row=await this.read(fileId),value=this.value(row),file=await this.file(fileId);this.matchFile(value,file);
    if(file.uploadState!=='cancelled'||!file.cancellation||!instant(file.cancellation.requestedAt)||!file.cancellation.requestedByUserId)throw new SourceFileUploadError('upload_not_cancelled',409,'Only an actual cancelled original can be cleaned up.');
    const cancellation={requestedAt:file.cancellation.requestedAt,requestedByUserId:file.cancellation.requestedByUserId};
    row=await this.close(row);value=this.value(row);
    if(value.phase==='sealed'){if(await this.deliver(row))throw new SourceFileUploadError('upload_accounting_pending',503,'The original physical closure still awaits its actual accounting receipt.');return{state:'sealed',bytesRemoved:0,usagePending:false};}
    if(!value.provider||!value.completedObject||!['retained','completed'].includes(value.phase))throw Error('The actual completed cancelled payload requires reconciliation.');
    if(!this.options.removal?.removeOwnedVersion||!this.options.quota.recordOwnedStorageRemoval)throw new SourceFileUploadError('original_cleanup_unavailable',503,'Actual immutable removal and original-settlement-backed storage accounting are required.');
    // Settle the genuine saved positive byte fact before any corresponding
    // negative removal. An ambiguous settlement cannot be treated as zero.
    if(await this.deliver(row))throw new SourceFileUploadError('upload_accounting_pending',503,'The actual stored-original usage receipt must settle before removal.');
    const request:OwnedVersionRemovalRequest={object:structuredClone(value.completedObject),upload:structuredClone(value.provider),cellId:this.cellId,creatorId:value.creatorId},targetFingerprint=ownedVersionFingerprint(request);
    row=await this.files.withCancelledSourceMetadata(fileId,async(actual,transaction)=>{
      const current=await this.read(fileId,transaction),saved=this.value(current);this.matchFile(saved,actual);
      if(actual.uploadState!=='cancelled'||!actual.cancellation||!same(cancellation,{requestedAt:actual.cancellation.requestedAt,requestedByUserId:actual.cancellation.requestedByUserId}))throw new SourceFileUploadError('upload_source_conflict',409,'The original cancellation changed before cleanup.');
      if(saved.removal){if(saved.removal.targetFingerprint!==targetFingerprint||!same(saved.removal.cancellation,cancellation))throw Error('The original owned removal identity changed.');return current;}
      return this.records.update(current.id,current.revision,{value:{...current.value,removal:{schemaVersion:1,targetFingerprint,requestedAt:this.now().toISOString(),cancellation,request}}},{transaction});
    });value=this.value(row);
    if(!value.removal)throw Error('The original removal intent was not retained.');
    if(!value.removal.proof){
      const proof=await this.options.removal.removeOwnedVersion(request);validateOwnedVersionAbsence(request,proof);
      row=await this.mutateCleanup(fileId,current=>{if(!current.removal||current.removal.targetFingerprint!==targetFingerprint||!same(current.removal.request,request))throw Error('The genuine original removal checkpoint changed.');return current.removal.proof?current:{...current,removal:{...current.removal,proof}};});value=this.value(row);
    }
    const removal=value.removal;if(!removal?.proof)throw Error('The actual immutable-version absence proof is required.');
    if(!removal.accountedAt){
      await this.options.quota.recordOwnedStorageRemoval({creatorId:value.creatorId,operation:'upload.original',originalIdempotencyKey:this.usageKey(row),storageBytesRemoved:request.object.byteLength,proofId:removal.proof.proofId,observedAt:removal.proof.observedAt});
      row=await this.mutateCleanup(fileId,current=>{if(!current.removal?.proof||!same(current.removal.proof,removal.proof))throw Error('The actual original removal accounting proof changed.');return current.removal.accountedAt?current:{...current,removal:{...current.removal,accountedAt:this.now().toISOString()}};});
    }
    return{state:'removed',bytesRemoved:request.object.byteLength,usagePending:false};
  }
  /** Trusted host receipt lookup only. This is not original-delivery authority.
   * Consumers still require current SourceFile/Creator and safety access. */
  async readPhysicalReceipt(fileId:string):Promise<StoredObject|undefined>{
    const row=await this.readRecord(this.id(fileId));if(!row)return;const value=this.value(row);return value.completedObject?structuredClone(value.completedObject):undefined;
  }
  /** Dispatch managed sessions here instead of a legacy all-version purger,
   * which would remove the current upload fence. */
  async owns(fileId:string):Promise<boolean>{
    const row=await this.readRecord(this.id(fileId));if(!row)return false;this.value(row);return true;
  }
  /** Maintenance rechecks the saved actor before any ordinary source mutation.
   * Physical settlement/closure itself must also survive actor revocation. */
  async recover(fileId:string):Promise<SourceFileUploadResult<F>>{
    this.outsideTransaction();
    let row=await this.read(fileId),value=this.value(row);
    if(value.phase==='closing'||['prepared','issued'].includes(value.phase)&&value.expiresAt<=this.now().toISOString())row=await this.close(row);
    else if(value.completedObject)row=await this.finish(row,value.completedObject,false);
    else if(value.provider){const object=await this.options.uploads.recoverCompletion!(this.completion(value));if(object)row=await this.finish(row,object,false);}
    value=this.value(row);
    if(value.phase==='prepared')throw new SourceFileUploadError('upload_not_issued',409,'The original upload has not issued a capability.');
    return this.result(row);
  }
  async repair(limit=25):Promise<number>{
    if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw Error('Original upload repair limit is invalid.');
    const cursorId='source-upload-repair-'+ownedEvidenceHash([this.instanceId,this.cellId,this.files.scope.tenantId,this.files.scope.creatorId]);
    const cursor=await this.readRecord(cursorId);
    if(cursor&&(cursor.namespace!==namespace+'-repair'||cursor.instanceId!==this.instanceId||cursor.homeCellId!==this.cellId||cursor.scopeId!==this.files.scope.creatorId||cursor.value.schemaVersion!==1||typeof cursor.value.after!=='string'))throw Error('Original repair cursor requires reconciliation.');
    const rows:HostRecord[]=[];
    for await(const row of repositoryItems(request=>withRepositoryRead(
      this.options.repositories,transaction=>this.records.list(request,{transaction})
    )))rows.push(row);
    const indexed=new Map(rows.map(row=>[row.id,row]));
    const candidates=rows.filter(row=>{
      if(row.namespace!==namespace||row.instanceId!==this.instanceId||row.homeCellId!==this.cellId||row.scopeId!==this.files.scope.creatorId)return false;
      const value=this.value(row);
      if(value.removal?.accountedAt)return false;
      if(value.removal)return true;
      if(value.phase==='prepared'&&value.expiresAt>this.now().toISOString())return false;
      if(value.phase==='sealed'||value.phase==='completed')return indexed.get((value.usageIntentId??value.closureIntentId)!)?.value.state==='pending';
      return true;
    }).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
    const after=cursor?.value.after as string|undefined;
    const selected=[...candidates.filter(row=>!after||row.id>after),...candidates.filter(row=>after&&row.id<=after)].slice(0,limit);
    let failure:unknown;
    for(const row of selected){try{const value=this.value(row);if(value.removal)await this.purgeCancelled(value.fileId);else await this.recover(value.fileId);}catch(error){failure??=error;}}
    if(selected.length){
      const last=selected.at(-1)!,value={schemaVersion:1,after:last.id};
      try{
        if(cursor)await this.records.update(cursor.id,cursor.revision,{value});
        else await this.records.create({id:cursorId,instanceId:this.instanceId,...this.home(last),namespace:namespace+'-repair',scopeId:this.files.scope.creatorId,key:'repair-cursor',value});
      }catch(error){if(!conflict(error))failure??=error;/* Another repair advanced its own cursor; effects remain independently replayable. */}
    }
    if(failure)throw failure;return selected.length;
  }
}
