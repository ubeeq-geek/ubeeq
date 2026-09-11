import type { Page, PageRequest, PublicationRecord } from '@ubeeq/persistence';
import type { LocalSqliteDatabase } from './index.js';

export interface WorkPublicationScope { instanceId: string; workId: string; destination: string }
const workScopeSql = `repository = 'publications' AND json_extract(payload, '$.homeCellId') = ?
  AND json_extract(payload, '$.instanceId') = ? AND json_extract(payload, '$.workId') = ?`;
const scopeSql = `${workScopeSql} AND json_extract(payload, '$.destination') = ?`;

/** Scoped reads only; callers still authorize the Work and current delivery. */
export class LocalWorkPublicationLookup {
  constructor(private readonly local: LocalSqliteDatabase) {}
  private values(scope: WorkPublicationScope): string[] {
    if (![scope.instanceId, scope.workId, scope.destination].every(value => typeof value === 'string' && value.length > 0)) throw new Error('Invalid publication scope.');
    return [this.local.configuration.cellId, scope.instanceId, scope.workId, scope.destination];
  }
  async hasLive(scope: WorkPublicationScope): Promise<boolean> {
    return Boolean(this.local.database.prepare(`SELECT 1 FROM ubeeq_records WHERE ${scopeSql} AND json_extract(payload, '$.status') = 'live' LIMIT 1`).get(...this.values(scope)));
  }
  async list(scope: WorkPublicationScope, request: PageRequest): Promise<Page<PublicationRecord>> {
    return this.page(scopeSql, this.values(scope), request);
  }
  /** All destinations for an authorized Work export, not a public delivery admission. */
  async listForWork(scope: Pick<WorkPublicationScope, 'instanceId' | 'workId'>, request: PageRequest): Promise<Page<PublicationRecord>> {
    if (![scope.instanceId, scope.workId].every(value => typeof value === 'string' && value.length > 0)) throw new Error('Invalid publication scope.');
    return this.page(workScopeSql, [this.local.configuration.cellId, scope.instanceId, scope.workId], request);
  }
  private async page(where: string, values: string[], request: PageRequest): Promise<Page<PublicationRecord>> {
    if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 100) throw new Error('Publication page limit must be 1–100.');
    let after = '';
    if (request.cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(request.cursor, 'base64url').toString('utf8'));
        if (JSON.stringify(decoded.scope) !== JSON.stringify(values) || typeof decoded.after !== 'string') throw Error();
        after = decoded.after;
      } catch { throw new Error('Invalid publication cursor scope.'); }
    }
    const rows = this.local.database.prepare(`SELECT id, payload FROM ubeeq_records WHERE ${where} AND id > ? ORDER BY id LIMIT ?`)
      .all(...values, after, request.limit + 1) as Array<{ id: string; payload: string }>;
    const page = rows.slice(0, request.limit);
    return { items: page.map(row => JSON.parse(row.payload) as PublicationRecord),
      nextCursor: rows.length > request.limit ? Buffer.from(JSON.stringify({ scope: values, after: page.at(-1)!.id })).toString('base64url') : undefined };
  }
}
