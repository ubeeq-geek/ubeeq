import type {CreatorRecord, PersistenceTransaction, RevisionedRecord, RevisionedRepository, UbeeqRepositories} from './index.js';

export class CreatorContentAuthorityError extends Error {
  readonly code = 'creator_content_authority_conflict';
  readonly status = 409;
  constructor() { super('Use this Creator’s retained content writer. Changing content authority requires a fenced migration.'); }
}

/** Normal profile writes cannot switch storage authorities or delete a retained
 * Creator. Migration tools must use their separately fenced operator protocol. */
export function assertCreatorContentAuthorityChange(previous:CreatorRecord|undefined,next:CreatorRecord|undefined):void{
  if(next?.contentAuthority!==undefined&&next.contentAuthority!=='retained-v1')throw new CreatorContentAuthorityError();
  if(previous&&(next===undefined?Boolean(previous.contentAuthority):next.contentAuthority!==previous.contentAuthority))throw new CreatorContentAuthorityError();
}
export const compactCreatorContentRepositories=['works','assets','collections','workMemberships','publications','publicationIntents'] as const;

/** Keep ordinary repository callers from becoming a second writer for a retained
 * Creator. Low-level migration adapters remain operator-only; old binaries and
 * raw database writers must be quiesced before enabling the new authority.
 */
export function protectCreatorContentAuthority<T extends UbeeqRepositories>(repositories: T): T {
  const result = {...repositories};
  const protect = <R extends RevisionedRecord>(source: RevisionedRepository<R>, creatorRepository = false): RevisionedRepository<R> => {
    const check = async (record: R | undefined, next: Partial<R> | undefined, transaction: PersistenceTransaction) => {
      if (creatorRepository) {
        const previous=record as CreatorRecord|undefined;
        assertCreatorContentAuthorityChange(previous,next===undefined?undefined:{...record,...next} as unknown as CreatorRecord);
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
  for (const key of compactCreatorContentRepositories) {
    (result as any)[key] = protect(repositories[key] as RevisionedRepository<RevisionedRecord>);
  }
  return result;
}
