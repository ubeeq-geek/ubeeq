import type { IntegrationAccountRecord, PublicationIntentRecord, Page, PageRequest } from '@ubeeq/persistence';
import type { LocalSqliteDatabase } from './index.js';

/** Scoped metadata reads. Authorization and credential removal remain product responsibilities. */
export class LocalExportRelatedLookup {
  constructor(private readonly local: LocalSqliteDatabase) {}
  async hasImportId(repository: 'publications' | 'publicationIntents' | 'integrationAccounts', id: string): Promise<boolean> {
    if (!['publications', 'publicationIntents', 'integrationAccounts'].includes(repository) || typeof id !== 'string' || !id.trim() || id.length > 500) throw new Error('Invalid import identity lookup.');
    return Boolean(this.local.database.prepare('SELECT 1 FROM ubeeq_records WHERE repository = ? AND id = ?').get(repository, id));
  }
  async publicationIntents(scope: { instanceId: string; workId: string }, request: PageRequest): Promise<Page<PublicationIntentRecord>> { return this.page('publicationIntents', 'workId', scope.instanceId, scope.workId, request); }
  async integrationAccounts(scope: { instanceId: string; creatorId: string }, request: PageRequest): Promise<Page<IntegrationAccountRecord>> { return this.page('integrationAccounts', 'creatorId', scope.instanceId, scope.creatorId, request); }
  private async page<T>(repository: 'publicationIntents' | 'integrationAccounts', field: 'workId' | 'creatorId', instanceId: string, ownerId: string, request: PageRequest): Promise<Page<T>> {
    if (![instanceId, ownerId].every((value) => typeof value === 'string' && value.length > 0) || !Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 100) throw new Error('Invalid related-record page request.');
    const scope = [repository, this.local.configuration.cellId, instanceId, ownerId]; let after = '';
    if (request.cursor !== undefined) { try { const decoded = JSON.parse(Buffer.from(request.cursor, 'base64url').toString('utf8')); if (JSON.stringify(decoded.scope) !== JSON.stringify(scope) || typeof decoded.after !== 'string' || !decoded.after) throw new Error(); after = decoded.after; } catch { throw new Error('Invalid related-record cursor scope.'); } }
    const rows = this.local.database.prepare(`SELECT id, payload FROM ubeeq_records WHERE repository = '${repository}' AND json_extract(payload, '$.homeCellId') = ? AND json_extract(payload, '$.instanceId') = ? AND json_extract(payload, '$.${field}') = ? AND id > ? ORDER BY id LIMIT ?`).all(this.local.configuration.cellId, instanceId, ownerId, after, request.limit + 1) as Array<{ id: string; payload: string }>;
    const items = rows.slice(0, request.limit).map((row) => JSON.parse(row.payload) as T);
    return { items, nextCursor: rows.length > request.limit ? Buffer.from(JSON.stringify({ scope, after: items.length ? rows[request.limit - 1].id : '' })).toString('base64url') : undefined };
  }
}
