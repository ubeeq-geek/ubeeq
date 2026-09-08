import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalFavoriteStore, LocalSqliteDatabase } from '../dist/index.js';

test('favorite pages are scoped, bounded and resume by target after deletion and restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ubeeq-favorite-pages-'));
  const config = { databasePath: join(directory, 'state.sqlite'), dataDirectory: directory, cellId: 'cell', publicBaseUrl: 'http://localhost' };
  let local = new LocalSqliteDatabase(config);
  try {
    let store = new LocalFavoriteStore(local, 'tenant');
    const base = { userId: 'actor', ownerProfileType: 'creator', ownerProfileId: 'profile', targetType: 'work', visibility: 'private', createdAt: 'now' };
    for (const targetId of ['c', 'a', 'b']) await store.addFavorite({ ...base, targetId });
    await store.addFavorite({ ...base, targetId: 'a', targetType: 'collection' });
    await store.addFavorite({ ...base, targetId: 'foreign', ownerProfileId: 'other' });
    await new LocalFavoriteStore(local, 'foreign').addFavorite({ ...base, targetId: 'foreign' });
    store.listByProfile = () => { throw new Error('must not enumerate'); };
    const first = await store.listFavoritePage('creator', 'profile', 'work', { limit: 1 });
    assert.deepEqual(first.items.map(item => item.targetId), ['a']); assert.equal(first.nextAfterTargetId, 'a');
    await store.removeFavorite('actor', 'work', 'a', 'creator', 'profile');
    local.database.close(); local = new LocalSqliteDatabase(config); store = new LocalFavoriteStore(local, 'tenant');
    const next = await store.listFavoritePage('creator', 'profile', 'work', { limit: 2, afterTargetId: first.nextAfterTargetId });
    assert.deepEqual(next.items.map(item => item.targetId), ['b', 'c']); assert.equal(next.nextAfterTargetId, undefined);
    assert.deepEqual(await store.listFavoritePage('creator', 'profile', 'work', { limit: 1, afterTargetId: 'z' }), { items: [] });
    assert.deepEqual(await store.listFavoritePage('user', 'profile', 'work', { limit: 1 }), { items: [] });
    for (const options of [{ limit: 0 }, { limit: 101 }, { limit: NaN }, { limit: 1.5 }, { limit: 1, afterTargetId: '' }]) await assert.rejects(store.listFavoritePage('creator', 'profile', 'work', options), /Invalid favorite page/);
  } finally { local.database.close(); rmSync(directory, { recursive: true, force: true }); }
});
