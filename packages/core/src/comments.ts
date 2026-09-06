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
