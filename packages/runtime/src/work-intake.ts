import { createHash, randomUUID } from 'node:crypto';
import type { CreatorRecord, PersistenceTransaction, UbeeqRepositories, WorkRecord } from '@ubeeq/persistence';

export class WorkIntakeError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

/** Commit the draft and its request receipt together; an uncertain reply never creates a second draft. */
export async function createIntakeWork(repositories: UbeeqRepositories, creator: CreatorRecord, actorId: string, title: string, idempotencyKey?: string): Promise<WorkRecord> {
  const home = { homeCellId:creator.homeCellId, dataHomeRegion:creator.dataHomeRegion, dataHomeAssignedAt:creator.dataHomeAssignedAt, routingRevision:creator.routingRevision };
  const draft = (id: string) => ({ id, instanceId:creator.instanceId, ...home, creatorId:creator.id, title, status:'draft' as const });
  if (idempotencyKey === undefined) return repositories.works.create(draft(randomUUID()));
  if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(idempotencyKey)) throw new WorkIntakeError(400,'invalid_work_intent','Work request identity is invalid.');
  const records = repositories.hostRecords;
  if (!records) throw new WorkIntakeError(503,'work_intake_unavailable','Durable Work request receipts are required.');
  const key = createHash('sha256').update(JSON.stringify([creator.instanceId,creator.id,actorId,idempotencyKey])).digest('hex');
  const receiptId = 'work-intake-' + key, workId = 'work-' + key;
  const recover = async (transaction: PersistenceTransaction): Promise<WorkRecord | undefined> => {
    const receipt = await records.get(receiptId,{transaction});
    if (!receipt) return undefined;
    if (receipt.instanceId !== creator.instanceId || receipt.namespace !== 'runtime-work-intake' || receipt.scopeId !== creator.id || receipt.key !== key || receipt.homeCellId !== creator.homeCellId || receipt.value.schemaVersion !== 1 || receipt.value.actorId !== actorId || receipt.value.workId !== workId) throw new Error('Invalid Work request receipt.');
    if (receipt.value.title !== title) throw new WorkIntakeError(409,'work_intent_conflict','This Work request identity already belongs to a different title.');
    const work = await repositories.works.get(workId,{transaction});
    if (!work || work.instanceId !== creator.instanceId || work.creatorId !== creator.id || work.homeCellId !== creator.homeCellId) throw new WorkIntakeError(409,'work_intake_requires_reconciliation','The saved Work request requires reconciliation.');
    return work;
  };
  try {
    return await repositories.transaction(async transaction => {
      const existing = await recover(transaction); if (existing) return existing;
      const work = await repositories.works.create(draft(workId),{transaction});
      await records.create({id:receiptId,instanceId:creator.instanceId,...home,namespace:'runtime-work-intake',scopeId:creator.id,key,value:{schemaVersion:1,actorId,title,workId}},{transaction});
      return work;
    });
  } catch (error) {
    const recovered = await repositories.transaction(transaction=>recover(transaction)); if (recovered) return recovered;
    throw error;
  }
}
