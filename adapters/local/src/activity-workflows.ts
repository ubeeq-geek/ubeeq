import { validateActivityEvent, type ActivityWorkflowStore, type ActivityDocument, type ActivityWrite, type ActivityEvent, type ActivitySelection, type StoredActivity } from '@ubeeq/integrations';
import type { LocalSqliteDatabase } from './index.js';
/** Compact-profile persistence; application services and callers own authorization. */
export class LocalActivityWorkflowStore implements ActivityWorkflowStore {
  constructor(private readonly local: LocalSqliteDatabase, private readonly instanceId: string) {
    if (!instanceId.trim()) throw new Error('Instance ID required.');
    local.database.exec(`CREATE TABLE IF NOT EXISTS ubeeq_activity_documents (
      cell TEXT NOT NULL, instance TEXT NOT NULL, key TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL,
      PRIMARY KEY(cell, instance, key));
      CREATE TABLE IF NOT EXISTS ubeeq_activity_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, cell TEXT NOT NULL, instance TEXT NOT NULL,
      creator TEXT NOT NULL, platform TEXT NOT NULL, event_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL,
      UNIQUE(cell, instance, creator, platform, event_id));
      CREATE INDEX IF NOT EXISTS ubeeq_activity_feed ON ubeeq_activity_events(cell, instance, creator, platform, sequence);
      CREATE INDEX IF NOT EXISTS ubeeq_activity_kind ON ubeeq_activity_events(cell, instance, kind, sequence);`);
  }
  private scope() { return [this.local.configuration.cellId, this.instanceId]; }
  async get<T>(key: string): Promise<ActivityDocument<T> | null> {
    const row = this.local.database.prepare('SELECT revision, payload FROM ubeeq_activity_documents WHERE cell=? AND instance=? AND key=?').get(...this.scope(), key) as { revision: number; payload: string } | undefined;
    return row ? { revision: row.revision, value: JSON.parse(row.payload) as T } : null;
  }
  async commit(writes: ActivityWrite[]): Promise<boolean> {
    if (!writes.length || writes.length > 10 || new Set(writes.map(w => w.key)).size !== writes.length) throw new Error('Invalid activity write batch.');
    for (const write of writes) if (!write.key || write.key.length > 4096 || JSON.stringify(write.value).length > 262144 ||
      (write.revision !== null && (!Number.isSafeInteger(write.revision) || write.revision < 0))) throw new Error('Invalid activity write.');
    return this.local.transactionSync(() => {
      for (const write of writes) {
        const row = this.local.database.prepare('SELECT revision FROM ubeeq_activity_documents WHERE cell=? AND instance=? AND key=?').get(...this.scope(), write.key) as { revision: number } | undefined;
        if ((row?.revision ?? null) !== write.revision) return false;
      }
      for (const write of writes) this.local.database.prepare(`INSERT INTO ubeeq_activity_documents(cell,instance,key,revision,payload) VALUES(?,?,?,?,?)
        ON CONFLICT(cell,instance,key) DO UPDATE SET revision=excluded.revision,payload=excluded.payload`).run(...this.scope(), write.key, (write.revision ?? -1) + 1, JSON.stringify(write.value));
      return true;
    });
  }
  async scan(prefix: string, after: string, limit: number) {
    if (!prefix || prefix.length > 4096 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid activity scan.');
    const rows = this.local.database.prepare(`SELECT key,revision,payload FROM ubeeq_activity_documents
      WHERE cell=? AND instance=? AND key>=? AND key<? AND key>? ORDER BY key LIMIT ?`)
      .all(...this.scope(), prefix, prefix + '\uffff', after, limit) as { key: string; revision: number; payload: string }[];
    return rows.map(row => ({ key: row.key, document: { revision: row.revision, value: JSON.parse(row.payload) } }));
  }
  async append(event: ActivityEvent): Promise<void> {
    validateActivityEvent(event);
    const payload = JSON.stringify(event); if (payload.length > 16384) throw new Error('Activity event too large.');
    this.local.database.prepare(`INSERT INTO ubeeq_activity_events(cell,instance,creator,platform,event_id,kind,payload)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(cell,instance,creator,platform,event_id) DO NOTHING`).run(...this.scope(), event.creatorId, event.platform, event.id, event.kind, payload);
  }
  async page(selection: ActivitySelection, after: number, limit: number, kind?: ActivityEvent['kind']): Promise<StoredActivity[]> {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100 ||
      selection.creators.length > 50 || selection.platforms.length > 50) throw new Error('Invalid activity page.');
    if (!selection.creators.length || !selection.platforms.length) return [];
    const rows = this.local.database.prepare(`SELECT sequence,payload FROM ubeeq_activity_events WHERE cell=? AND instance=? AND sequence>?
      AND creator IN (${selection.creators.map(() => '?').join(',')}) AND platform IN (${selection.platforms.map(() => '?').join(',')})
      ${kind ? 'AND kind=?' : ''} ORDER BY sequence LIMIT ?`).all(...this.scope(), after, ...selection.creators, ...selection.platforms, ...(kind ? [kind] : []), limit) as { sequence: number; payload: string }[];
    return rows.map(row => ({ ...JSON.parse(row.payload), sequence: row.sequence }));
  }
}
