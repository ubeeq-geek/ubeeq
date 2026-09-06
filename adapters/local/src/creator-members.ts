import type { CreatorMemberPort, CreatorMemberRecord } from '@ubeeq/core';
import type { LocalSqliteDatabase } from './index.js';

/** One instance/tenant per port; cell and tenant are enforced on every statement. */
export class LocalCreatorMemberStore implements CreatorMemberPort<CreatorMemberRecord> {
  constructor(private readonly local: LocalSqliteDatabase, private readonly tenantId: string) {
    if (!tenantId) throw new Error('Membership tenant is required.');
  }
  async listCreatorMembers(creatorId: string): Promise<CreatorMemberRecord[]> {
    const rows = this.local.database.prepare("SELECT payload FROM ubeeq_creator_library WHERE cell_id = ? AND tenant_id = ? AND kind = 'creator_member' AND creator_id = ? ORDER BY id")
      .all(this.local.configuration.cellId, this.tenantId, creatorId) as { payload: string }[];
    return rows.map(row => JSON.parse(row.payload));
  }
  async addCreatorMember(member: CreatorMemberRecord): Promise<void> {
    this.local.database.prepare("INSERT INTO ubeeq_creator_library (cell_id, tenant_id, kind, id, creator_id, payload) VALUES (?, ?, 'creator_member', ?, ?, ?) ON CONFLICT(cell_id, tenant_id, kind, id) DO UPDATE SET payload = excluded.payload")
      .run(this.local.configuration.cellId, this.tenantId, JSON.stringify([member.creatorId, member.userId]), member.creatorId, JSON.stringify(member));
  }
  async removeCreatorMember(creatorId: string, userId: string): Promise<void> {
    this.local.database.prepare("DELETE FROM ubeeq_creator_library WHERE cell_id = ? AND tenant_id = ? AND kind = 'creator_member' AND id = ? AND creator_id = ?")
      .run(this.local.configuration.cellId, this.tenantId, JSON.stringify([creatorId, userId]), creatorId);
  }
}
