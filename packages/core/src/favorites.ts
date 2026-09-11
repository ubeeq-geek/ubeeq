export interface FavoriteTarget {
  userId: string; ownerProfileType: string; ownerProfileId: string; targetType: string; targetId: string;
}
export interface FavoriteRecord extends FavoriteTarget { visibility: 'public' | 'private'; createdAt: string }
export interface FavoritePort<F extends FavoriteRecord> {
  addFavorite(record: F): Promise<void>;
  removeFavorite(userId: string, targetType: F['targetType'], targetId: string, ownerProfileType: F['ownerProfileType'], ownerProfileId: string): Promise<void>;
}
export class FavoriteError extends Error {
  constructor(readonly code: 'access_denied' | 'invalid_favorite') { super(code); this.name = 'FavoriteError'; }
}
/** Tenant-bound store. Product admission owns target eligibility and delegated
 * profile access. Storage owns atomic pair replacement/removal; callers own
 * request idempotency, rate limits, audit and public response projection. */
export class FavoriteService<F extends FavoriteRecord> {
  constructor(private readonly store: FavoritePort<F>, private readonly authorize:
    (operation: 'add' | 'remove', target: FavoriteTarget) => Promise<boolean>) {}
  private async admit(operation: 'add' | 'remove', target: FavoriteTarget) {
    if (![target.userId, target.ownerProfileType, target.ownerProfileId, target.targetType, target.targetId]
      .every(value => typeof value === 'string' && Boolean(value.trim()))) throw new FavoriteError('invalid_favorite');
    if (!await this.authorize(operation, structuredClone(target))) throw new FavoriteError('access_denied');
  }
  async add(record: F): Promise<F> {
    const favorite = structuredClone(record);
    await this.admit('add', favorite);
    if (!['public', 'private'].includes(favorite.visibility) || typeof favorite.createdAt !== 'string' || !favorite.createdAt) throw new FavoriteError('invalid_favorite');
    await this.store.addFavorite(structuredClone(favorite));
    return favorite;
  }
  async remove(record: FavoriteTarget & Pick<F, 'targetType' | 'ownerProfileType'>): Promise<void> {
    const target = structuredClone(record);
    await this.admit('remove', target);
    await this.store.removeFavorite(target.userId, target.targetType, target.targetId, target.ownerProfileType, target.ownerProfileId);
  }
}
