import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash} from 'node:crypto';
import {MemoryCreatorContentStore,CreatorContentCommitError,publicationIdentityHash,validateUbeeqWorkPageOptions,ubeeqWorkSortKey,type UbeeqWorkPageOptions,type UbeeqWorkPage,type RetainedCreatorContentModels,type CreatorContentAssetCommit,type RetainedContentAtomic,type CreatorRecord,type HostRecord,type PersistenceTransaction,type TransactionRunner,type UbeeqRepositories} from '@ubeeq/persistence';
import {assertPublicationDisclosureHistoryImmutable,PublicationImageError} from '@ubeeq/core';

export interface RetainedRepositoryScope {instanceId:string;tenantId:string;creatorId:string;cellId:string;region:string}
export type RetainedRepositoryAccess='read'|'edit'|'manage';
export interface RetainedAssetAttachmentCommit<M extends RetainedCreatorContentModels> extends CreatorContentAssetCommit<M> {
 replacement?:{previousAsset:M['asset']};
 sourceFileGuard?:unknown;
}
export interface RetainedRepositoryBindings<M extends RetainedCreatorContentModels> {
 /** Commercial hosts enclose the complete operation in their same guard registry. */
 transactions?:TransactionRunner;
 /** Resolve current, durable authority in this exact accepting transaction. */
 resolveActorRole(actorId:string,creator:Readonly<CreatorRecord>,transaction:PersistenceTransaction):Promise<string|null>;
 /** The source/transform host retains its original source-file and replacement guards. */
 validateAssetAttachment(input:RetainedAssetAttachmentCommit<M>):Promise<void>;
}
export interface RetainedRepositoryChange {
 category:'canonical'|'command'|'entity';kind:string;key:string;
 previous?:Readonly<Record<string,unknown>>;next?:Readonly<Record<string,unknown>>;
}
export interface RetainedAuditEvent {
 auditId:string;action:string;actorUserId?:string|null;actorRole?:string;
 detail?:Readonly<Record<string,unknown>>;createdAt:string;
}
/** Neutral host-entity commands are conditional storage operations, not proof
 * of a provider result. The host must enlist its real domain/result authority. */
export interface RetainedEntityRemoval {
 kind:string;key:string;expected:Readonly<Record<string,unknown>>;
}
export interface RetainedEntityMove {
 kind:string;fromKey:string;toKey:string;expected:Readonly<Record<string,unknown>>;next:Readonly<Record<string,unknown>>;
}
export class RetainedEntityMutationError extends Error {
 readonly status:number;
 constructor(readonly code:'retained_entity_invalid'|'retained_entity_conflict',message:string){super(message);this.status=code==='retained_entity_conflict'?409:400;}
}
export class RetainedRepositoryError extends Error {
 constructor(readonly code:'retained_content_migration_required'|'retained_content_invalid'|'retained_content_too_large'|'access_denied',message:string,readonly status=409){super(message);}
}
const namespace='retained-creator-content';
const fields={works:['workId'],canonicalAssets:['assetId'],workAssets:['workId','assetId'],publications:['publicationId'],publicationIntents:['publicationIntentId'],creatorCollections:['collectionId'],collectionWorks:['collectionId','workId'],workDiscovery:['workId'],contentRestores:['restoreId'],sourceReceipts:['receiptId'],publicationClaims:['key'],publicationOperations:['operationId']} as const;
type Field=keyof typeof fields;
type Value=Record<string,any>;
type Address={category:'canonical'|'command'|'entity';kind:string;key:string};
type Stored={address:Address;row:HostRecord;payload:Value};
type State={transaction:PersistenceTransaction;phase:'open'|'closing'|'closed';rollbackOnly:boolean;pending:number;creator:CreatorRecord;cohort:HostRecord;before:Map<string,Stored>;fields:Map<Field,Value[]>;extra:Map<string,{address:Address;payload:Value}>;actor?:string};
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const identity=(scope:RetainedRepositoryScope,address:Address|'cohort')=>'retained-'+hash([scope.instanceId,scope.tenantId,scope.creatorId,address]);
const addressKey=(address:Address)=>JSON.stringify([address.category,address.kind,address.key]);
const inventory=(ids:Iterable<string>)=>{const values=[...ids].sort();return {count:values.length,hash:hash(values)};};
const invalid=()=>new RetainedRepositoryError('retained_content_invalid','Retained content requires reconciliation.',503);
const json=(value:unknown):Value=>{
 const encoded=JSON.stringify(value);if(!encoded || Buffer.byteLength(encoded)>300*1024)throw new RetainedRepositoryError('retained_content_too_large','This retained record exceeds its safe storage size.',413);
 const copy:unknown=JSON.parse(encoded);if(!copy || typeof copy!=='object' || Array.isArray(copy))throw invalid();return copy as Value;
};
const home=(creator:CreatorRecord)=>({homeCellId:creator.homeCellId,dataHomeRegion:creator.dataHomeRegion,dataHomeAssignedAt:creator.dataHomeAssignedAt,routingRevision:creator.routingRevision});
const cohortValue=(scope:RetainedRepositoryScope,ids:Iterable<string>)=>({schemaVersion:1,tenantId:scope.tenantId,creatorId:scope.creatorId,inventory:inventory(ids)});
const requireScope=(scope:RetainedRepositoryScope)=>{if(Object.values(scope).some(value=>typeof value!=='string'||!value||value.length>200))throw invalid();};

/** Trusted birth hook ONLY, in the actual new-Creator creation transaction.
 * Existing Creators must migrate a complete inventory under a fenced writer.
 * Reads never initialize an absent authority or assume an empty legacy history. */
export async function createRetainedRepositoryCreator(repositories:UbeeqRepositories,record:Omit<CreatorRecord,'revision'|'createdAt'|'updatedAt'|'contentAuthority'>,tenantId:string,transaction:PersistenceTransaction):Promise<CreatorRecord>{
 const scope={instanceId:record.instanceId,tenantId,creatorId:record.id,cellId:record.homeCellId,region:record.dataHomeRegion};requireScope(scope);
 if(!repositories.hostRecords?.snapshot || await repositories.creators.get(record.id,{transaction}))throw invalid();
 const creator=await repositories.creators.create({...record,contentAuthority:'retained-v1'},{transaction});
 await repositories.hostRecords.create({id:identity(scope,'cohort'),instanceId:scope.instanceId,...home(creator),namespace,scopeId:creator.id,key:'cohort',value:cohortValue(scope,[])},{transaction});
 return creator;
}

/** Full retained JSON records live individually in the actual repositories.
 * The memory domain engine is an ephemeral transaction view, never a store or
 * authority. Every async method loads a guarded canonical inventory; only its
 * changed records flush into the same transaction as actor and command guards.
 */
export class RepositoryRetainedContentStore<M extends RetainedCreatorContentModels=RetainedCreatorContentModels> extends MemoryCreatorContentStore<M> {
 readonly publicationAtomic:RetainedContentAtomic<M['publication']>;
 private readonly context=new AsyncLocalStorage<State>();
 constructor(private readonly repositories:UbeeqRepositories,readonly scope:RetainedRepositoryScope,private readonly bindings:RetainedRepositoryBindings<M>){
  super();requireScope(scope);
  if(!repositories.hostRecords?.snapshot || !repositories.creators.checkRevision || typeof bindings?.resolveActorRole!=='function' || typeof bindings.validateAssetAttachment!=='function')throw Error('Retained content requires guarded repositories and its actual authority/source bindings.');
  // Canonical arrays exist only in the current transaction. Independent callers
  // cannot observe or mutate another transaction's domain view.
  for(const field of Object.keys(fields) as Field[])Object.defineProperty(this,field,{configurable:true,enumerable:false,get:()=>this.active().fields.get(field)!,set:(value:Value[])=>{if(!Array.isArray(value))throw invalid();this.active().fields.set(field,value);}});
  const methods=new Map<string,Function>();
  for(const prototype of [MemoryCreatorContentStore.prototype,RepositoryRetainedContentStore.prototype])for(const name of Object.getOwnPropertyNames(prototype)){
   if(name==='constructor'||name==='validatePublication'||name==='run'||name==='flush'||name==='authorizeActor'||name==='asActor')continue;
   const method=Object.getOwnPropertyDescriptor(prototype,name)?.value;
   if(typeof method==='function' && method.constructor.name==='AsyncFunction' && !name.startsWith('_'))methods.set(name,method);
  }
  for(const [name,method] of methods)Object.defineProperty(this,name,{value:(...args:unknown[])=>{const input=structuredClone(args);return this.run(()=>Reflect.apply(method,this,input));},configurable:true});
  this.publicationAtomic={supportsConditionalTransactions:true,run:operation=>this.run(operation),active:()=>this.context.getStore()?.phase==='open',
   get:(kind,id)=>this.getEntity('command',this.commandKind(kind),id),list:kind=>this.listEntities('command',this.commandKind(kind)),put:(kind,id,value)=>this.putEntity('command',this.commandKind(kind),id,value),savePublication:publication=>this.upsertPublication(publication)};
 }
 transaction():PersistenceTransaction|undefined{const state=this.context.getStore();return state?.phase==='open'?state.transaction:undefined;}
 private active():State{const state=this.context.getStore();if(!state||state.phase!=='open')throw Error('An active retained-content transaction is required.');return state;}
 private commandKind(kind:string):string{const prefix=`content-workflow:${this.scope.tenantId}:${this.scope.creatorId}:`;if(!kind.startsWith(prefix)||!/^[-a-zA-Z0-9_]{1,100}$/.test(kind.slice(prefix.length)))throw new RetainedRepositoryError('access_denied','Retained command scope denied.',403);return kind.slice(prefix.length);}
 async authorizeActor(actorId:string,access:RetainedRepositoryAccess='edit'):Promise<boolean>{
  if(typeof actorId!=='string'||!actorId)return false;
  return this.run(async()=>{
   const state=this.active();if(access!=='read'&&'deletion' in state.creator&&state.creator.deletion)return false;
   const role=await this.bindings.resolveActorRole(actorId,structuredClone(state.creator),state.transaction);
   const allowed=(access==='read'?['owner','admin','manager','editor','viewer']:access==='manage'?['owner','admin','manager']:['owner','admin','manager','editor']).includes(role??'');
   if(allowed && access!=='read'){
    if(state.actor && state.actor!==actorId)throw new RetainedRepositoryError('access_denied','One saved actor must own this accepting transaction.',403);
    state.actor=actorId;
   }
   return allowed;
  });
 }
 async asActor<T>(actorId:string,operation:()=>Promise<T>,access:RetainedRepositoryAccess='edit'):Promise<T>{return this.run(async()=>{if(!await this.authorizeActor(actorId,access))throw new RetainedRepositoryError('access_denied','Current Creator access is required.',403);return operation();});}
 protected async run<T>(operation:(transaction:PersistenceTransaction)=>Promise<T>):Promise<T>{
  const inherited=this.context.getStore();
  if(inherited){
   if(inherited.phase!=='open'){inherited.rollbackOnly=true;throw Error('This retained-content transaction has ended.');}
   inherited.pending++;
   try{return await operation(inherited.transaction);}catch(error){inherited.rollbackOnly=true;throw error;}finally{inherited.pending--;}
  }
  const snapshot=await this.repositories.hostRecords!.snapshot!();let owned:State|undefined;
  try{return await (this.bindings.transactions??this.repositories).transaction(async transaction=>{
   await snapshot.bind(transaction);
   const creator=await this.repositories.creators.get(this.scope.creatorId,{transaction});
   if(!creator || creator.instanceId!==this.scope.instanceId || creator.homeCellId!==this.scope.cellId || creator.dataHomeRegion!==this.scope.region)throw new RetainedRepositoryError('access_denied','The current Creator data home is unavailable.',403);
   if(creator.contentAuthority!=='retained-v1')throw new RetainedRepositoryError('retained_content_migration_required','This Creator needs a fenced retained-content migration.',503);
   const rows=snapshot.items.filter(row=>row.instanceId===this.scope.instanceId && row.namespace===namespace && row.scopeId===this.scope.creatorId);
   const cohort=rows.find(row=>row.id===identity(this.scope,'cohort'));
   if(!cohort)throw new RetainedRepositoryError('retained_content_migration_required','This Creator needs a complete retained-content migration before using this writer.',503);
   if(cohort.key!=='cohort' || publicationIdentityHash(cohort.value)!==publicationIdentityHash(cohortValue(this.scope,rows.filter(row=>row!==cohort).map(row=>row.id))))throw invalid();
   const state:State={transaction,phase:'open',rollbackOnly:false,pending:0,creator,cohort,before:new Map(),fields:new Map((Object.keys(fields) as Field[]).map(field=>[field,[]])),extra:new Map()};owned=state;
   for(const row of rows){
    if(row.homeCellId!==creator.homeCellId || row.dataHomeRegion!==creator.dataHomeRegion || row.routingRevision!==creator.routingRevision || row.dataHomeAssignedAt!==creator.dataHomeAssignedAt)throw invalid();
    if(row===cohort)continue;
    const value=row.value as Value,address:Address={category:value.category,kind:value.kind,key:value.key};
    if(value.schemaVersion!==1 || !['canonical','command','entity'].includes(address.category) || typeof address.kind!=='string' || !address.kind || typeof address.key!=='string' || !address.key || row.key!==addressKey(address) || row.id!==identity(this.scope,address) || !value.payload || Array.isArray(value.payload) || typeof value.payload!=='object')throw invalid();
    const key=addressKey(address);if(state.before.has(key))throw invalid();const payload=json(value.payload);state.before.set(key,{address,row,payload});
    if(address.category==='canonical'){
     if(!Object.hasOwn(fields,address.kind))throw invalid();state.fields.get(address.kind as Field)!.push(payload);
    }else state.extra.set(key,{address,payload});
   }
   return this.context.run(state,async()=>{
    const initial=this.encode(state);
    if(initial.size!==state.before.size || [...initial].some(([key,value])=>!state.before.has(key)||publicationIdentityHash(value.payload)!==publicationIdentityHash(state.before.get(key)!.payload)))throw invalid();
    const result=await operation(transaction);
    if(state.rollbackOnly || state.pending)throw Error('Retained content cannot commit failed or unawaited operations.');
    await this.repositories.creators.checkRevision!(state.creator.id,state.creator.revision,{transaction});
    state.phase='closing';await this.flush(state);
    if(state.rollbackOnly)throw Error('Retained content cannot commit after a closing-scope failure.');
    return structuredClone(result);
   });
  });}finally{if(owned)owned.phase='closed';}
 }
 private encode(state:State):Map<string,{address:Address;payload:Value}>{
  const result=new Map(state.extra),workIds=new Set<string>(),assetIds=new Set<string>(),collectionIds=new Set<string>();
  for(const [field,values] of state.fields)for(const source of values){
   const payload=json(source);
   if(['works','canonicalAssets','creatorCollections'].includes(field)&&payload.creatorId!==this.scope.creatorId)throw invalid();
   if(payload.tenantId!==this.scope.tenantId || ('creatorId' in payload && payload.creatorId!==this.scope.creatorId))throw invalid();
   const keys=fields[field].map(key=>payload[key]);if(keys.some(key=>typeof key!=='string'||!key))throw invalid();
   const address:Address={category:'canonical',kind:field,key:JSON.stringify(keys)},key=addressKey(address);if(result.has(key))throw invalid();
   if(field==='works')workIds.add(payload.workId);if(field==='canonicalAssets')assetIds.add(payload.assetId);if(field==='creatorCollections')collectionIds.add(payload.collectionId);
   result.set(key,{address,payload});
  }
  for(const {address,payload} of result.values()){
   if('tenantId' in payload&&payload.tenantId!==this.scope.tenantId || 'creatorId' in payload&&payload.creatorId!==this.scope.creatorId)throw invalid();
   if(address.category!=='canonical')continue;
   if(['workAssets','publications','publicationIntents','workDiscovery','sourceReceipts'].includes(address.kind) && !workIds.has(payload.workId))throw invalid();
   if(address.kind==='workAssets' && !assetIds.has(payload.assetId))throw invalid();
   if(address.kind==='collectionWorks' && (!workIds.has(payload.workId)||!collectionIds.has(payload.collectionId)))throw invalid();
  }
  return result;
 }
 /** Read access and domain lifecycle policy are separate. Historical records
  * remain available to authorized readers during deletion; ordinary writes do not. */
 protected currentCreator():Readonly<CreatorRecord>{return Object.freeze(structuredClone(this.active().creator));}
 protected currentActor():string|undefined{return this.active().actor;}
 /** A domain maintenance adapter may authorize ONLY a narrowly validated delta.
  * The base store never grants a worker general Creator mutation authority. */
 protected mayCommitMaintenance(_changes:readonly RetainedRepositoryChange[]):boolean{return false;}
 protected mayAppendMaintenanceAudit(_event:Readonly<RetainedAuditEvent>):boolean{return false;}
 protected retainedEntityEntries<T>(kind:string):Array<{key:string;value:T}>{
  return [...this.active().extra.values()].filter(entry=>entry.address.category==='entity'&&entry.address.kind===kind).map(entry=>({key:entry.address.key,value:structuredClone(entry.payload) as T}));
 }
 protected async appendRetainedAudit(event:RetainedAuditEvent,subjectId?:string):Promise<void>{
  const state=this.active(),copy=json(event);
  if(typeof event.auditId!=='string'||!event.auditId||typeof event.action!=='string'||!event.action||!Number.isFinite(Date.parse(event.createdAt)))throw invalid();
  if((!state.actor||state.actor!==event.actorUserId)&&!this.mayAppendMaintenanceAudit(structuredClone(event)))throw new RetainedRepositoryError('access_denied','An actual actor or a scoped maintenance intent must own this audit.',403);
  await this.repositories.auditEvents.create({id:event.auditId,instanceId:this.scope.instanceId,...home(state.creator),action:event.action,
   ...(event.actorUserId?{actorId:event.actorUserId}:{}),...(subjectId?{subjectId}:{}),payload:{retainedCreatorId:this.scope.creatorId,retainedAudit:copy}},{transaction:state.transaction});
 }
 protected async readRetainedAudit<T extends RetainedAuditEvent>(id:string):Promise<T|null>{
  const state=this.active(),row=await this.repositories.auditEvents.get(id,{transaction:state.transaction});
  if(!row||row.instanceId!==this.scope.instanceId||row.homeCellId!==this.scope.cellId||row.dataHomeRegion!==this.scope.region||row.payload.retainedCreatorId!==this.scope.creatorId)return null;
  return structuredClone(row.payload.retainedAudit) as T??null;
 }
 private async flush(state:State):Promise<void>{
  const after=this.encode(state),changed=[...new Set([...state.before.keys(),...after.keys()])].filter(key=>publicationIdentityHash(state.before.get(key)?.payload)!==publicationIdentityHash(after.get(key)?.payload));
  if(!changed.length)return;
  if(state.actor&&'deletion' in state.creator&&state.creator.deletion)throw new RetainedRepositoryError('access_denied','Creator deletion is in progress.',403);
  if(!state.actor&&!this.mayCommitMaintenance(changed.map(key=>{
   const previous=state.before.get(key),next=after.get(key),address=next?.address??previous!.address;
   return {...address,...(previous?{previous:structuredClone(previous.payload)}:{}),...(next?{next:structuredClone(next.payload)}:{})};
  })))throw new RetainedRepositoryError('access_denied','An actual actor guard is required before changing retained content.',403);
  for(const key of changed){
   const before=state.before.get(key),next=after.get(key);
   if(!next){await this.repositories.hostRecords!.remove(before!.row.id,before!.row.revision,{transaction:state.transaction});continue;}
   const value={schemaVersion:1,...next.address,payload:next.payload};
   if(before)await this.repositories.hostRecords!.update(before.row.id,before.row.revision,{value},{transaction:state.transaction});
   else await this.repositories.hostRecords!.create({id:identity(this.scope,next.address),instanceId:this.scope.instanceId,...home(state.creator),namespace,scopeId:this.scope.creatorId,key,value},{transaction:state.transaction});
  }
  await this.repositories.hostRecords!.update(state.cohort.id,state.cohort.revision,{value:cohortValue(this.scope,[...after.values()].map(entry=>identity(this.scope,entry.address)))},{transaction:state.transaction});
 }
 private async getEntity(category:'entity'|'command',kind:string,key:string):Promise<any>{const address={category,kind,key};return structuredClone(this.active().extra.get(addressKey(address))?.payload);}
 private async listEntities(category:'entity'|'command',kind:string):Promise<any[]>{return [...this.active().extra.values()].filter(entry=>entry.address.category===category&&entry.address.kind===kind).sort((a,b)=>a.address.key.localeCompare(b.address.key)).map(entry=>structuredClone(entry.payload));}
 private async putEntity(category:'entity'|'command',kind:string,key:string,value:unknown):Promise<void>{if(typeof kind!=='string'||!kind||typeof key!=='string'||!key)throw invalid();const payload=json(value);if('tenantId' in payload&&payload.tenantId!==this.scope.tenantId || 'creatorId' in payload&&payload.creatorId!==this.scope.creatorId)throw invalid();const address={category,kind,key};this.active().extra.set(addressKey(address),{address,payload});}
 async getRetainedEntity<T>(kind:string,key:string):Promise<T|undefined>{return this.getEntity('entity',kind,key);}
 async listRetainedEntities<T>(kind:string):Promise<T[]>{return this.listEntities('entity',kind);}
 async putRetainedEntity(kind:string,key:string,value:unknown):Promise<void>{return this.putEntity('entity',kind,key,value);}
 private async _retainedEntityMutationActor():Promise<void>{
  const actor=this.currentActor();
  if(!actor||!await this.authorizeActor(actor,'edit'))throw new RetainedRepositoryError('access_denied','Current Creator editing authority is required for an entity mutation.',403);
 }
 private _retainedEntityAddress(kind:string,key:string):Address {
  if(typeof kind!=='string'||!kind||typeof key!=='string'||!key)throw new RetainedEntityMutationError('retained_entity_invalid','An exact entity kind and key are required.');
  return {category:'entity',kind,key};
 }
 private _retainedEntityScope(value:Value):void {
  if(Object.hasOwn(value,'tenantId')&&value.tenantId!==this.scope.tenantId||Object.hasOwn(value,'creatorId')&&value.creatorId!==this.scope.creatorId)
   throw new RetainedEntityMutationError('retained_entity_invalid','An entity mutation must retain its current tenant and Creator scope.');
 }
 /** Missing/stale source is a conflict, including a repeated successful call.
  * Absence is never interpreted as a historical success receipt. */
 async removeRetainedEntity(input:RetainedEntityRemoval):Promise<void>{
  await this._retainedEntityMutationActor();
  const address=this._retainedEntityAddress(input.kind,input.key),expected=json(input.expected);this._retainedEntityScope(expected);
  const state=this.active(),key=addressKey(address),current=state.extra.get(key);
  if(!current||publicationIdentityHash(current.payload)!==publicationIdentityHash(expected))throw new RetainedEntityMutationError('retained_entity_conflict','The complete original entity changed or is absent.');
  state.extra.delete(key);
 }
 /** Atomically move one full host-owned JSON entity inside the existing Raw
  * overlay. Distinct keys, full source match and absent target are mandatory.
  * No receipt or provider success is invented; repeated calls conflict. A host
  * publishing adapter must join its verified CONFIRMED result/remote binding
  * and operation ID to this SAME publicationAtomic transaction. */
 async moveRetainedEntity(input:RetainedEntityMove):Promise<void>{
  await this._retainedEntityMutationActor();
  const from=this._retainedEntityAddress(input.kind,input.fromKey),to=this._retainedEntityAddress(input.kind,input.toKey);
  if(input.fromKey===input.toKey)throw new RetainedEntityMutationError('retained_entity_invalid','An entity move requires distinct original and target keys.');
  const expected=json(input.expected),next=json(input.next);this._retainedEntityScope(expected);this._retainedEntityScope(next);
  for(const field of ['tenantId','creatorId'])if(Object.hasOwn(expected,field)!==Object.hasOwn(next,field))throw new RetainedEntityMutationError('retained_entity_invalid','An entity move cannot add or discard its ownership scope.');
  const state=this.active(),fromKey=addressKey(from),toKey=addressKey(to),current=state.extra.get(fromKey);
  if(!current||publicationIdentityHash(current.payload)!==publicationIdentityHash(expected)||state.extra.has(toKey))throw new RetainedEntityMutationError('retained_entity_conflict','The complete original entity changed or its target is occupied.');
  // No await between the two overlay changes. Flush performs the original-row
  // revision deletion, target absence creation and cohort CAS as one transaction.
  state.extra.delete(fromKey);state.extra.set(toKey,{address:to,payload:next});
 }
 protected override async validatePublication(previous:M['publication']|null,next:M['publication']):Promise<void>{
  assertPublicationDisclosureHistoryImmutable(previous,next);
  if(!previous?.command?.preparationVersion)return;
  for(const field of ['command','imageSelection','configurationRevision','unresolvedImageContext','activeOperationId','lastConfirmedImage'] as const)if(publicationIdentityHash(previous[field])!==publicationIdentityHash(next[field]))throw new PublicationImageError('publication_revision_conflict','Use the durable Publication command to change image settings or execution authority.');
  if(previous.remoteId && !previous.remoteId.startsWith('pending:') && next.remoteId!==previous.remoteId)throw new PublicationImageError('publication_identity_conflict','A compatibility observer cannot replace an established provider object.');
 }
 async createWorkIfAbsent(work:M['work']):Promise<boolean>{
  if(this.works.some(row=>row.tenantId===work.tenantId&&row.workId===work.workId))return false;
  this.works.push(structuredClone(work));return true;
 }
 async commitSharedWorkRevisions(changes:Array<{work:M['work'];expectedRevision:number}>):Promise<void>{
  if(!changes.length||changes.length>99)throw new CreatorContentCommitError('Choose at most 99 linked Works.');
  const ids=new Set<string>();
  for(const {work,expectedRevision} of changes){
   const previous=this.works.find(row=>row.tenantId===work.tenantId&&row.workId===work.workId);
   if(ids.has(work.workId)||work.tenantId!==this.scope.tenantId||work.creatorId!==this.scope.creatorId||!previous||previous.creatorId!==work.creatorId||previous.revision!==expectedRevision||work.revision!==expectedRevision+1||previous.slug!==work.slug||JSON.stringify(previous.slugHistory)!==JSON.stringify(work.slugHistory))throw new CreatorContentCommitError('A linked Work changed. Refresh before saving.');
   ids.add(work.workId);
  }
  const next=new Map(changes.map(change=>[change.work.workId,structuredClone(change.work)]));
  this.works=this.works.map(work=>next.get(work.workId)??work);
 }
 async listUbeeqWorksPage(tenantId:string,creatorId:string,options:UbeeqWorkPageOptions):Promise<UbeeqWorkPage<M['work']>>{
  validateUbeeqWorkPageOptions(options);
  const rows=this.works.filter(work=>work.tenantId===tenantId&&work.creatorId===creatorId&&(!options.after||ubeeqWorkSortKey(work)>ubeeqWorkSortKey(options.after))).sort((a,b)=>ubeeqWorkSortKey(a)<ubeeqWorkSortKey(b)?-1:ubeeqWorkSortKey(a)>ubeeqWorkSortKey(b)?1:0);
  const evaluated=rows.slice(0,options.limit),last=evaluated.at(-1);
  return {items:evaluated.filter(work=>work.status!=='deleted'),...(rows.length>evaluated.length&&last?{next:{updatedAt:last.updatedAt,workId:last.workId}}:{})};
 }
 override async commitPublicationOperation(input:Parameters<MemoryCreatorContentStore<M>['commitPublicationOperation']>[0]):Promise<void>{
  assertPublicationDisclosureHistoryImmutable(input.previous,input.next);
  return super.commitPublicationOperation(input);
 }
 async claimPublicationState(expected:M['publication'],next:M['publication'],expectedWorkRevision?:number):Promise<boolean>{
  await this.validatePublication(expected,next);
  const current=this.publications.find(row=>row.tenantId===expected.tenantId&&row.publicationId===expected.publicationId);
  if(expectedWorkRevision!==undefined&&!this.works.some(work=>work.tenantId===next.tenantId&&work.workId===next.workId&&work.creatorId===next.creatorId&&work.revision===expectedWorkRevision&&!work.deletedAt&&!work.archivedAt))return false;
  if(!current||JSON.stringify(current)!==JSON.stringify(expected)||next.publicationId!==expected.publicationId||next.workId!==expected.workId||next.creatorId!==expected.creatorId||next.tenantId!==expected.tenantId)return false;
  this.publications=this.publications.map(row=>row===current?structuredClone({...current,providerData:next.providerData}):row);return true;
 }
 override async listCanonicalAssetsByWork(tenantId:string,workId:string):Promise<Array<M['asset']&{attachment:M['attachment']}>>{
  return (await super.listCanonicalAssetsByWork(tenantId,workId)).map(asset=>({...asset,...(asset.attachment.replacedByAssetId?{replacedByAssetId:asset.attachment.replacedByAssetId}:{})}));
 }
 override async commitAssetAttachment(input:RetainedAssetAttachmentCommit<M>):Promise<void>{
  // The host checks its actual source record and saved actor in this same scope.
  await this.bindings.validateAssetAttachment(input);
  if(!input.replacement)return super.commitAssetAttachment(input);
  const {work,asset,attachment,replacement:{previousAsset:old}}=input;
  const fail=()=>{throw new CreatorContentCommitError('Work or image changed. Review the replacement again.');};
  if(work.archivedAt||work.deletedAt||asset.storage.mode!=='hosted'||!asset.storage.objectKey||!asset.sizeBytes||!/^[a-f0-9]{64}$/i.test(asset.checksumSha256??'')||old.tenantId!==work.tenantId||old.creatorId!==work.creatorId||old.kind!=='image'||old.status!=='ready'||old.deletedAt||old.replacedByAssetId||old.assetId===asset.assetId||asset.kind!=='image'||asset.status!=='ready'||!old.checksumSha256||!old.updatedAt||work.revision!==input.previousRevision+1||asset.tenantId!==work.tenantId||asset.creatorId!==work.creatorId||attachment.workId!==work.workId||attachment.assetId!==asset.assetId)return fail();
  const previous=this.works.find(row=>row.tenantId===work.tenantId&&row.workId===work.workId),current=this.canonicalAssets.find(row=>row.tenantId===old.tenantId&&row.assetId===old.assetId),member=this.workAssets.find(row=>row.tenantId===work.tenantId&&row.workId===work.workId&&row.assetId===old.assetId);
  if(!previous||previous.revision!==input.previousRevision||previous.creatorId!==work.creatorId||['archived','deleted'].includes(previous.status)||!member||member.replacedByAssetId||member.position!==attachment.position||!current||current.status!=='ready'||current.checksumSha256!==old.checksumSha256||current.updatedAt!==old.updatedAt||current.replacedByAssetId||current.deletedAt||this.canonicalAssets.some(row=>row.tenantId===asset.tenantId&&row.assetId===asset.assetId))return fail();
  this.works=this.works.map(row=>row===previous?structuredClone(work):row);
  this.canonicalAssets=[...this.canonicalAssets,structuredClone(asset)];
  this.workAssets=[...this.workAssets.map(row=>row===member?structuredClone({...member,replacedByAssetId:asset.assetId}):row),structuredClone({...attachment,tenantId:work.tenantId})];
 }
}
