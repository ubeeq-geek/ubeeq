import { randomUUID } from 'node:crypto';
import { OptimisticConcurrencyError, type UbeeqRepositories, type WorkRecord, type PublicationRecord, type PersistenceTransaction } from '@ubeeq/persistence';

export class PublicationWithdrawalError extends Error {
  constructor(readonly code: 'invalid_request' | 'publication_not_found' | 'publication_not_live', message: string) {
    super(message); this.name = 'PublicationWithdrawalError';
  }
}
export type PublicationWithdrawalRepositories = Pick<UbeeqRepositories, 'publications' | 'auditEvents' | 'transaction'>;
export interface PublicationWithdrawalResult { publication: PublicationRecord; idempotent: boolean }

/** Withdraw a local receipt, not an external provider publication. Does not delete files,
 * change the Work or withdraw other destinations. Policy must explicitly admit withdrawal;
 * it need not use publication eligibility (held content may still need to be withdrawn).
 */
export class PublicationWithdrawalService {
  constructor(private readonly repositories: PublicationWithdrawalRepositories,
    private readonly authorizeWork: (workId: string, actorId: string) => Promise<WorkRecord>,
    private readonly admitWithdrawal: (work: WorkRecord, publication: PublicationRecord) => Promise<void>) {}

  async withdraw(input: { workId: string; actorId: string; publicationId: string; expectedRevision: number }): Promise<PublicationWithdrawalResult> {
    const { workId, actorId, publicationId, expectedRevision } = input;
    if (!workId || !actorId || !publicationId || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new PublicationWithdrawalError('invalid_request', 'Work, actor, publication and a positive revision are required.');
    }
    const work = structuredClone(await this.authorizeWork(workId, actorId));
    if (work.id !== workId) throw new PublicationWithdrawalError('invalid_request', 'Authorization returned a different Work.');
    const read = async (transaction?: PersistenceTransaction) => {
      const record = await this.repositories.publications.get(publicationId, { transaction });
      if (!record || record.id !== publicationId || record.workId !== work.id || record.instanceId !== work.instanceId || record.homeCellId !== work.homeCellId) {
        throw new PublicationWithdrawalError('publication_not_found', 'Publication does not belong to the authorized Work.');
      }
      return record;
    };
    const initial = await read();
    await this.admitWithdrawal(structuredClone(work), structuredClone(initial));
    if (initial.status === 'removed') return { publication: structuredClone(initial), idempotent: true };
    if (initial.status !== 'live') throw new PublicationWithdrawalError('publication_not_live', 'Only a live local publication can be withdrawn.');
    if (initial.revision !== expectedRevision) throw new OptimisticConcurrencyError(publicationId, expectedRevision);
    try {
      return await this.repositories.transaction(async transaction => {
        const current = await read(transaction);
        if (current.status === 'removed' && current.destination === initial.destination) return { publication: structuredClone(current), idempotent: true };
        if (current.revision !== expectedRevision || current.destination !== initial.destination || current.status !== 'live') throw new OptimisticConcurrencyError(publicationId, expectedRevision);
        const publication = await this.repositories.publications.update(publicationId, expectedRevision, { status: 'removed' }, { transaction });
        const { instanceId, homeCellId, dataHomeRegion, dataHomeAssignedAt, routingRevision } = publication;
        await this.repositories.auditEvents.create({ id: randomUUID(), instanceId, homeCellId, dataHomeRegion, dataHomeAssignedAt, routingRevision,
          action: 'publication.withdrawn', actorId, subjectId: work.id,
          payload: { publicationId, destination: publication.destination } }, { transaction });
        return { publication: structuredClone(publication), idempotent: false };
      });
    } catch (error) {
      // A competing successful withdrawal is safe to acknowledge after an ambiguous commit.
      const current = await read();
      if (current.status === 'removed' && current.destination === initial.destination) return { publication: structuredClone(current), idempotent: true };
      throw error;
    }
  }
}
