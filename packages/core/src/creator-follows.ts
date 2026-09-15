export interface CreatorFollowRecord {
  followId: string;
  followerUserId: string;
  creatorId: string;
  insertedDate: string;
  notificationsEnabled: boolean;
}
export interface CreatorFollowPort<F extends CreatorFollowRecord> {
  listFollowsByUser(userId: string): Promise<F[]>;
  followCreator(follow: F): Promise<void>;
  unfollowCreator(userId: string, creatorId: string): Promise<void>;
}
/** Optional point-read port; the adapter remains bound to one tenant/cell. */
export interface CreatorFollowLookupPort<F extends CreatorFollowRecord> {
  getFollow(userId: string, creatorId: string): Promise<F | null>;
}
export interface CreatorFollowPageOptions { limit: number; afterCreatorId?: string; }
export interface CreatorFollowPage<F extends CreatorFollowRecord> { items: F[]; nextCreatorId?: string; }
export interface CreatorFollowPagePort<F extends CreatorFollowRecord> {
  listFollowPage(userId: string, options: CreatorFollowPageOptions): Promise<CreatorFollowPage<F>>;
}
export class CreatorFollowError extends Error {
  constructor(readonly code: 'access_denied' | 'invalid_follow', message: string) {
    super(message); this.name = 'CreatorFollowError';
  }
}
/** Bind the store to one tenant. Products own creator eligibility, actor
 * identity, notification delivery and any follower-derived access policy.
 * The adapter must replace each user/creator pair atomically on re-follow.
 */
export class CreatorFollowService<F extends CreatorFollowRecord> {
  constructor(private readonly store: CreatorFollowPort<F>,
    private readonly authorize: (userId: string, operation: 'list' | 'follow' | 'unfollow', creatorId?: string) => Promise<boolean>) {}
  private async access(userId: string, operation: 'list' | 'follow' | 'unfollow', creatorId?: string) {
    if (!userId.trim() || !await this.authorize(userId, operation, creatorId)) {
      throw new CreatorFollowError('access_denied', 'Creator follow access denied.');
    }
  }
  async list(userId: string): Promise<F[]> {
    await this.access(userId, 'list');
    const follows = (await this.store.listFollowsByUser(userId)).filter(follow => follow.followerUserId === userId).map(follow => structuredClone(follow));
    await this.access(userId, 'list');
    return follows;
  }
  async listPage(userId: string, options: CreatorFollowPageOptions): Promise<CreatorFollowPage<F>> {
    const pageOptions = structuredClone(options);
    await this.access(userId, 'list');
    const store = this.store as CreatorFollowPort<F> & Partial<CreatorFollowPagePort<F>>;
    if (!store.listFollowPage) throw new Error('Follow pagination is not supported by this adapter.');
    const page = structuredClone(await store.listFollowPage(userId, pageOptions));
    if (page.items.some(follow => follow.followerUserId !== userId)) throw new CreatorFollowError('access_denied', 'Invalid follow page scope.');
    await this.access(userId, 'list');
    return page;
  }
  async follow(userId: string, record: F): Promise<F> {
    const follow = structuredClone(record);
    await this.access(userId, 'follow', follow.creatorId);
    if (follow.followerUserId !== userId || !follow.creatorId.trim() || !follow.followId.trim() ||
      !follow.insertedDate || typeof follow.notificationsEnabled !== 'boolean') {
      throw new CreatorFollowError('invalid_follow', 'Invalid creator follow.');
    }
    await this.store.followCreator(follow);
    return structuredClone(follow);
  }
  async unfollow(userId: string, creatorId: string): Promise<void> {
    await this.access(userId, 'unfollow', creatorId);
    if (!creatorId.trim()) throw new CreatorFollowError('invalid_follow', 'Creator ID is required.');
    await this.store.unfollowCreator(userId, creatorId);
  }
}
