import type { IntegrationAccountRecord, PublicationIntentRecord, Page, PageRequest } from '@ubeeq/persistence';
import type { LocalSqliteDatabase } from './index.js';

/** Scoped metadata reads. Authorization and removal of credentials belong to the caller. */
export class LocalExportRelatedLookup {
  constructor(private readonly local: LocalSqliteDatabase) {}
  /** Collision check against the physical key namespace, not permission to read a record. */
  async hasImportId(repository: 'publications' | 'publicationIntents' | 'integrationAccounts', id: string): Promise<boolean> {
    if (!['publications', 'publicationIntents', 'integrationAccounts'].includes(repository) ||
      typeof id !== 'string' || !id.trim() || id.length > 500) throw new Error('Invalid import identity lookup.');
    return Boolean(this.local.database.prepare('SELECT 1 FROM ubeeq_records WHERE repository = ? AND id = ?').get(repository, id));
  }
  async publicationIntents(scope: { instanceId: string; workId: string }, request: PageRequest): Promise<Page<PublicationIntentRecord>> {
    return this.page('publicationIntents', 'workId', scope.instanceId, scope.workId, request);
  }
  async integrationAccounts(scope: { instanceId: string; creatorId: string }, request: PageRequest): Promise<Page<IntegrationAccountRecord>> {
    return this.page('integrationAccounts', 'creatorId', scope.instanceId, scope.creatorId, request);
  }
  private async page<T>(repository: 'publicationIntents' | 'integrationAccounts', field: 'workId' | 'creatorId',
    instanceId: string, ownerId: string, request: PageRequest): Promise<Page<T>> {
    if (![instanceId, ownerId].every(value => typeof value === 'string' && value.length > 0)) throw new Error('Invalid related-record scope.');
    if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 100) throw new Error('Related-record page limit must be 1–100.');
    const scope = [repository, this.local.configuration.cellId, instanceId, ownerId];
    let after = '';
    if (request.cursor !== undefined) {
      try {
        if (!request.cursor || request.cursor.length > 8192) throw new Error();
        const decoded = JSON.parse(Buffer.from(request.cursor, 'base64url').toString('utf8'));
        if (JSON.stringify(decoded.scope) !== JSON.stringify(scope) || typeof decoded.after !== 'string' || !decoded.after) throw new Error();
        after = decoded.after;
      } catch { throw new Error('Invalid related-record cursor scope.'); }
    }
    // Repository and field are fixed by the public methods, never supplied by a request.
    const rows = this.local.database.prepare(`SELECT id, payload FROM ubeeq_records WHERE repository = '${repository}'
      AND json_extract(payload, '$.homeCellId') = ? AND json_extract(payload, '$.instanceId') = ?
      AND json_extract(payload, '$.${field}') = ? AND id > ? ORDER BY id LIMIT ?`)
      .all(this.local.configuration.cellId, instanceId, ownerId, after, request.limit + 1) as Array<{ id: string; payload: string }>;
    const page = rows.slice(0, request.limit);
    return { items: page.map(row => JSON.parse(row.payload) as T), nextCursor: rows.length > request.limit
      ? Buffer.from(JSON.stringify({ scope, after: page.at(-1)!.id })).toString('base64url') : undefined };
  }
}
