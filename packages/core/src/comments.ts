export interface CommentRecord {
  commentId: string;
  userId: string;
  targetType: string;
  targetId: string;
  body: string;
  hidden: boolean;
  createdAt: string;
}
export interface CommentPort<C extends CommentRecord> {
  listComments(targetType: C['targetType'], targetId: string): Promise<C[]>;
  createComment(comment: C): Promise<void>;
}
export interface CommentTarget { targetType: string; targetId: string }
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
      .filter(comment => comment.targetType === targetType && comment.targetId === targetId && comment.hidden === false)
      .map(comment => structuredClone(comment));
  }
  async create(userId: string, record: C): Promise<C> {
    const comment = structuredClone(record);
    const target = { targetType: comment.targetType, targetId: comment.targetId };
    if (!userId.trim() || !await this.authorize('create', target, userId)) throw new CommentError('access_denied', 'Comment access denied.');
    if (comment.userId !== userId || !comment.commentId.trim() || !comment.targetType.trim() ||
      !comment.targetId.trim() || !comment.body.trim() || !comment.createdAt || typeof comment.hidden !== 'boolean') {
      throw new CommentError('invalid_comment', 'Invalid comment.');
    }
    await this.store.createComment(comment);
    return structuredClone(comment);
  }
}
