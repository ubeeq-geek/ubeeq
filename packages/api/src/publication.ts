import { createHash, randomUUID } from 'node:crypto';
import { repositoryItems, type UbeeqRepositories, type WorkRecord, type AssetRecord, type PublicationIntentRecord, type PublicationRecord } from '@ubeeq/persistence';

export class PublicationRequestError extends Error {
  constructor(readonly code: 'invalid_request' | 'invalid_idempotency_key' | 'idempotency_conflict' | 'publication_receipt_invalid' | 'processing_incomplete', message: string) {
    super(message); this.name = 'PublicationRequestError';
  }
}
export type PublicationRepositories = Pick<UbeeqRepositories, 'publicationIntents' | 'publications' | 'auditEvents' | 'transaction'> & {
  works: Pick<UbeeqRepositories['works'], 'get' | 'update'>;
  assets: Pick<UbeeqRepositories['assets'], 'list'>;
};
export interface PublicationResult { intent: PublicationIntentRecord; publication: PublicationRecord; work: WorkRecord; idempotent: boolean }

/** Canonical local-publication mechanism. Products must explicitly authorize the actor and admit publication.
 * The destination is metadata, not a provider dispatch. Repositories must supply atomic transactions and revision CAS.
 */
export class PublicationService {
  constructor(private readonly repositories: PublicationRepositories,
    private readonly authorizeWork: (workId: string, actorId: string) => Promise<WorkRecord>,
    private readonly admit: (work: WorkRecord, assets: readonly AssetRecord[]) => Promise<void>) {}

  async publish(input: { workId: string; actorId: string; destination: string; idempotencyKey?: unknown }): Promise<PublicationResult> {
    const { workId, actorId, destination: rawDestination, idempotencyKey: header } = input;
    const work = structuredClone(await this.authorizeWork(workId, actorId));
    if (work.id !== workId || !actorId || typeof rawDestination !== 'string' || !rawDestination.trim()) throw new PublicationRequestError('invalid_request', 'A matching authorized Work, actor and destination are required.');
    const destination = rawDestination.trim();
    if (header !== undefined && (typeof header !== 'string' || !header.trim() || header.length > 200)) throw new PublicationRequestError('invalid_idempotency_key', 'Use a non-empty idempotency key of at most 200 characters');
    const requestKey = typeof header === 'string' ? header.trim() : randomUUID();
    const digest = createHash('sha256').update(JSON.stringify([work.instanceId, work.creatorId, work.id, requestKey])).digest('hex');
    const intentId = `publication-request-${digest}`, publicationId = `publication-${digest}`;
    const repositories = this.repositories;
    const replay = async () => {
      const intent = await repositories.publicationIntents.get(intentId);
      if (!intent) return undefined;
      if (intent.workId !== work.id || intent.destination !== destination || intent.idempotencyKey !== requestKey) throw new PublicationRequestError('idempotency_conflict', 'The idempotency key was already used for a different publication request');
      const publication = await repositories.publications.get(publicationId);
      if (!publication || publication.workId !== work.id || publication.destination !== destination) throw new PublicationRequestError('publication_receipt_invalid', 'The stored publication request is incomplete');
      return { intent, publication, work: await this.authorizeWork(work.id, actorId), idempotent: true };
    };
    const previous = await replay();
    if (previous) return structuredClone(previous);
    const assets: AssetRecord[] = [];
    for await (const asset of repositoryItems(request => repositories.assets.list(request))) if (asset.workId === work.id) assets.push(asset);
    if (!assets.length || assets.some(asset => asset.status !== 'ready' || asset.creatorId !== work.creatorId)) throw new PublicationRequestError('processing_incomplete', 'All Work assets must belong to its Creator and finish processing before publication');
    await this.admit(structuredClone(work), structuredClone(assets));
    const scope = { instanceId: work.instanceId, homeCellId: work.homeCellId, dataHomeRegion: work.dataHomeRegion, dataHomeAssignedAt: work.dataHomeAssignedAt, routingRevision: work.routingRevision };
    try {
      return structuredClone(await repositories.transaction(async transaction => {
        const existing = await replay();
        if (existing) return existing;
        const intent = await repositories.publicationIntents.create({ id: intentId, ...scope, workId: work.id, destination, idempotencyKey: requestKey }, { transaction });
        const publication = await repositories.publications.create({ id: publicationId, ...scope, workId: work.id, destination, status: 'live' }, { transaction });
        const publishedWork = await repositories.works.update(work.id, work.revision, { status: 'published' }, { transaction });
        await repositories.auditEvents.create({ id: randomUUID(), ...scope, action: 'work.published', actorId, subjectId: work.id, payload: { publicationId: publication.id, destination } }, { transaction });
        return { intent, publication, work: publishedWork, idempotent: false };
      }));
    } catch (error) {
      const existing = await replay();
      if (!existing) throw error;
      return structuredClone(existing);
    }
  }
}
