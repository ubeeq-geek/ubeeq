import type { FlickrConnection, FlickrMigration, FlickrOAuthRequest, FlickrRepository } from '@ubeeq/integrations';
import type { LocalSqliteDatabase } from './index.js';

/** Durable development state. Callers own creator authorization and credential encryption. */
export class LocalFlickrRepository implements FlickrRepository {
  private readonly cellId: string;
  constructor(private readonly local: LocalSqliteDatabase, private readonly tenantId: string) {
    this.cellId = local.configuration.cellId;
    if (!this.cellId?.trim() || !tenantId?.trim()) throw new Error('Flickr repository cell and tenant are required.');
    local.database.exec(`CREATE TABLE IF NOT EXISTS ubeeq_flickr_state (
      cell_id TEXT NOT NULL, tenant_id TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL,
      connection_id TEXT, payload TEXT NOT NULL,
      PRIMARY KEY (cell_id, tenant_id, kind, id));
      CREATE INDEX IF NOT EXISTS ubeeq_flickr_connection ON ubeeq_flickr_state
      (cell_id, tenant_id, kind, connection_id);
      CREATE INDEX IF NOT EXISTS ubeeq_flickr_owner_connections ON ubeeq_flickr_state
      (cell_id, tenant_id, json_extract(payload, '$.userId'), json_extract(payload, '$.creatorId'), id)
      WHERE kind = 'connection';`);
  }
  private put(kind: string, id: string, value: unknown, connectionId: string | null = null) {
    this.local.database.prepare(`INSERT INTO ubeeq_flickr_state (cell_id, tenant_id, kind, id, connection_id, payload)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(cell_id, tenant_id, kind, id)
      DO UPDATE SET connection_id = excluded.connection_id, payload = excluded.payload`)
      .run(this.cellId, this.tenantId, kind, id, connectionId, JSON.stringify(value));
  }
  private get<T>(kind: string, id: string): T | undefined {
    const row = this.local.database.prepare('SELECT payload FROM ubeeq_flickr_state WHERE cell_id = ? AND tenant_id = ? AND kind = ? AND id = ?')
      .get(this.cellId, this.tenantId, kind, id) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as T : undefined;
  }
  async putConnection(value: FlickrConnection) { this.put('connection', value.connectionId, value); }
  async getConnection(id: string) { return this.get<FlickrConnection>('connection', id); }
  async listConnections(userId: string, creatorId: string, options: { limit: number; cursor?: string }): Promise<{ items: FlickrConnection[]; nextCursor?: string }> {
    if (![userId, creatorId].every(value => typeof value === 'string' && value.trim() && value.length <= 200)
      || !Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100) throw new Error('Invalid Flickr connection page');
    const scope = [this.cellId, this.tenantId, userId, creatorId];
    let after = '';
    if (options.cursor !== undefined) {
      try {
        if (typeof options.cursor !== 'string' || !options.cursor || options.cursor.length > 8192) throw Error();
        const parsed = JSON.parse(Buffer.from(options.cursor, 'base64url').toString());
        if (!Array.isArray(parsed) || parsed.length !== 5 || scope.some((value, i) => parsed[i] !== value) || typeof parsed[4] !== 'string' || !parsed[4]) throw Error();
        after = parsed[4];
      } catch { throw new Error('Invalid Flickr connection cursor'); }
    }
    const rows = this.local.database.prepare(`SELECT id, payload FROM ubeeq_flickr_state INDEXED BY ubeeq_flickr_owner_connections
      WHERE cell_id = ? AND tenant_id = ? AND kind = 'connection'
      AND json_extract(payload, '$.userId') = ? AND json_extract(payload, '$.creatorId') = ? AND id > ? ORDER BY id LIMIT ?`)
      .all(...scope, after, options.limit + 1) as Array<{ id: string; payload: string }>;
    const page = rows.slice(0, options.limit);
    return { items: page.map(row => JSON.parse(row.payload) as FlickrConnection),
      nextCursor: rows.length > options.limit ? Buffer.from(JSON.stringify([...scope, page[page.length - 1].id])).toString('base64url') : undefined };
  }
  async putMigration(value: FlickrMigration) { this.put('migration', value.migrationId, value, value.connectionId); }
  async getMigration(id: string) { return this.get<FlickrMigration>('migration', id); }
  async getMigrationByConnection(connectionId: string): Promise<FlickrMigration | undefined> {
    // Preserve the reference repository's first-inserted match, including after updates.
    const row = this.local.database.prepare(`SELECT payload FROM ubeeq_flickr_state
      WHERE cell_id = ? AND tenant_id = ? AND kind = 'migration' AND connection_id = ? ORDER BY rowid LIMIT 1`)
      .get(this.cellId, this.tenantId, connectionId) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as FlickrMigration : undefined;
  }
  async putOAuthRequest(value: FlickrOAuthRequest) { this.put('oauth', value.requestToken, value); }
  async takeOAuthRequest(requestToken: string, userId: string, creatorId: string): Promise<FlickrOAuthRequest | undefined> {
    const row = this.local.database.prepare(`DELETE FROM ubeeq_flickr_state
      WHERE cell_id = ? AND tenant_id = ? AND kind = 'oauth' AND id = ?
      AND json_extract(payload, '$.userId') = ? AND json_extract(payload, '$.creatorId') = ? RETURNING payload`)
      .get(this.cellId, this.tenantId, requestToken, userId, creatorId) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as FlickrOAuthRequest : undefined;
  }
}
