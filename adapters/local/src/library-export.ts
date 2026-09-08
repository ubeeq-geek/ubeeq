import type { CreatorWorkRecord, CreatorAssetRecord, CreatorAssetAttachment, CreatorCollectionRecord, CreatorCollectionMembership } from '@ubeeq/core';
import type { LocalSqliteDatabase } from './index.js';
import type { FavoriteRecord } from '@ubeeq/core';

export interface CreatorLibrarySnapshot {
  works: CreatorWorkRecord[];
  assets: Omit<CreatorAssetRecord, 'processingJobId'>[];
  attachments: CreatorAssetAttachment[];
  collections: CreatorCollectionRecord[];
  memberships: CreatorCollectionMembership[];
  favorites: FavoriteRecord[];
}

/** Consistent metadata snapshot, not an authorized export endpoint. The caller
 * must authorize the Creator and apply export policy to every returned resource.
 * Includes detached/deleted records; excludes queue state and object bytes. */
export const readCreatorLibrarySnapshot = (local: LocalSqliteDatabase,
  scope: { tenantId: string; creatorId: string }, limits: { maxRows?: number; maxBytes?: number } = {}): CreatorLibrarySnapshot => {
  const maxRows = limits.maxRows ?? 50_000, maxBytes = limits.maxBytes ?? 20 * 1024 * 1024;
  if (![scope.tenantId, scope.creatorId].every(value => typeof value === 'string' && value.trim()) ||
    ![maxRows, maxBytes].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('Invalid library snapshot scope or budget.');
  const db = local.database, parameters = [local.configuration.cellId, scope.tenantId, scope.creatorId];
  db.exec('BEGIN');
  try {
    const size = db.prepare(`SELECT count(*) AS rows, coalesce(sum(length(CAST(payload AS BLOB))), 0) AS bytes
      FROM ubeeq_creator_library WHERE cell_id = ? AND tenant_id = ? AND creator_id = ?`).get(...parameters) as { rows: number; bytes: number };
    const favoriteSize = db.prepare(`SELECT count(*) AS rows, coalesce(sum(length(CAST(payload AS BLOB))), 0) AS bytes
      FROM ubeeq_favorites WHERE cell_id = ? AND tenant_id = ? AND profile_type = 'creator' AND profile_id = ?`).get(...parameters) as { rows: number; bytes: number };
    if (size.rows + favoriteSize.rows > maxRows || size.bytes + favoriteSize.bytes > maxBytes) throw new Error('Creator library exceeds snapshot budget; no partial export was produced.');
    const rows = db.prepare('SELECT kind, id, payload FROM ubeeq_creator_library WHERE cell_id = ? AND tenant_id = ? AND creator_id = ? ORDER BY kind, id')
      .all(...parameters) as Array<{ kind: string; id: string; payload: string }>;
    const snapshot: CreatorLibrarySnapshot = { works: [], assets: [], attachments: [], collections: [], memberships: [], favorites: [] };
    const favoriteRows = db.prepare(`SELECT target_type, target_id, payload FROM ubeeq_favorites
      WHERE cell_id = ? AND tenant_id = ? AND profile_type = 'creator' AND profile_id = ? ORDER BY target_type, target_id`).all(...parameters) as Array<{ target_type: string; target_id: string; payload: string }>;
    for (const row of favoriteRows) {
      const value = JSON.parse(row.payload);
      if (!value || value.ownerProfileType !== 'creator' || value.ownerProfileId !== scope.creatorId ||
        value.targetType !== row.target_type || value.targetId !== row.target_id || !['public', 'private'].includes(value.visibility) ||
        typeof value.userId !== 'string' || !value.userId.trim() || typeof value.createdAt !== 'string' || !value.createdAt) throw new Error('Invalid favorite snapshot scope or record.');
      snapshot.favorites.push(value);
    }
    for (const row of rows) {
      const value = JSON.parse(row.payload);
      if (row.kind === 'work_assets' || row.kind === 'membership') {
        const parent = row.kind === 'work_assets' ? 'workId' : 'collectionId';
        if (!Array.isArray(value) || value.some(item => !item || item[parent] !== row.id)) throw new Error('Invalid library membership scope.');
        if (row.kind === 'work_assets') snapshot.attachments.push(...value); else snapshot.memberships.push(...value);
        continue;
      }
      const idField = { work: 'workId', asset: 'assetId', collection: 'collectionId' }[row.kind];
      if (!idField || !value || value[idField] !== row.id || value.tenantId !== scope.tenantId || value.creatorId !== scope.creatorId) {
        throw new Error('Unknown record kind or foreign library identity.');
      }
      if (row.kind === 'work') snapshot.works.push(value);
      else if (row.kind === 'collection') snapshot.collections.push(value);
      else {
        const { processingJobId: _jobFence, ...asset } = value;
        snapshot.assets.push(asset);
      }
    }
    const works = new Set(snapshot.works.map(work => work.workId));
    const assets = new Set(snapshot.assets.map(asset => asset.assetId));
    const collections = new Set(snapshot.collections.map(collection => collection.collectionId));
    const attachmentKeys = snapshot.attachments.map(item => JSON.stringify([item.workId, item.assetId]));
    const membershipKeys = snapshot.memberships.map(item => JSON.stringify([item.collectionId, item.workId]));
    if (new Set(attachmentKeys).size !== attachmentKeys.length || new Set(membershipKeys).size !== membershipKeys.length ||
      snapshot.attachments.some(item => !works.has(item.workId) || !assets.has(item.assetId)) ||
      snapshot.memberships.some(item => !collections.has(item.collectionId) || !works.has(item.workId))) {
      throw new Error('Dangling or duplicate library relationship.');
    }
    db.exec('COMMIT');
    return snapshot;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
};
