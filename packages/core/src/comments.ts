export interface CommentRecord {
  commentId: string;
  userId: string;
  targetType: string;
  targetId: string;
  body: string;
  hidden: boolean;
  createdAt: string;
  deletedAt?: string;
}
/** Clears the standard body while retaining identity to prevent create replay.
 * Product admission is required. Extensions must not store comment text elsewhere.
 */
export interface CommentErasurePort {
  eraseComment(targetType: string, targetId: string, commentId: string, deletedAt: string): Promise<boolean>;
}
export interface CommentPort<C extends CommentRecord> {
  listComments(targetType: C['targetType'], targetId: string): Promise<C[]>;
  createComment(comment: C): Promise<void>;
}
export interface CommentTarget { targetType: string; targetId: string }
export interface CommentCursor { createdAt: string; commentId: string }
export interface CommentPageOptions { limit: number; after?: CommentCursor; includeHidden?: boolean }
/** Bound to tenant/cell. Callers authorize the target and any hidden-record access. */
export interface CommentPagePort<C extends CommentRecord> {
  listCommentPage(targetType: C['targetType'], targetId: string, options: CommentPageOptions): Promise<{ items: C[]; nextCursor?: CommentCursor }>;
}
/** Raw tenant/cell-bound lookup, including hidden records. Product admission is required. */
export interface CommentLookupPort<C extends CommentRecord> {
  getComment(targetType: C['targetType'], targetId: string, commentId: string): Promise<C | null>;
}
/** Implementations must be bound to the caller's tenant/cell scope. */
export interface CommentModerationPort {
  updateCommentVisibility(commentId: string, hidden: boolean): Promise<void>;
  deleteComment(commentId: string): Promise<void>;
}
/** Product policy resolves whether this actor may moderate this exact comment.
 * No public admission or cross-tenant lookup is implied by possession of an ID.
 */
export class CommentModerationService {
  constructor(private readonly store: CommentModerationPort, private readonly authorize:
    (operation: 'visibility' | 'delete', commentId: string, actorId: string) => Promise<boolean>) {}
  private async admit(operation: 'visibility' | 'delete', commentId: string, actorId: string): Promise<void> {
    if (typeof actorId !== 'string' || !actorId.trim()) throw new CommentError('access_denied', 'Comment moderation denied.');
    if (typeof commentId !== 'string' || !commentId.trim()) throw new CommentError('invalid_comment', 'Comment ID is required.');
    if (!await this.authorize(operation, commentId, actorId)) throw new CommentError('access_denied', 'Comment moderation denied.');
  }
  async setHidden(actorId: string, commentId: string, hidden: boolean): Promise<void> {
    await this.admit('visibility', commentId, actorId);
    if (typeof hidden !== 'boolean') throw new CommentError('invalid_comment', 'Comment visibility must be a boolean.');
    await this.store.updateCommentVisibility(commentId, hidden);
  }
  async delete(actorId: string, commentId: string): Promise<void> {
    await this.admit('delete', commentId, actorId);
    await this.store.deleteComment(commentId);
  }
}
export class CommentError extends Error {
  constructor(readonly code: 'access_denied' | 'invalid_comment', message: string) {
    super(message); this.name = 'CommentError';
  }
}
/** Tenant-bound compatibility service. Product admission must cover target
 * visibility, author-profile delegation and moderation policy. Listing excludes
 * hidden comments; storage owns create atomicity and duplicate-ID handling.
 * This service neither sanitizes markup nor projects a public response.
 */
export class CommentService<C extends CommentRecord> {
  constructor(private readonly store: CommentPort<C>, private readonly authorize:
    (operation: 'list' | 'create', target: CommentTarget, userId?: string) => Promise<boolean>) {}
  async list(targetType: C['targetType'], targetId: string): Promise<C[]> {
    if (!await this.authorize('list', { targetType, targetId })) throw new CommentError('access_denied', 'Comment access denied.');
    return (await this.store.listComments(targetType, targetId))
      .filter(comment => comment.targetType === targetType && comment.targetId === targetId && comment.hidden === false && !comment.deletedAt)
      .map(comment => structuredClone(comment));
  }
  async create(userId: string, record: C): Promise<C> {
    const comment = structuredClone(record);
    const target = { targetType: comment.targetType, targetId: comment.targetId };
    if (!userId.trim() || !await this.authorize('create', target, userId)) throw new CommentError('access_denied', 'Comment access denied.');
    if (comment.userId !== userId || !comment.commentId.trim() || !comment.targetType.trim() ||
      !comment.targetId.trim() || !comment.body.trim() || !comment.createdAt || typeof comment.hidden !== 'boolean' || comment.deletedAt !== undefined) {
      throw new CommentError('invalid_comment', 'Invalid comment.');
    }
    await this.store.createComment(comment);
    return structuredClone(comment);
  }
}
