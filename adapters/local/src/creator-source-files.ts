import type { CreatorSourceFileRecord, CreatorSourceFilePort, CreatorSourceFilePageRequest, CreatorSourceFilePage } from '@ubeeq/core';
import { CreatorSourceFileError } from '@ubeeq/core';
import type { LocalSqliteDatabase } from './index.js';

/** Metadata only. Bound to one cell and tenant; callers own creator and storage admission. */
export class LocalCreatorSourceFileStore<F extends CreatorSourceFileRecord> implements CreatorSourceFilePort<F> {
  constructor(private readonly local: LocalSqliteDatabase, private readonly tenantId: string) {
    if (!tenantId.trim()) throw new Error('Source-file tenant is required.');
  }
  async createSourceFile(file: F): Promise<void> {
    // INSERT, never upsert: another creator cannot replace a reserved file ID.
    this.local.database.prepare(`INSERT INTO ubeeq_creator_library (cell_id, tenant_id, kind, id, creator_id, payload)
      VALUES (?, ?, 'source_file', ?, ?, ?)`).run(this.local.configuration.cellId, this.tenantId,
        file.fileId, file.creatorId, JSON.stringify(file));
  }
  /** Tenant-wide collision lookup; never returns another creator's metadata. */
  async hasSourceFileId(fileId: string): Promise<boolean> {
    return Boolean(this.local.database.prepare("SELECT 1 FROM ubeeq_creator_library WHERE cell_id = ? AND tenant_id = ? AND kind = 'source_file' AND id = ?")
      .get(this.local.configuration.cellId, this.tenantId, fileId));
  }
  async listCreatorSourceFiles(creatorId: string, request: CreatorSourceFilePageRequest): Promise<CreatorSourceFilePage<F>> {
    const scope = [this.local.configuration.cellId, this.tenantId, creatorId];
    if (!creatorId.trim() || !Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 100)
      throw new CreatorSourceFileError('invalid_page', 'Invalid source-file page.');
    let after = '';
    if (request.cursor !== undefined) {
      try {
        if (typeof request.cursor !== 'string' || !request.cursor || request.cursor.length > 8192) throw Error();
        const value = JSON.parse(Buffer.from(request.cursor, 'base64url').toString('utf8'));
        if (JSON.stringify(value.scope) !== JSON.stringify(scope) || typeof value.after !== 'string' || !value.after) throw Error();
        after = value.after;
      } catch { throw new CreatorSourceFileError('invalid_page', 'Invalid source-file cursor scope.'); }
    }
    const rows = this.local.database.prepare(`SELECT id, payload FROM ubeeq_creator_library
      WHERE cell_id = ? AND tenant_id = ? AND creator_id = ? AND kind = 'source_file' AND id > ? ORDER BY id LIMIT ?`)
      .all(...scope, after, request.limit + 1) as Array<{ id: string; payload: string }>;
    const page = rows.slice(0, request.limit);
    return { items: page.map(row => JSON.parse(row.payload) as F),
      nextCursor: rows.length > request.limit ? Buffer.from(JSON.stringify({ scope, after: page.at(-1)!.id })).toString('base64url') : undefined };
  }
}
