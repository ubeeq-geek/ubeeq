import {createHash,randomUUID} from 'node:crypto';
import {CreatorCollectionError, normalizeContentSlug, type CreatorCollectionMembership, type CreatorCollectionPort, type CreatorCollectionRecord} from '@ubeeq/core';
import {repositoryItems, type AssetRecord, type CollectionRecord, type CreatorRecord, type HostRecord, type PersistenceTransaction, type UbeeqRepositories} from '@ubeeq/persistence';
import {requireCreatorScopedObject,type StoredObject} from '@ubeeq/storage';

export interface RuntimeCollection extends CreatorCollectionRecord {
  id:string; title:string; description?:string; type:'collection'|'gallery'|'series'|'playlist';
  visibility:'private'|'unlisted'|'public'; createdAt:string; revision:number;
  status:'draft'|'published'|'archived'|'deleted'; workPublicationHistoryAt?:string;
  archivedAt?:string; deletedAt?:string; managementReady:boolean;
}
interface ManagedCollection extends CollectionRecord {
  slug:string; slugHistory:string[]; status:RuntimeCollection['status']; type:RuntimeCollection['type'];
  description?:string; coverAssetId?:string; archivedAt?:string; deletedAt?:string; workPublicationHistoryAt?:string;
  collectionManagement:{schemaVersion:1; members:CreatorCollectionMembership[]};
}
export class CollectionManagementError extends Error {
  constructor(readonly code:'collection_migration_required'|'collection_state_invalid'|'collection_history_requires_archive'|'invalid_collection'|'collection_too_large'|'collection_intent_conflict',message:string){super(message);}
}
const namespace='runtime-collection-directory';
const directoryId=(instanceId:string,creatorId:string)=>'collection-directory-'+createHash('sha256').update(JSON.stringify([instanceId,creatorId])).digest('hex');
const home=(r:CreatorRecord)=>({homeCellId:r.homeCellId,dataHomeRegion:r.dataHomeRegion,dataHomeAssignedAt:r.dataHomeAssignedAt,routingRevision:r.routingRevision});
const boundedAggregate=(value:unknown)=>{
  if(Buffer.byteLength(JSON.stringify(value))>300*1024)throw new CollectionManagementError('collection_too_large','Collection management exceeds the safe aggregate size. Split the collection or reconcile the library before continuing.');
};
const validMembers=(members:unknown,id:string):members is CreatorCollectionMembership[]=>Array.isArray(members)&&members.every((m,i)=>m&&m.collectionId===id&&typeof m.workId==='string'&&m.workId.length>0&&m.position===i&&typeof m.addedAt==='string'&&Number.isFinite(Date.parse(m.addedAt)))&&new Set(members.map(m=>m.workId)).size===members.length;

/** Imports preserve their opaque data, but cannot assert management authority.
 * Known imported IDs are included immediately, without depending on a GSI's
 * visibility. Reconciliation must prove the complete inventory under a writer
 * fence before the directory can be used for advanced management again. */
export async function invalidateCollectionDirectoryForImport(repositories:UbeeqRepositories,creator:CreatorRecord,collectionIds:readonly string[],transaction:PersistenceTransaction){
  if(!collectionIds.length||!repositories.hostRecords)return;
  const id=directoryId(creator.instanceId,creator.id),old=await repositories.hostRecords.get(id,{transaction});
  if(old&&(old.namespace!==namespace||old.instanceId!==creator.instanceId||old.scopeId!==creator.id||!Array.isArray(old.value.collectionIds)))throw new CollectionManagementError('collection_state_invalid','Collection directory requires reconciliation.');
  const value={schemaVersion:1,collectionIds:[...new Set([...(old?.value.collectionIds as string[]??[]),...collectionIds])],requiresMigration:true};boundedAggregate(value);
  if(old)await repositories.hostRecords.update(old.id,old.revision,{value},{transaction});
  else await repositories.hostRecords.create({id,instanceId:creator.instanceId,...home(creator),namespace,scopeId:creator.id,key:'directory',value},{transaction});
}

/** Work deletion/ownership migration and membership validation share this fence.
 * Keeping the fence separate from the Creator avoids changing billing authority
 * merely because a library is edited. Legacy libraries have no such directory. */
export async function withCollectionWorkLifecycleFence<T>(repositories:UbeeqRepositories,scope:{instanceId:string;cellId:string;region:string},creatorId:string,
  operation:(transaction:PersistenceTransaction)=>Promise<T>):Promise<T>{
  return repositories.transaction(async transaction=>{
    const records=repositories.hostRecords,d=await records?.get(directoryId(scope.instanceId,creatorId),{transaction});
    if(d&&(d.instanceId!==scope.instanceId||d.homeCellId!==scope.cellId||d.dataHomeRegion!==scope.region||d.namespace!==namespace||d.scopeId!==creatorId||d.key!=='directory'||d.value.schemaVersion!==1))
      throw new CollectionManagementError('collection_state_invalid','Collection lifecycle fence requires reconciliation.');
    const result=await operation(transaction);
    if(d)await records!.update(d.id,d.revision,{value:{...d.value}},{transaction});
    return result;
  });
}

/** Only the trusted new-Creator factory calls this in the Creator's creation
 * transaction. Existing/imported libraries require an explicit fenced migration;
 * an eventually consistent index must never be used to prove an empty library. */
export async function prepareNewCreatorCollectionDirectory(repositories:UbeeqRepositories,creator:CreatorRecord,transaction:PersistenceTransaction){
  if(!repositories.hostRecords)throw new Error('Collection directories require durable host records.');
  const current=await repositories.creators.get(creator.id,{transaction});
  if(!current||current.instanceId!==creator.instanceId||current.subjectId!==creator.subjectId||current.revision!==creator.revision
    ||current.homeCellId!==creator.homeCellId)throw new Error('Collection directory must share the actual Creator creation transaction.');
  await repositories.hostRecords.create({id:directoryId(creator.instanceId,creator.id),instanceId:creator.instanceId,...home(creator),
    namespace,scopeId:creator.id,key:'directory',value:{schemaVersion:1,collectionIds:[]}}, {transaction});
}

/** A request receipt records the original intent, independently of later edits.
 * Retrying a lost reply returns the current collection and rechecks present-day
 * authority; it never runs slug creation again or restores old metadata. */
export async function createCollectionFromIntent(repositories:UbeeqRepositories,store:RepositoryCreatorCollectionStore,
  input:{instanceId:string;cellId:string;region:string;creatorId:string;actorId:string;idempotencyKey?:string;details:Record<string,unknown>},
  create:(id:string)=>Promise<unknown>):Promise<RuntimeCollection>{
  if(input.idempotencyKey!==undefined&&(typeof input.idempotencyKey!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(input.idempotencyKey)))throw new CollectionManagementError('invalid_collection','Collection request identity is invalid.');
  if(input.idempotencyKey===undefined){const id=randomUUID();await create(id);return(await store.getCreatorCollection(input.instanceId,id))!;}
  const records=repositories.hostRecords!;
  const key=createHash('sha256').update(JSON.stringify([input.instanceId,input.creatorId,input.actorId,input.idempotencyKey])).digest('hex');
  const id='collection-'+key,receiptId='collection-intake-'+key,intent=JSON.stringify(input.details);
  const recover=async(transaction:PersistenceTransaction)=>{
    const receipt=await records.get(receiptId,{transaction});if(!receipt)return undefined;
    if(receipt.instanceId!==input.instanceId||receipt.homeCellId!==input.cellId||receipt.dataHomeRegion!==input.region||receipt.namespace!=='runtime-collection-intake'
      ||receipt.scopeId!==input.creatorId||receipt.key!==key||receipt.value.schemaVersion!==1||receipt.value.collectionId!==id||receipt.value.actorId!==input.actorId)
      throw new CollectionManagementError('collection_state_invalid','The saved collection request requires reconciliation.');
    if(receipt.value.intent!==intent)throw new CollectionManagementError('collection_intent_conflict','This request identity already belongs to different collection details.');
    await store.requireMutationAccess(input.creatorId,transaction);
    const c=await repositories.collections.get(id,{transaction});
    if(!c||c.creatorId!==input.creatorId||c.instanceId!==input.instanceId||c.homeCellId!==input.cellId||c.dataHomeRegion!==input.region)throw new CollectionManagementError('collection_state_invalid','The saved collection request requires reconciliation.');
    return c;
  };
  try{
    await repositories.transaction(async transaction=>{
      if(await recover(transaction))return;
      await create(id);
      const creator=await repositories.creators.get(input.creatorId,{transaction});if(!creator)throw new CreatorCollectionError('not_found','Creator not found.');
      await records.create({id:receiptId,instanceId:input.instanceId,...home(creator),namespace:'runtime-collection-intake',scopeId:input.creatorId,key,
        value:{schemaVersion:1,collectionId:id,actorId:input.actorId,intent}},{transaction});
    });
  }catch(error){if(!await repositories.transaction(recover))throw error;}
  return(await store.getCreatorCollection(input.instanceId,id))!;
}

/** Compatibility-domain operations on the runtime's existing repositories.
 * The directory is an atomic per-Creator fence and complete ID inventory, not
 * another collection store. All slug checks use strong point reads, never a GSI
 * scan inside a transaction. Membership is one revisioned aggregate so arbitrary
 * ordering does not require an unbounded multi-item transaction.
 *
 * authorizeMutation MUST check current authority with commit-time guards in the
 * supplied transaction. Commercial hosts can join it through their store's
 * nested transaction runner; no request-supplied actor/role is accepted here. */
export class RepositoryCreatorCollectionStore implements CreatorCollectionPort<RuntimeCollection> {
  readonly supportsAtomicCollectionSlugs=true;
  readonly supportsExpectedCollectionOrder=true;
  readonly supportsExpectedCollectionStatus=true;
  readonly supportsExpectedCollectionRevision=true;
  readonly supportsExpectedMembershipRevision=true;
  readonly supportsCollectionCoverValidation=true;
  constructor(private readonly repositories:UbeeqRepositories,private readonly scope:{instanceId:string;cellId:string;region:string},
    private readonly authorizeMutation:(creator:CreatorRecord,transaction:PersistenceTransaction)=>Promise<void>){
    if(!repositories.hostRecords||typeof authorizeMutation!=='function')throw new Error('Durable collection storage and transaction-bound authorization are required.');
  }
  private local(r:{instanceId:string;homeCellId:string;dataHomeRegion:string}|undefined){return r?.instanceId===this.scope.instanceId&&r.homeCellId===this.scope.cellId&&r.dataHomeRegion===this.scope.region;}
  private tenant(tenantId:string){if(tenantId!==this.scope.instanceId)throw new CreatorCollectionError('access_denied','Collection access denied.');}
  private async creator(creatorId:string,transaction:PersistenceTransaction){
    const c=await this.repositories.creators.get(creatorId,{transaction});
    if(!this.local(c))throw new CreatorCollectionError('not_found','Creator not found.');
    await this.authorizeMutation(c!,transaction);return c!;
  }
  async requireMutationAccess(creatorId:string,transaction:PersistenceTransaction){return this.creator(creatorId,transaction);}
  private validate(c:RuntimeCollection){
    if(!c.collectionId||c.id!==c.collectionId||!c.creatorId||typeof c.title!=='string'||!c.title.trim()||c.title.length>500
      ||typeof c.slug!=='string'||!c.slug||c.slug!==normalizeContentSlug(c.slug,{fallback:'collection',maxLength:160})
      ||!Array.isArray(c.slugHistory)||c.slugHistory.some(s=>typeof s!=='string'||!s||s.length>160)
      ||!['collection','gallery','series','playlist'].includes(c.type)||!['private','unlisted','public'].includes(c.visibility)
      ||!['draft','published','archived','deleted'].includes(c.status)||c.description!==undefined&&(typeof c.description!=='string'||c.description.length>50000)
      ||c.coverAssetId!==undefined&&(typeof c.coverAssetId!=='string'||!c.coverAssetId))throw new CollectionManagementError('invalid_collection','Collection details are invalid.');
  }
  private async directory(creatorId:string,transaction?:PersistenceTransaction):Promise<HostRecord|undefined>{
    const r=await this.repositories.hostRecords!.get(directoryId(this.scope.instanceId,creatorId),transaction?{transaction}:undefined);
    if(!r)return undefined;
    const ids=r.value.collectionIds;
    if(!this.local(r)||r.namespace!==namespace||r.scopeId!==creatorId||r.key!=='directory'||r.value.schemaVersion!==1
      ||r.value.requiresMigration!==undefined&&typeof r.value.requiresMigration!=='boolean'||!Array.isArray(ids)||ids.some(id=>typeof id!=='string'||!id)||new Set(ids).size!==ids.length)throw new CollectionManagementError('collection_state_invalid','Collection directory requires reconciliation.');
    return r;
  }
  private async requiredDirectory(creatorId:string,transaction:PersistenceTransaction){
    const d=await this.directory(creatorId,transaction);
    if(!d||d.value.requiresMigration)throw new CollectionManagementError('collection_migration_required','This library needs a reviewed collection migration before management is enabled.');
    return d;
  }
  async isManagementReady(creatorId:string){const d=await this.directory(creatorId);return Boolean(d&&!d.value.requiresMigration);}
  private async managed(tenantId:string,id:string,transaction:PersistenceTransaction){
    this.tenant(tenantId);const c=await this.repositories.collections.get(id,{transaction}) as ManagedCollection|undefined;
    if(!this.local(c))throw new CreatorCollectionError('not_found','Collection not found.');
    const d=await this.requiredDirectory(c!.creatorId,transaction);
    if(!(d.value.collectionIds as string[]).includes(id)||c!.collectionManagement?.schemaVersion!==1||!validMembers(c!.collectionManagement.members,id))
      throw new CollectionManagementError('collection_migration_required','This collection needs a reviewed migration before management is enabled.');
    return {collection:c!,directory:d};
  }
  private async fence(d:HostRecord,transaction:PersistenceTransaction,collectionIds=d.value.collectionIds as string[]){
    boundedAggregate({collectionIds});
    await this.repositories.hostRecords!.update(d.id,d.revision,{value:{...d.value,collectionIds}}, {transaction});
  }
  private async unique(d:HostRecord,c:Pick<RuntimeCollection,'collectionId'|'slug'|'slugHistory'|'status'|'creatorId'>,transaction:PersistenceTransaction){
    if(c.status==='deleted')return;
    const aliases=new Set([c.slug,...c.slugHistory]);
    for(const id of d.value.collectionIds as string[]){
      if(id===c.collectionId)continue;
      const other=await this.repositories.collections.get(id,{transaction}) as ManagedCollection|undefined;
      if(!this.local(other)||other!.creatorId!==c.creatorId||!Array.isArray(other!.slugHistory)||typeof other!.slug!=='string')throw new CollectionManagementError('collection_state_invalid','Collection directory ownership requires reconciliation.');
      if(other!.status!=='deleted'&&[other!.slug,...other!.slugHistory].some(alias=>aliases.has(alias)))throw new CreatorCollectionError('slug_conflict','Collection slug is already in use.');
    }
  }
  private async cover(c:Pick<RuntimeCollection,'creatorId'|'coverAssetId'|'status'>,transaction:PersistenceTransaction){
    if(!c.coverAssetId||c.status==='deleted')return;
    const a=await this.repositories.assets.get(c.coverAssetId,{transaction}) as (AssetRecord&{storage?:StoredObject;originalStorage?:StoredObject})|undefined;
    const source=a?.originalStorage??a?.storage;
    if(!this.local(a)||a!.creatorId!==c.creatorId||a!.status!=='ready'||!a!.mimeType.startsWith('image/')||source?.scope!=='private'||!source.bucket||!Number.isSafeInteger(source.byteLength)||source.byteLength<1)
      throw new CreatorCollectionError('invalid_cover','Choose an active private image owned by this Creator.');
    try{requireCreatorScopedObject(source.key,{cellId:this.scope.cellId,creatorId:c.creatorId});}catch{throw new CreatorCollectionError('invalid_cover','Cover source custody requires reconciliation.');}
    if(!this.repositories.assets.checkRevision)throw new Error('Collection covers require commit-time asset guards.');
    await this.repositories.assets.checkRevision(a!.id,a!.revision,{transaction});
  }
  async getProcessingAsset(tenantId:string,assetId:string){
    this.tenant(tenantId);const a=await this.repositories.assets.get(assetId) as (AssetRecord&{storage?:StoredObject;originalStorage?:StoredObject})|undefined;
    const source=a?.originalStorage??a?.storage;
    return this.local(a)&&source?{tenantId,creatorId:a!.creatorId,assetId:a!.id,status:a!.status,storage:{scope:source.scope}}:null;
  }
  async getWork(tenantId:string,workId:string){
    this.tenant(tenantId);const w=await this.repositories.works.get(workId);
    return this.local(w)?{tenantId,creatorId:w!.creatorId,workId:w!.id,status:w!.status}:null;
  }
  private async view(c:CollectionRecord):Promise<RuntimeCollection>{
    const r=c as ManagedCollection,d=await this.directory(c.creatorId);
    return {...r,id:r.id,tenantId:r.instanceId,collectionId:r.id,slug:r.slug??r.id,slugHistory:r.slugHistory??[],
      status:r.status??'draft',type:r.type??'collection',managementReady:Boolean(d&&!d.value.requiresMigration&&(d.value.collectionIds as string[]).includes(c.id)&&r.collectionManagement?.schemaVersion===1&&validMembers(r.collectionManagement.members,r.id))};
  }
  async getCreatorCollection(tenantId:string,id:string){this.tenant(tenantId);const c=await this.repositories.collections.get(id);return this.local(c)?this.view(c!):null;}
  async listCreatorCollections(tenantId:string,creatorId:string,options:{includeDeleted?:boolean}={}){
    this.tenant(tenantId);const d=await this.directory(creatorId),rows:CollectionRecord[]=[];
    if(d){for(const id of d.value.collectionIds as string[]){const c=await this.repositories.collections.get(id);if(!this.local(c)||c!.creatorId!==creatorId)throw new CollectionManagementError('collection_state_invalid','Collection directory requires reconciliation.');rows.push(c!);}}
    // The directory supplies strong reads; the index also discovers unmanaged
    // legacy rows. An incomplete directory must never hide existing content.
    const known=new Set(rows.map(c=>c.id));
    for await(const c of repositoryItems(request=>this.repositories.collections.list(request)))if(this.local(c)&&c.creatorId===creatorId&&!known.has(c.id))rows.push(c);
    return Promise.all(rows.filter(c=>options.includeDeleted||(c as ManagedCollection).status!=='deleted').map(c=>this.view(c)));
  }
  async createCreatorCollection(c:RuntimeCollection){
    this.tenant(c.tenantId);this.validate(c);if(c.status!=='draft')throw new CollectionManagementError('collection_state_invalid','New collections start as drafts.');
    await this.repositories.transaction(async transaction=>{
      const creator=await this.creator(c.creatorId,transaction),d=await this.requiredDirectory(c.creatorId,transaction);
      await this.unique(d,c,transaction);await this.cover(c,transaction);
      await this.repositories.collections.create({id:c.collectionId,instanceId:c.tenantId,...home(creator),creatorId:c.creatorId,title:c.title,
        visibility:c.visibility,slug:c.slug,slugHistory:[...new Set([...c.slugHistory,c.slug])],type:c.type,status:'draft',description:c.description,
        coverAssetId:c.coverAssetId,collectionManagement:{schemaVersion:1,members:[]}} as Omit<ManagedCollection,'revision'|'createdAt'|'updatedAt'>,{transaction});
      await this.fence(d,transaction,[...(d.value.collectionIds as string[]),c.collectionId]);
    });
  }
  async updateCreatorCollection(c:RuntimeCollection,expectedStatus?:string,expectedRevision?:number){
    this.validate(c);
    if(!Number.isSafeInteger(expectedRevision)||expectedRevision! < 1||expectedRevision! >= Number.MAX_SAFE_INTEGER)throw new CreatorCollectionError('revision_conflict','A current collection revision is required.');
    await this.repositories.transaction(async transaction=>{
      const {collection:old,directory:d}=await this.managed(c.tenantId,c.collectionId,transaction);
      if(old.creatorId!==c.creatorId)throw new CreatorCollectionError('immutable_owner','Collection ownership cannot be changed.');
      await this.creator(old.creatorId,transaction);
      if(old.revision!==expectedRevision||expectedStatus!==undefined&&old.status!==expectedStatus)throw new CreatorCollectionError('revision_conflict','Collection changed; refresh before saving.');
      if(old.status==='deleted'){
        if(c.status==='deleted')return;
        throw new CollectionManagementError('collection_state_invalid','Deleted collections cannot be restored.');
      }
      if(c.status==='published'&&old.status!=='published')throw new CollectionManagementError('collection_state_invalid','Use the collection publication workflow to change release state.');
      if(c.status==='deleted'&&old.workPublicationHistoryAt)throw new CollectionManagementError('collection_history_requires_archive','Works have been published to this collection. Archive it instead of deleting it.');
      if(c.status==='archived'&&!old.workPublicationHistoryAt)throw new CollectionManagementError('collection_state_invalid','No Works have been published to this collection. Delete it instead of archiving it.');
      const history=[...new Set([...old.slugHistory,old.slug,c.slug])];
      boundedAggregate({...old,...c,slugHistory:history});
      await this.unique(d,{...c,slugHistory:history},transaction);await this.cover(c,transaction);
      await this.repositories.collections.update(old.id,old.revision,{title:c.title,type:c.type,description:c.description,coverAssetId:c.coverAssetId,
        visibility:c.visibility,slug:c.slug,slugHistory:history,status:c.status,archivedAt:c.status==='archived'?old.archivedAt??new Date().toISOString():undefined,
        deletedAt:c.status==='deleted'?new Date().toISOString():undefined} as Partial<ManagedCollection>,{transaction});
      await this.fence(d,transaction);
    });
  }
  async listCollectionWorks(tenantId:string,id:string){
    const c=await this.getCreatorCollection(tenantId,id);if(!c)throw new CreatorCollectionError('not_found','Collection not found.');
    if(c.managementReady)return structuredClone((c as unknown as ManagedCollection).collectionManagement.members);
    const aggregate=(c as unknown as ManagedCollection).collectionManagement;
    if(aggregate?.schemaVersion===1&&validMembers(aggregate.members,id)){
      // Migration gates writes, not visibility of saved ordering. Imported
      // aggregates remain untrusted: show only point-read Works still owned by
      // this Creator, without adopting the aggregate or its directory authority.
      const members:CreatorCollectionMembership[]=[];
      for(let start=0;start<aggregate.members.length;start+=8){
        const reads=await Promise.allSettled(aggregate.members.slice(start,start+8).map(async member=>{
          const work=await this.repositories.works.get(member.workId);
          return this.local(work)&&work!.creatorId===c.creatorId?structuredClone(member):undefined;
        }));
        for(const result of reads){if(result.status==='rejected')throw result.reason;if(result.value)members.push(result.value);}
      }
      return members;
    }
    const members:CreatorCollectionMembership[]=[];
    for await(const m of repositoryItems(request=>this.repositories.workMemberships.list(request)))if(this.local(m)&&m.collectionId===id){
      const work=await this.repositories.works.get(m.workId);if(this.local(work)&&work!.creatorId===c.creatorId)members.push({collectionId:id,workId:m.workId,position:m.position,addedAt:m.createdAt});
    }
    return members.sort((a,b)=>a.position-b.position);
  }
  async replaceCollectionWorks(tenantId:string,id:string,members:CreatorCollectionMembership[],expectedWorkIds?:readonly string[],expectedRevision?:number){
    if(!expectedWorkIds)throw new CreatorCollectionError('revision_conflict','The current collection order is required.');
    await this.repositories.transaction(async transaction=>{
      const {collection:c,directory:d}=await this.managed(tenantId,id,transaction);await this.creator(c.creatorId,transaction);
      if(expectedRevision!==undefined&&(!Number.isSafeInteger(expectedRevision)||expectedRevision<1||expectedRevision>=Number.MAX_SAFE_INTEGER||c.revision!==expectedRevision))throw new CreatorCollectionError('revision_conflict','Collection changed; refresh before saving.');
      if(c.status==='deleted')throw new CreatorCollectionError('not_found','Collection not found.');
      const old=c.collectionManagement.members;
      if(JSON.stringify(old.map(m=>m.workId))!==JSON.stringify(expectedWorkIds))throw new CreatorCollectionError('revision_conflict','Collection order changed; refresh before saving.');
      if(!validMembers(members,id))throw new CreatorCollectionError('invalid_works','Ordered, unique Works with valid membership dates are required.');
      boundedAggregate({...c,collectionManagement:{schemaVersion:1,members}});
      // Work deletion/migration must use withCollectionWorkLifecycleFence. The
      // directory CAS then covers every validated member without a 100-item
      // transaction limit on ordering. Reads are bounded to eight at a time.
      for(let start=0;start<members.length;start+=8){
        const reads=await Promise.allSettled(members.slice(start,start+8).map(async(m,offset)=>{
          const w=await this.repositories.works.get(m.workId,{transaction});
          if(m.collectionId!==id||m.position!==start+offset||!this.local(w)||w!.creatorId!==c.creatorId||w!.status==='deleted')throw new CreatorCollectionError('invalid_works','Choose active Works owned by this Creator.');
        }));
        for(const result of reads)if(result.status==='rejected')throw result.reason;
      }
      const prior=new Map(old.map(m=>[m.workId,m]));
      await this.repositories.collections.update(c.id,c.revision,{collectionManagement:{schemaVersion:1,members:members.map(m=>({...m,addedAt:prior.get(m.workId)?.addedAt??m.addedAt}))}} as Partial<ManagedCollection>,{transaction});
      await this.fence(d,transaction);
    });
  }
}
