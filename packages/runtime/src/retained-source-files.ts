import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {CreatorRecord, PersistenceTransaction, RetainedCreatorContentModels, UbeeqRepositories} from '@ubeeq/persistence';
import {CreatorSourceFileError, type CreatorSourceFilePage, type CreatorSourceFilePageRequest} from '@ubeeq/core';
import {RepositoryRetainedContentStore, RetainedRepositoryError, type RetainedAssetAttachmentCommit, type RetainedAuditEvent, type RetainedRepositoryBindings, type RetainedRepositoryChange, type RetainedRepositoryScope} from './retained-repository-store.js';

/** Original metadata is not permission to retrieve its private storage key. */
export interface RetainedSourceFile {
  revision?:number;
  uploadState?:'pending'|'ready'|'cancelled';
  cancellation?:{requestedAt:string;requestedByUserId:string;lastCleanupAt?:string;cleanupError?:string;nextCleanupAt?:string;cleanupAttempts?:number};
  fileId:string;creatorId:string;sourceKind:'image'|'video'|'audio'|'document'|'archive'|'other';
  mimeType:string;storageKey:string;originalFilename?:string;sizeBytes?:number;checksumSha256?:string;
  metadata?:Record<string,string|number|boolean|null>;downloadable?:boolean;premium?:boolean;restricted?:boolean;
  createdAt:string;updatedAt:string;
}
export interface SourceRoleAssignment {userId:string;role:string;revision:number;updatedAt:string;updatedByUserId:string}
export interface SourceCreatorMember {creatorId:string;userId:string;role:string;createdAt?:string;invitedByUserId?:string}
export interface SourceFileAccess {
  actorUserId:string;isAdmin:boolean;expectedRole:SourceRoleAssignment|null;expectedMember:SourceCreatorMember|null;
  /** A real canonical ownership record, rather than an invented owner membership. */
  expectedOwner?:Readonly<CreatorRecord>;
}
export interface SourceFileAudit extends RetainedAuditEvent {actorRole:'public'|'user'|'creator'|'admin'}
export interface SourceFileMutation<F extends RetainedSourceFile=RetainedSourceFile> {expected:F|null;file:F;audit:SourceFileAudit;access:SourceFileAccess}
export class SourceFileConflict extends Error {readonly code='revision_conflict';readonly status=409}
const same=(a:unknown,b:unknown)=>isDeepStrictEqual(JSON.parse(JSON.stringify(a)),JSON.parse(JSON.stringify(b)));
export const sameSourceFile=(a:RetainedSourceFile|null,b:RetainedSourceFile|null):boolean=>same(a,b);
const sameRole=(a:SourceRoleAssignment|null,b:SourceRoleAssignment|null)=>a===null||b===null?a===b:
  a.userId===b.userId&&a.role===b.role&&a.revision===b.revision&&a.updatedAt===b.updatedAt&&a.updatedByUserId===b.updatedByUserId;

/** Preserves the established source mutation rules. Hosts bind current account,
 * platform-role, owner/member and inactive-user evidence in the same transaction. */
export function validateSourceFileMutation({expected,file,audit,access}:SourceFileMutation):void {
  const owner=access?.expectedOwner;
  const ownerMatches=owner&&owner.id===file.creatorId&&owner.subjectId===access.actorUserId;
  const member=access?.expectedMember;
  if(!access?.actorUserId||audit.actorUserId!==access.actorUserId
    ||access.expectedRole&&access.expectedRole.userId!==access.actorUserId
    ||access.isAdmin&&access.expectedRole&&access.expectedRole.role!=='admin'
    ||!access.isAdmin&&!ownerMatches&&(!member||member.userId!==access.actorUserId||member.creatorId!==file.creatorId||!['owner','admin','manager','editor'].includes(member.role)))
    throw new SourceFileConflict('Creator access changed. Refresh and retry.');
  if(!expected&&file.uploadState!=='pending'
    ||expected?.uploadState==='ready'&&file.uploadState!=='ready'
    ||expected?.uploadState==='cancelled'&&file.uploadState!=='cancelled'
    ||file.uploadState==='cancelled'&&(!file.cancellation||file.downloadable!==false||expected?.uploadState!=='cancelled'&&file.cancellation.requestedByUserId!==access.actorUserId))
    throw new SourceFileConflict('Invalid upload state transition.');
  if(!file.fileId||!file.creatorId||file.revision!==(expected?.revision||0)+1
    ||expected&&(expected.fileId!==file.fileId||expected.creatorId!==file.creatorId||expected.storageKey!==file.storageKey))
    throw new SourceFileConflict('Invalid source-file change.');
}
export interface SourceCleanupJob {fileId:string;nextAttemptAt:string}
export interface SourceCleanupResult<F extends RetainedSourceFile=RetainedSourceFile> {expected:F;now:string;nextAttemptAt:string;error?:string}
export const cleanupDueAt=(file:RetainedSourceFile):string|undefined=>file.uploadState==='cancelled'?file.cancellation?.nextCleanupAt||file.cancellation?.requestedAt:undefined;
export function sourceCleanupRecords<F extends RetainedSourceFile>(input:SourceCleanupResult<F>):{file:F;audit:SourceFileAudit} {
  const {expected,now,nextAttemptAt,error}=input;
  if(expected.uploadState!=='cancelled'||!expected.cancellation||!expected.revision||!Number.isFinite(Date.parse(now))||!Number.isFinite(Date.parse(nextAttemptAt))||nextAttemptAt<=now)
    throw new SourceFileConflict('Invalid cancelled-source cleanup result.');
  return {file:{...expected,revision:expected.revision+1,updatedAt:now,cancellation:{...expected.cancellation,lastCleanupAt:now,nextCleanupAt:nextAttemptAt,cleanupAttempts:(expected.cancellation.cleanupAttempts||0)+1,cleanupError:error}},
    audit:{auditId:randomUUID(),actorUserId:'system:source-upload-cleanup',actorRole:'admin',action:error?'source_file.upload.cleanup_failed':'source_file.upload.cleanup_attempted',createdAt:now,
      detail:{fileId:expected.fileId,creatorId:expected.creatorId,automatic:true,nextAttemptAt,revision:expected.revision+1}}};
}
export interface RetainedSourceBindings<M extends RetainedCreatorContentModels> extends Omit<RetainedRepositoryBindings<M>,'resolveActorRole'> {
  /** Return actual guarded records. A null result denies access; do not synthesize memberships. */
  resolveSourceAccess(actorId:string,creator:Readonly<CreatorRecord>,transaction:PersistenceTransaction):Promise<SourceFileAccess|null>;
}

const sourceActorRole=(access:SourceFileAccess|null,actor:string,creator:Readonly<CreatorRecord>):string|null=>{
  if(!access||access.actorUserId!==actor||typeof access.isAdmin!=='boolean')return null;
  const assignment=access.expectedRole;
  if(assignment&&(assignment.userId!==actor||typeof assignment.role!=='string'||!Number.isSafeInteger(assignment.revision)||assignment.revision<1||!assignment.updatedAt||!assignment.updatedByUserId))return null;
  if(access.isAdmin)return assignment&&assignment.role!=='admin'?null:'admin';
  if(access.expectedOwner&&creator.subjectId===actor&&same(access.expectedOwner,creator))return 'owner';
  const member=access.expectedMember;
  return member?.creatorId===creator.id&&member.userId===actor?member.role:null;
};

/** One Creator's full source records, canonical content, commands and audit all
 * share the repository transaction. A host aggregates Creator scopes explicitly.
 */
export class RepositoryRetainedSourceFiles<M extends RetainedCreatorContentModels=RetainedCreatorContentModels,F extends RetainedSourceFile=RetainedSourceFile> extends RepositoryRetainedContentStore<M> {
  private readonly cleanupContext=new AsyncLocalStorage<{expected:F;file:F;audit:SourceFileAudit}>();
  constructor(repositories:UbeeqRepositories,scope:RetainedRepositoryScope,private readonly sourceBindings:RetainedSourceBindings<M>){
    if(typeof sourceBindings?.resolveSourceAccess!=='function'||typeof sourceBindings.validateAssetAttachment!=='function')throw Error('Original files require actual access and transform bindings.');
    let sourceStore:RepositoryRetainedSourceFiles<M,F>|undefined;
    super(repositories,scope,{...sourceBindings,resolveActorRole:async(actor,creator,transaction)=>{
      return sourceActorRole(await sourceBindings.resolveSourceAccess(actor,creator,transaction),actor,creator);
    },validateAssetAttachment:async input=>{
      if(!sourceStore)throw Error('Original-file composition is not initialized.');
      await sourceStore._validateSourceAttachment(input);await sourceBindings.validateAssetAttachment(input);
    }});
    sourceStore=this;
  }
  private async _access(expected:SourceFileAccess):Promise<void>{
    const transaction=this.transaction();if(!transaction)throw Error('Original access must join the accepting content transaction.');
    const current=await this.sourceBindings.resolveSourceAccess(expected.actorUserId,this.currentCreator(),transaction);
    if(!current||!sourceActorRole(current,expected.actorUserId,this.currentCreator())||current.actorUserId!==expected.actorUserId||current.isAdmin!==expected.isAdmin||!sameRole(current.expectedRole,expected.expectedRole)
      ||expected.expectedOwner&&!same(current.expectedOwner??null,expected.expectedOwner)
      ||!expected.isAdmin&&!expected.expectedOwner&&!same(current.expectedMember,expected.expectedMember))
      throw new SourceFileConflict('Creator access changed. Refresh and retry.');
  }
  /** Server-side evidence for intake/controllers; never accept this from request JSON. */
  async captureSourceAccess(actorId:string):Promise<SourceFileAccess>{
    return this.asActor(actorId,async()=>{
      const access=await this.sourceBindings.resolveSourceAccess(actorId,this.currentCreator(),this.transaction()!);
      if(!access||!sourceActorRole(access,actorId,this.currentCreator()))throw new SourceFileConflict('Creator access changed. Refresh and retry.');
      return access;
    });
  }
  private async _validateSourceAttachment(input:RetainedAssetAttachmentCommit<M>):Promise<void>{
    const guarded=input.sourceFileGuard as {file:F;access:SourceFileAccess}|undefined;
    const id=guarded?.file?.fileId??input.asset.metadata?.sourceFileId;
    if(id===undefined)return;
    if(typeof id!=='string')throw new SourceFileConflict('Original identity is invalid.');
    const file=await this.getSourceFileById(id),actor=this.currentActor();
    if(!file||!actor||file.creatorId!==input.work.creatorId||file.uploadState!=='ready'||file.restricted||file.premium||input.asset.storage.objectKey!==file.storageKey
      ||file.checksumSha256&&file.checksumSha256!==input.asset.checksumSha256||guarded&&!sameSourceFile(file,guarded.file))
      throw new SourceFileConflict('Original or Creator access changed. Refresh and retry.');
    if(guarded){if(guarded.access.actorUserId!==actor)throw new SourceFileConflict('Original actor changed.');await this._access(guarded.access);}
  }
  private _storedFile(key:string,file:F):F{
    if(!file||file.fileId!==key||file.creatorId!==this.scope.creatorId||['sourceKind','mimeType','storageKey','createdAt','updatedAt'].some(name=>typeof file[name as keyof F]!=='string'||!file[name as keyof F])
      ||file.revision!==undefined&&(!Number.isSafeInteger(file.revision)||file.revision<1)
      ||file.uploadState!==undefined&&!['pending','ready','cancelled'].includes(file.uploadState)
      ||file.uploadState==='cancelled'&&(!file.cancellation?.requestedAt||!file.cancellation.requestedByUserId))
      throw new RetainedRepositoryError('retained_content_invalid','Original-file records require reconciliation.',503);
    return file;
  }
  async getSourceFileById(id:string):Promise<F|null>{return this.run(async()=>{const file=await this.getRetainedEntity<F>('source-file',id);return file?this._storedFile(id,file):null;});}
  async listSourceFilesByCreatorId(creatorId:string):Promise<F[]>{
    if(creatorId!==this.scope.creatorId)return [];
    return this.run(async()=>this.retainedEntityEntries<F>('source-file').map(({key,value})=>this._storedFile(key,value)));
  }
  async listCreatorSourceFiles(creatorId:string,request:CreatorSourceFilePageRequest):Promise<CreatorSourceFilePage<F>>{
    if(!Number.isSafeInteger(request.limit)||request.limit<1||request.limit>100||request.cursor!==undefined&&(typeof request.cursor!=='string'||!request.cursor||request.cursor.length>8192))throw new CreatorSourceFileError('invalid_page','Invalid source-file page.');
    let after:string|undefined;
    if(request.cursor){try{const decoded=JSON.parse(Buffer.from(request.cursor,'base64url').toString('utf8'));if(decoded.instanceId!==this.scope.instanceId||decoded.tenantId!==this.scope.tenantId||decoded.creatorId!==creatorId||typeof decoded.after!=='string'||!decoded.after)throw Error('scope');after=decoded.after;}catch{throw new CreatorSourceFileError('invalid_page','Invalid source-file cursor.');}}
    const key=(file:F)=>JSON.stringify([file.createdAt,file.fileId]);
    const rows=(await this.listSourceFilesByCreatorId(creatorId)).filter(file=>!after||key(file)>after).sort((a,b)=>key(a)<key(b)?-1:key(a)>key(b)?1:0),items=rows.slice(0,request.limit),last=items.at(-1);
    return {items,...(last&&items.length<rows.length?{nextCursor:Buffer.from(JSON.stringify({instanceId:this.scope.instanceId,tenantId:this.scope.tenantId,creatorId,after:key(last)})).toString('base64url')}:{})};
  }
  async getSourceFileAudit(id:string):Promise<SourceFileAudit|null>{return this.readRetainedAudit(id);}
  async commitSourceFile(input:SourceFileMutation<F>):Promise<void>{
    const prepared=structuredClone(input);validateSourceFileMutation(prepared);
    await this.asActor(prepared.access.actorUserId,async()=>{
      await this._access(prepared.access);
      if(await this.getSourceFileAudit(prepared.audit.auditId))throw new SourceFileConflict('The audit identity is already in use.');
      if(!sameSourceFile(await this.getSourceFileById(prepared.file.fileId),prepared.expected))throw new SourceFileConflict('The file changed. Refresh and retry.');
      await this.putRetainedEntity('source-file',prepared.file.fileId,prepared.file);
      await this.appendRetainedAudit(prepared.audit,prepared.file.fileId);
    });
  }
  async listSourceCleanupJobs(now:string,limit:number):Promise<SourceCleanupJob[]>{
    if(!Number.isFinite(Date.parse(now))||!Number.isSafeInteger(limit)||limit<1||limit>100)throw new SourceFileConflict('Invalid cleanup page.');
    return (await this.listSourceFilesByCreatorId(this.scope.creatorId)).flatMap(file=>{const due=cleanupDueAt(file);return due&&due<=now?[{fileId:file.fileId,nextAttemptAt:due}]:[];})
      .sort((a,b)=>a.nextAttemptAt.localeCompare(b.nextAttemptAt)||a.fileId.localeCompare(b.fileId)).slice(0,limit);
  }
  async discardSourceCleanupJob(_job:SourceCleanupJob):Promise<void>{/* The queue is derived from current cancellation records, as in the retained local host. */}
  async commitSourceCleanup(input:SourceCleanupResult<F>):Promise<void>{
    const expected=structuredClone(input.expected),next=sourceCleanupRecords({...structuredClone(input),expected});
    await this.cleanupContext.run({expected,...next},()=>this.run(async()=>{
      if(!sameSourceFile(await this.getSourceFileById(expected.fileId),expected))throw new SourceFileConflict('Cancelled source changed. Retry cleanup.');
      await this.putRetainedEntity('source-file',next.file.fileId,next.file);
      await this.appendRetainedAudit(next.audit,next.file.fileId);
    }));
  }
  protected override mayCommitMaintenance(changes:readonly RetainedRepositoryChange[]):boolean{
    const intent=this.cleanupContext.getStore();if(!intent||changes.length!==1)return false;const change=changes[0];
    return change.category==='entity'&&change.kind==='source-file'&&change.key===intent.expected.fileId&&same(change.previous??null,intent.expected)&&same(change.next??null,intent.file);
  }
  protected override mayAppendMaintenanceAudit(event:Readonly<RetainedAuditEvent>):boolean{
    const intent=this.cleanupContext.getStore();return Boolean(intent&&same(event,intent.audit));
  }
}

export interface RetainedSourceCleanupStore<F extends RetainedSourceFile> {
  listSourceCleanupJobs(now:string,limit:number):Promise<SourceCleanupJob[]>;
  getSourceFileById(id:string):Promise<F|null>;
  commitSourceCleanup(input:SourceCleanupResult<F>):Promise<void>;
  discardSourceCleanupJob(job:SourceCleanupJob):Promise<void>;
}
/** Physical deletion is an injected real storage adapter. Successful deletion
 * still schedules a later check for an already-issued upload arriving late. */
export function createSourceUploadCleanupWorker<F extends RetainedSourceFile>(store:RetainedSourceCleanupStore<F>,purge:(file:F)=>Promise<void>,clock:()=>Date=()=>new Date()){
  if(typeof purge!=='function')throw Error('Source cleanup requires an actual private-original storage adapter.');
  let running=false;
  const run=async(limit:number)=>{
    const failures:unknown[]=[],results:SourceCleanupJob[]=[];
    for(const job of await store.listSourceCleanupJobs(clock().toISOString(),limit)){
      try{
        const file=await store.getSourceFileById(job.fileId);
        if(!file||cleanupDueAt(file)!==job.nextAttemptAt){await store.discardSourceCleanupJob(job);continue;}
        let error:string|undefined;
        try{await purge(file);}catch{error='Storage cleanup could not finish. Automatic retry is scheduled.';}
        const now=clock(),delay=Math.min(24*60*60_000,60_000*2**Math.min(file.cancellation?.cleanupAttempts||0,11)),nextAttemptAt=new Date(now.getTime()+delay).toISOString();
        await store.commitSourceCleanup({expected:file,now:now.toISOString(),nextAttemptAt,error});results.push({fileId:file.fileId,nextAttemptAt});
      }catch(failure){failures.push(failure);}
    }
    if(failures.length)throw new AggregateError(failures,'Some source cleanup jobs could not be checkpointed.');
    return results;
  };
  return {
    async tick():Promise<void>{if(running)return;running=true;try{await run(50);}finally{running=false;}},
    async runNextJob():Promise<SourceCleanupJob|undefined>{if(running)return;running=true;try{return(await run(1))[0];}finally{running=false;}}
  };
}
