import test from 'node:test';
import assert from 'node:assert/strict';
import { FavoriteService } from '../dist/index.js';

test('favorite operations enforce admission, preserve delegated scope and own callback snapshots', async () => {
  const calls = []; let allowed = true;
  const service = new FavoriteService({ addFavorite: async record => { calls.push(structuredClone(record)); record.targetId = 'mutated'; },
    removeFavorite: async (...args) => calls.push(args) }, async (operation, target) => { target.userId = 'mutated'; return allowed; });
  const record = { userId: 'actor', ownerProfileType: 'creator', ownerProfileId: 'owner', targetType: 'work', targetId: 'target', visibility: 'private', createdAt: 'now' };
  assert.deepEqual(await service.add(record), record);
  await service.remove(record);
  assert.deepEqual(calls[1], ['actor', 'work', 'target', 'creator', 'owner']);
  allowed = false;
  await assert.rejects(service.add(record), { code: 'access_denied' });
  await assert.rejects(service.remove(record), { code: 'access_denied' });
  allowed = true;
  for (const invalid of [{ ...record, userId: '' }, { ...record, targetId: 12 }, { ...record, visibility: 'unknown' }]) await assert.rejects(service.add(invalid), { code: 'invalid_favorite' });
  assert.equal(calls.length, 2);
  const failing = new FavoriteService({ addFavorite: async () => { throw new Error('storage failed'); } }, async () => true);
  await assert.rejects(failing.add(record), /storage failed/);
});
