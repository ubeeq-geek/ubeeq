import { createHash, randomUUID } from 'node:crypto';
import type { CreatorRecord, PersistenceTransaction, UbeeqRepositories } from '@ubeeq/persistence';

export class CreatorIntakeError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
export interface CreatorIntakeInput {
  instanceId: string; cellId: string; region: string; actorId: string;
  handle: string; displayName: string; idempotencyKey?: string;
}
/** The trusted creator factory and its optional host receipt share this transaction.
 * Lost replies recover the original record; retries never repeat preparation or
 * restore edited profile values. Unkeyed callers retain intentional new creation.
 */
export async function createIntakeCreator(repositories: UbeeqRepositories, input: CreatorIntakeInput,
  create: (transaction: PersistenceTransaction, id: string) => Promise<CreatorRecord>): Promise<CreatorRecord> {
  if (input.idempotencyKey === undefined) return repositories.transaction(transaction => create(transaction, randomUUID()));
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
  try {
    return await repositories.transaction(async transaction => {
      const existing = await recover(transaction); if (existing) return existing;
      const creator = await create(transaction, creatorId);
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
