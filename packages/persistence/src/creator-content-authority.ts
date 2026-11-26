import type {CreatorRecord, PersistenceTransaction, RevisionedRecord, RevisionedRepository, UbeeqRepositories} from './index.js';
import {AsyncLocalStorage} from 'node:async_hooks';
import {isDeepStrictEqual} from 'node:util';

interface CreatorMutationContext {coordinator:object;transactionId:string|undefined}
interface CreatorFinalizationScope extends CreatorMutationContext {expected:CreatorRecord;active:boolean;failed:boolean;failTransaction?:()=>void}
const finalizations=new AsyncLocalStorage<CreatorFinalizationScope>();
const coordinators=new WeakMap<object,object>();
/** Adapter construction only: register the actual port with its transaction
 * coordinator. This does not grant deletion authority or replace any method. */
export function registerCreatorContentFinalizationRepository<T extends RevisionedRepository<CreatorRecord>>(repository:T,coordinator:object):T{
  const previous=coordinators.get(repository);
  if(previous&&previous!==coordinator)throw new CreatorContentAuthorityError();
  coordinators.set(repository,coordinator);return repository;
}
const rejectCreatorAuthority=():never=>{
  const scope=finalizations.getStore();if(scope?.active){scope.failed=true;scope.failTransaction?.();}
  throw new CreatorContentAuthorityError();
};

export class CreatorContentAuthorityError extends Error {
  readonly code = 'creator_content_authority_conflict';
  readonly status = 409;
  constructor() { super('Use this Creator’s retained content writer. Changing or removing content authority requires its fenced lifecycle protocol.'); }
}

/** Normal profile writes cannot switch storage authorities or delete a retained
 * Creator. Migration tools must use their separately fenced operator protocol. */
export function assertCreatorContentAuthorityChange(previous:CreatorRecord|undefined,next:CreatorRecord|undefined,context?:CreatorMutationContext):void{
  const scope=finalizations.getStore();
  const removal=next===undefined&&previous&&scope?.active&&context?.coordinator===scope.coordinator&&context.transactionId===scope.transactionId&&isDeepStrictEqual(previous,scope.expected);
  if(next?.contentAuthority!==undefined&&next.contentAuthority!=='retained-v1')return rejectCreatorAuthority();
  if(previous&&(next===undefined?Boolean(previous.contentAuthority)&&!removal:next.contentAuthority!==previous.contentAuthority))return rejectCreatorAuthority();
}
export const compactCreatorContentRepositories=['works','assets','collections','workMemberships','publications','publicationIntents'] as const;

/** Final storage primitive for a trusted host's fenced empty-Creator removal.
 * The host must bind its current initiating principal, durable deletion marker,
 * complete domain inventories and factual archive inside authorize. This API
 * neither removes content nor infers that a Creator is empty. Its private permit
 * admits only this exact record on the actual coordinator/accepting transaction;
 * ordinary repository removal and detached use remain forbidden. */
export async function finalizeRetainedCreatorRemoval(repositories:UbeeqRepositories,input:{expected:Readonly<CreatorRecord>;authorize:(creator:Readonly<CreatorRecord>,transaction:PersistenceTransaction)=>Promise<void>}):Promise<void>{
  const expected=structuredClone(input.expected),repository=repositories.creators,coordinator=coordinators.get(repository);
  if(!coordinator||expected.contentAuthority!=='retained-v1'||!Number.isSafeInteger(expected.revision)||expected.revision<1||typeof input.authorize!=='function'||finalizations.getStore()?.active)throw new CreatorContentAuthorityError();
  await repositories.transaction(async transaction=>{
    if(typeof transaction.id!=='string'||!transaction.id)throw new CreatorContentAuthorityError();
    const actual=await repository.get(expected.id,{transaction});
    if(!isDeepStrictEqual(actual,expected))throw new CreatorContentAuthorityError();
    await input.authorize(Object.freeze(structuredClone(expected)),transaction);
    if(!isDeepStrictEqual(await repository.get(expected.id,{transaction}),expected))throw new CreatorContentAuthorityError();
    const scope:CreatorFinalizationScope={expected,coordinator,transactionId:transaction.id,active:true,failed:false,failTransaction:repository.failTransaction?.bind(repository)};
    try{await finalizations.run(scope,()=>repository.remove(expected.id,expected.revision,{transaction}));if(scope.failed)throw new CreatorContentAuthorityError();}
    finally{scope.active=false;}
  });
}

/** Keep ordinary repository callers from becoming a second writer for a retained
 * Creator. Low-level migration adapters remain operator-only; old binaries and
 * raw database writers must be quiesced before enabling the new authority.
 */
export function protectCreatorContentAuthority<T extends UbeeqRepositories>(repositories: T): T {
  const result = {...repositories};
  const coordinator=coordinators.get(repositories.creators)??repositories.transaction;
  const protect = <R extends RevisionedRecord>(source: RevisionedRepository<R>, creatorRepository = false): RevisionedRepository<R> => {
    const check = async (record: R | undefined, next: Partial<R> | undefined, transaction: PersistenceTransaction) => {
      if (creatorRepository) {
        const previous=record as CreatorRecord|undefined;
        assertCreatorContentAuthorityChange(previous,next===undefined?undefined:{...record,...next} as unknown as CreatorRecord,{coordinator,transactionId:transaction.id});
        return;
      }
      const value = {...record, ...next} as Record<string, unknown>;
      const oldCreatorId = (record as Record<string, unknown> | undefined)?.creatorId;
      if (typeof oldCreatorId === 'string' && (await repositories.creators.get(oldCreatorId, {transaction}))?.contentAuthority === 'retained-v1') throw new CreatorContentAuthorityError();
      let creatorId = value.creatorId;
      if (!creatorId && typeof value.workId === 'string') creatorId = (await repositories.works.get(value.workId, {transaction}))?.creatorId;
      if (!creatorId && typeof value.collectionId === 'string') creatorId = (await repositories.collections.get(value.collectionId, {transaction}))?.creatorId;
      if (typeof creatorId !== 'string') return;
      const creator = await repositories.creators.get(creatorId, {transaction});
      if (creator?.contentAuthority === 'retained-v1') throw new CreatorContentAuthorityError();
    };
    // Capture the underlying methods once. Hosts may decorate the returned port
    // for fault injection/observability without changing what a saved method calls.
    const create=source.create.bind(source),update=source.update.bind(source),remove=source.remove.bind(source);
    const port:RevisionedRepository<R>={
      get:source.get.bind(source),list:source.list.bind(source),
      ...(source.snapshot?{snapshot:source.snapshot.bind(source)}:{}),
      ...(source.checkRevision?{checkRevision:source.checkRevision.bind(source)}:{}),
      ...(source.checkAbsent?{checkAbsent:source.checkAbsent.bind(source)}:{}),
      create:(record,options)=>repositories.transaction(async transaction=>{
        if(options?.transaction&&options.transaction.id!==transaction.id)throw new Error('Transaction handle is not active on this repository context.');
        await check(undefined,record as Partial<R>,transaction);
        return create(record,{...options,transaction});
      }),
      update:(id,revision,change,options)=>repositories.transaction(async transaction=>{
        if(options?.transaction&&options.transaction.id!==transaction.id)throw new Error('Transaction handle is not active on this repository context.');
        await check(await source.get(id,{transaction}),change as Partial<R>,transaction);
        return update(id,revision,change,{...options,transaction});
      }),
      remove:(id,revision,options)=>repositories.transaction(async transaction=>{
        if(options?.transaction&&options.transaction.id!==transaction.id)throw new Error('Transaction handle is not active on this repository context.');
        await check(await source.get(id,{transaction}),undefined,transaction);
        return remove(id,revision,{...options,transaction});
      })
    };
    return Object.assign(Object.create(source),port);
  };
  result.creators = protect(repositories.creators, true);
  registerCreatorContentFinalizationRepository(result.creators,coordinator);
  for (const key of compactCreatorContentRepositories) {
    (result as any)[key] = protect(repositories[key] as RevisionedRepository<RevisionedRecord>);
  }
  return result;
}
