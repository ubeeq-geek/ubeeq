import type { CommentPort, CommentRecord } from '@ubeeq/core';
import { UniqueConstraintError } from '@ubeeq/persistence';
import type { LocalSqliteDatabase } from './index.js';

/** Persistence only: product admission and rendering remain caller responsibilities. */
export class LocalCommentStore<C extends CommentRecord = CommentRecord> implements CommentPort<C> {
  constructor(private readonly local: LocalSqliteDatabase, private readonly tenantId: string) {
    if (!tenantId.trim()) throw new Error('Comment tenant is required.');
  }
  private scope() { return [this.local.configuration.cellId, this.tenantId]; }
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
