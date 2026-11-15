import { createHash, randomUUID } from 'node:crypto';
import {publicationIdentityHash,type CreatorRecord,type PersistenceTransaction,type UbeeqRepositories} from '@ubeeq/persistence';
import {prepareNewCreatorCollectionDirectory} from './creator-collections.js';

export class CreatorIntakeError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
export interface CreatorIntakeInput {
  instanceId: string; cellId: string; region: string; actorId: string;
  handle: string; displayName: string; idempotencyKey?: string;
}
export type NewCreatorIntakeRecord=Omit<CreatorRecord,'revision'|'createdAt'|'updatedAt'|'contentAuthority'>;
export type CreatorIntakeFactory=(input:{record:Readonly<NewCreatorIntakeRecord>;actorUserId:string;repositories:UbeeqRepositories;transaction:PersistenceTransaction})=>Promise<CreatorRecord>;
/** Trusted host preparation runs outside the accepting write transaction so a
 * complete guarded inventory can be captured. Only the returned writer receives
 * that transaction; HTTP data cannot select a writer or change the admitted ID. */
export type CreatorIntakePreparation=(input:{intent:Readonly<CreatorIntakeInput>;creatorId:string;repositories:UbeeqRepositories})=>Promise<CreatorIntakeFactory>;

/** Select storage at birth; the trusted factory must persist exactly the identity
 * admitted by the host. Its record, storage cohort and later host preparation all
 * join the original intake transaction. A returned object is not proof of a write.
 */
export async function persistIntakeCreator(repositories:UbeeqRepositories,record:NewCreatorIntakeRecord,actorUserId:string,transaction:PersistenceTransaction,factory?:CreatorIntakeFactory):Promise<CreatorRecord>{
 const requested=structuredClone(record);
 if(requested.subjectId!==actorUserId)throw new CreatorIntakeError(503,'creator_creation_invalid','Creator storage did not accept the requested identity.');
 if(await repositories.creators.get(requested.id,{transaction}))throw new CreatorIntakeError(409,'creator_intake_requires_reconciliation','This Creator already exists without the matching intake receipt.');
 const created=factory?await factory({record:Object.freeze(structuredClone(requested)),actorUserId,repositories,transaction}):await repositories.creators.create(requested,{transaction});
 const saved=await repositories.creators.get(requested.id,{transaction});
 if(!created||!saved||saved.revision!==1||publicationIdentityHash(saved)!==publicationIdentityHash(created)||Object.entries(requested).some(([key,value])=>publicationIdentityHash(saved[key as keyof CreatorRecord])!==publicationIdentityHash(value)))throw new CreatorIntakeError(503,'creator_creation_invalid','Creator storage did not accept the requested identity.');
 return saved;
}

/** The trusted creator factory and its optional host receipt share this transaction.
 * Lost replies recover the original record; retries never repeat preparation or
 * restore edited profile values. Unkeyed callers retain intentional new creation.
 */
export async function createIntakeCreator(repositories: UbeeqRepositories, input: CreatorIntakeInput,
  create: (transaction: PersistenceTransaction, id: string, preparedFactory?:CreatorIntakeFactory) => Promise<CreatorRecord>,
  prepareCreation?:CreatorIntakePreparation): Promise<CreatorRecord> {
  input=structuredClone(input);
  if(prepareCreation!==undefined&&typeof prepareCreation!=='function')throw new CreatorIntakeError(503,'creator_creation_invalid','Creator preparation requires a trusted function.');
  const prepare=async(id:string):Promise<CreatorIntakeFactory|undefined>=>{
    if(!prepareCreation)return;
    const factory=await prepareCreation({intent:Object.freeze(structuredClone(input)),creatorId:id,repositories});
    if(typeof factory!=='function')throw new CreatorIntakeError(503,'creator_creation_invalid','Creator preparation did not supply a trusted writer.');
    return factory;
  };
  const createNew=async(transaction:PersistenceTransaction,id:string,factory?:CreatorIntakeFactory)=>{
    const creator=await create(transaction,id,factory);
    if(repositories.hostRecords)await prepareNewCreatorCollectionDirectory(repositories,creator,transaction);
    return creator;
  };
  if (input.idempotencyKey === undefined) {
    const id=randomUUID(),factory=await prepare(id);
    return repositories.transaction(transaction=>createNew(transaction,id,factory));
  }
  if (typeof input.idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.idempotencyKey)) throw new CreatorIntakeError(400, 'invalid_creator_intent', 'Creator request identity is invalid.');
  const records = repositories.hostRecords;
  if (!records) throw new CreatorIntakeError(503, 'creator_intake_unavailable', 'Durable Creator request receipts are required.');
  const key = createHash('sha256').update(JSON.stringify([input.instanceId, input.actorId, input.idempotencyKey])).digest('hex');
  const creatorId = 'creator-' + key, receiptId = 'creator-intake-' + key;
  const recover = async (transaction: PersistenceTransaction): Promise<CreatorRecord | undefined> => {
    const receipt = await records.get(receiptId, { transaction });
    if (!receipt) return undefined;
    if (receipt.instanceId !== input.instanceId || receipt.homeCellId !== input.cellId || receipt.dataHomeRegion !== input.region
      || receipt.namespace !== 'runtime-creator-intake' || receipt.scopeId !== creatorId || receipt.key !== key || receipt.value.schemaVersion !== 1
      || receipt.value.actorId !== input.actorId || receipt.value.creatorId !== creatorId) throw new CreatorIntakeError(409, 'creator_intake_requires_reconciliation', 'The saved Creator request requires reconciliation.');
    if (receipt.value.handle !== input.handle || receipt.value.displayName !== input.displayName) throw new CreatorIntakeError(409, 'creator_intent_conflict', 'This Creator request identity already belongs to different profile details.');
    const creator = await repositories.creators.get(creatorId, { transaction });
    if (!creator || creator.instanceId !== input.instanceId || creator.subjectId !== input.actorId || creator.homeCellId !== input.cellId || creator.dataHomeRegion !== input.region) throw new CreatorIntakeError(409, 'creator_intake_requires_reconciliation', 'The saved Creator request requires reconciliation.');
    return creator;
  };
  // Receipt recovery precedes expensive host preparation. A replay never
  // captures a new snapshot, reinitializes defaults, or repeats financial birth.
  const existing=await repositories.transaction(transaction=>recover(transaction));
  if(existing)return existing;
  try {
    const factory=await prepare(creatorId);
    return await repositories.transaction(async transaction => {
      const existing = await recover(transaction); if (existing) return existing;
      const creator = await createNew(transaction, creatorId,factory);
      await records.create({ id: receiptId, instanceId: creator.instanceId, homeCellId: creator.homeCellId, dataHomeRegion: creator.dataHomeRegion,
        dataHomeAssignedAt: creator.dataHomeAssignedAt, routingRevision: creator.routingRevision, namespace: 'runtime-creator-intake', scopeId: creatorId, key,
        value: { schemaVersion: 1, actorId: input.actorId, creatorId, handle: input.handle, displayName: input.displayName } }, { transaction });
      return creator;
    });
  } catch (error) {
    const recovered = await repositories.transaction(transaction => recover(transaction)); if (recovered) return recovered;
    throw error;
  }
}
