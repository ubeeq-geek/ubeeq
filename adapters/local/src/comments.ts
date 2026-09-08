import type { CommentLookupPort, CommentModerationPort, CommentPageOptions, CommentPagePort, CommentPort, CommentRecord } from '@ubeeq/core';
import { UniqueConstraintError } from '@ubeeq/persistence';
import type { LocalSqliteDatabase } from './index.js';

/** Persistence only: product admission and rendering remain caller responsibilities. */
export class LocalCommentStore<C extends CommentRecord = CommentRecord> implements CommentPort<C>, CommentModerationPort, CommentLookupPort<C>, CommentPagePort<C> {
  constructor(private readonly local: LocalSqliteDatabase, private readonly tenantId: string) {
    if (!tenantId.trim()) throw new Error('Comment tenant is required.');
  }
  private scope() { return [this.local.configuration.cellId, this.tenantId]; }
  async listCommentPage(targetType: C['targetType'], targetId: string, options: CommentPageOptions) {
    if (![targetType, targetId].every(value => typeof value === 'string' && Boolean(value.trim())) ||
      !options || !Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100 ||
      (options.includeHidden !== undefined && typeof options.includeHidden !== 'boolean') ||
      (options.after !== undefined && (!options.after || ![options.after.createdAt, options.after.commentId].every(value => typeof value === 'string' && Boolean(value.trim()))))) throw new Error('Invalid comment page request.');
    const rows = this.local.database.prepare(`SELECT comment_id, created_at, payload FROM ubeeq_comments
      WHERE cell_id = ? AND tenant_id = ? AND target_type = ? AND target_id = ?
      ${options.includeHidden ? '' : "AND json_extract(payload, '$.hidden') = 0"}
      ${options.after ? 'AND (created_at, comment_id) > (?, ?)' : ''}
      ORDER BY created_at, comment_id LIMIT ?`)
      .all(...this.scope(), targetType, targetId, ...(options.after ? [options.after.createdAt, options.after.commentId] : []), options.limit + 1) as Array<{ comment_id: string; created_at: string; payload: string }>;
    const selected = rows.slice(0, options.limit);
    const items = selected.map(row => {
      const value = JSON.parse(row.payload) as C;
      if (value.commentId !== row.comment_id || value.createdAt !== row.created_at || value.targetType !== targetType || value.targetId !== targetId ||
        typeof value.hidden !== 'boolean' || (!options.includeHidden && value.hidden)) throw new Error('Invalid stored comment identity.');
      return value;
    });
    const last = selected[selected.length - 1];
    return { items, ...(rows.length > options.limit && last ? { nextCursor: { createdAt: last.created_at, commentId: last.comment_id } } : {}) };
  }
  async getComment(targetType: C['targetType'], targetId: string, commentId: string): Promise<C | null> {
    if (![targetType, targetId, commentId].every(value => typeof value === 'string' && Boolean(value.trim()))) throw new Error('Invalid comment lookup.');
    const row = this.local.database.prepare(`SELECT payload FROM ubeeq_comments
      WHERE cell_id = ? AND tenant_id = ? AND comment_id = ? AND target_type = ? AND target_id = ?`)
      .get(...this.scope(), commentId, targetType, targetId) as { payload: string } | undefined;
    if (!row) return null;
    const value = JSON.parse(row.payload) as C;
    if (value.commentId !== commentId || value.targetType !== targetType || value.targetId !== targetId || typeof value.hidden !== 'boolean') throw new Error('Invalid stored comment identity.');
    return value;
  }
  async updateCommentVisibility(commentId: string, hidden: boolean): Promise<void> {
    if (typeof commentId !== 'string' || !commentId.trim() || typeof hidden !== 'boolean') throw new Error('Invalid comment moderation request.');
    this.local.database.prepare(`UPDATE ubeeq_comments SET payload = json_set(payload, '$.hidden', json(?))
      WHERE cell_id = ? AND tenant_id = ? AND comment_id = ?`)
      .run(JSON.stringify(hidden), ...this.scope(), commentId);
  }
  async deleteComment(commentId: string): Promise<void> {
    if (typeof commentId !== 'string' || !commentId.trim()) throw new Error('Invalid comment moderation request.');
    this.local.database.prepare('DELETE FROM ubeeq_comments WHERE cell_id = ? AND tenant_id = ? AND comment_id = ?')
      .run(...this.scope(), commentId);
  }
  async listComments(targetType: C['targetType'], targetId: string): Promise<C[]> {
    const rows = this.local.database.prepare(`SELECT comment_id, payload FROM ubeeq_comments
      WHERE cell_id = ? AND tenant_id = ? AND target_type = ? AND target_id = ? ORDER BY created_at, comment_id`)
      .all(...this.scope(), targetType, targetId) as Array<{ comment_id: string; payload: string }>;
    return rows.map(row => {
      const value = JSON.parse(row.payload) as C;
      if (value.commentId !== row.comment_id || value.targetType !== targetType || value.targetId !== targetId || typeof value.hidden !== 'boolean') throw new Error('Invalid stored comment identity.');
      return value;
    });
  }
  async createComment(record: C): Promise<void> {
    const comment = structuredClone(record);
    if (![comment.commentId, comment.userId, comment.targetType, comment.targetId, comment.body, comment.createdAt]
      .every(value => typeof value === 'string' && Boolean(value.trim())) || typeof comment.hidden !== 'boolean') throw new Error('Invalid comment record.');
    const result = this.local.database.prepare(`INSERT INTO ubeeq_comments
      (cell_id, tenant_id, comment_id, target_type, target_id, created_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (cell_id, tenant_id, comment_id) DO NOTHING`)
      .run(...this.scope(), comment.commentId, comment.targetType, comment.targetId, comment.createdAt, JSON.stringify(comment));
    if (!result.changes) throw new UniqueConstraintError({ name: 'comment_id', values: { tenantId: this.tenantId, commentId: comment.commentId } });
  }
}
