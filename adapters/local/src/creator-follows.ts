import type { CreatorFollowPort, CreatorFollowRecord } from '@ubeeq/core';
import type { LocalSqliteDatabase } from './index.js';

/** Tenant-bound persistence. Following never grants content access by itself. */
export class LocalCreatorFollowStore<F extends CreatorFollowRecord = CreatorFollowRecord> implements CreatorFollowPort<F> {
  constructor(private readonly local: LocalSqliteDatabase, private readonly tenantId: string) {
    if (!tenantId.trim()) throw new Error('Follow tenant is required.');
  }
  private scope() { return [this.local.configuration.cellId, this.tenantId]; }
  async listFollowsByUser(userId: string): Promise<F[]> {
    const rows = this.local.database.prepare(`SELECT creator_id, payload FROM ubeeq_creator_follows
      WHERE cell_id = ? AND tenant_id = ? AND user_id = ? ORDER BY creator_id`).all(...this.scope(), userId) as Array<{ creator_id: string; payload: string }>;
    return rows.map(row => {
      const value = JSON.parse(row.payload) as F;
      if (value.followerUserId !== userId || value.creatorId !== row.creator_id) throw new Error('Invalid stored follow scope.');
      return value;
    });
  }
  async followCreator(record: F): Promise<void> {
    const follow = structuredClone(record);
    if (![follow.followId, follow.followerUserId, follow.creatorId, follow.insertedDate].every(value => typeof value === 'string' && Boolean(value.trim())) ||
      typeof follow.notificationsEnabled !== 'boolean') throw new Error('Invalid follow record.');
    this.local.database.prepare(`INSERT INTO ubeeq_creator_follows (cell_id, tenant_id, user_id, creator_id, payload)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT (cell_id, tenant_id, user_id, creator_id) DO UPDATE SET payload = excluded.payload`)
      .run(...this.scope(), follow.followerUserId, follow.creatorId, JSON.stringify(follow));
  }
  async unfollowCreator(userId: string, creatorId: string): Promise<void> {
    this.local.database.prepare(`DELETE FROM ubeeq_creator_follows WHERE cell_id = ? AND tenant_id = ? AND user_id = ? AND creator_id = ?`)
      .run(...this.scope(), userId, creatorId);
  }
}
