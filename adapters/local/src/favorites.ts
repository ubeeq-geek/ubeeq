import type { FavoritePort, FavoriteRecord } from '@ubeeq/core';
import type { LocalSqliteDatabase } from './index.js';

/** Tenant-bound persistence only. Products must authorize profile delegation and
 * target eligibility through the shared service before writes or exposing reads. */
export class LocalFavoriteStore<F extends FavoriteRecord = FavoriteRecord> implements FavoritePort<F> {
  constructor(private readonly local: LocalSqliteDatabase, private readonly tenantId: string) {
    if (!tenantId.trim()) throw new Error('Favorite tenant is required.');
  }
  private scope() { return [this.local.configuration.cellId, this.tenantId]; }
  async addFavorite(record: F): Promise<void> {
    const favorite = structuredClone(record);
    if (![favorite.userId, favorite.ownerProfileType, favorite.ownerProfileId, favorite.targetType, favorite.targetId, favorite.createdAt]
      .every(value => typeof value === 'string' && Boolean(value.trim())) || !['public', 'private'].includes(favorite.visibility)) throw new Error('Invalid favorite.');
    this.local.database.prepare(`INSERT INTO ubeeq_favorites
      (cell_id, tenant_id, profile_type, profile_id, target_type, target_id, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`).run(...this.scope(), favorite.ownerProfileType, favorite.ownerProfileId, favorite.targetType, favorite.targetId, JSON.stringify(favorite));
  }
  async removeFavorite(_userId: string, targetType: F['targetType'], targetId: string, profileType: F['ownerProfileType'], profileId: string): Promise<void> {
    this.local.database.prepare(`DELETE FROM ubeeq_favorites WHERE cell_id = ? AND tenant_id = ?
      AND profile_type = ? AND profile_id = ? AND target_type = ? AND target_id = ?`).run(...this.scope(), profileType, profileId, targetType, targetId);
  }
  async listByProfile(profileType: string, profileId: string): Promise<F[]> {
    const rows = this.local.database.prepare(`SELECT payload FROM ubeeq_favorites WHERE cell_id = ? AND tenant_id = ?
      AND profile_type = ? AND profile_id = ? ORDER BY target_type, target_id`).all(...this.scope(), profileType, profileId) as Array<{ payload: string }>;
    return rows.map(row => JSON.parse(row.payload) as F);
  }
  /** Exact scoped identity lookup; does not confer profile or target access. */
  async getFavorite(profileType: string, profileId: string, targetType: string, targetId: string): Promise<F | undefined> {
    if (![profileType, profileId, targetType, targetId].every(value => typeof value === 'string' && Boolean(value.trim()))) throw new Error('Invalid favorite lookup.');
    const row = this.local.database.prepare(`SELECT payload FROM ubeeq_favorites WHERE cell_id = ? AND tenant_id = ?
      AND profile_type = ? AND profile_id = ? AND target_type = ? AND target_id = ?`).get(...this.scope(), profileType, profileId, targetType, targetId) as { payload: string } | undefined;
    if (!row) return undefined;
    const favorite = JSON.parse(row.payload) as F;
    if (favorite.ownerProfileType !== profileType || favorite.ownerProfileId !== profileId || favorite.targetType !== targetType || favorite.targetId !== targetId) throw new Error('Favorite identity mismatch.');
    return favorite;
  }
  /** Counts canonical rows, not a separately updated counter that can drift. */
  async countByTarget(targetType: string, targetId: string): Promise<number> {
    const row = this.local.database.prepare(`SELECT COUNT(*) AS total FROM ubeeq_favorites
      WHERE cell_id = ? AND tenant_id = ? AND target_type = ? AND target_id = ?`).get(...this.scope(), targetType, targetId) as { total: number };
    return row.total;
  }
}
