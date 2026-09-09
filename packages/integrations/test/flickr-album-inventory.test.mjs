import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceFlickrAlbumInventory, initialFlickrAlbumInventory } from '../dist/index.js';
test('album continuation makes one page call per step and preserves snapshots and member order', async () => {
  let calls = 0;
  const client = { albumsPage: async (_, page) => { calls++; return { page, pages: 2, albums: [{ id: `a${page}` }] }; },
    albumPhotoIdsPage: async (_, id, page) => { calls++; return { page, pages: 2, photoIds: [`${id}-${page}`] }; } };
  let state = initialFlickrAlbumInventory();
  for (let i = 0; i < 6; i++) {
    const before = structuredClone(state);
    const next = await advanceFlickrAlbumInventory(client, {}, state);
    assert.deepEqual(state, before); state = next; assert.equal(calls, i + 1);
  }
  assert.equal(state.phase, 'complete');
  assert.deepEqual(state.albums.map(a => a.orderedRemotePhotoIds), [['a1-1', 'a1-2'], ['a2-1', 'a2-2']]);
  assert.deepEqual(await advanceFlickrAlbumInventory(client, {}, state), state); assert.equal(calls, 6);
});
test('duplicate cross-page members fail without changing the prior checkpoint', async () => {
  const state = { phase: 'members', page: 2, albumIndex: 0, albums: [{ remoteAlbumId: 'a', orderedRemotePhotoIds: ['p'] }] };
  await assert.rejects(advanceFlickrAlbumInventory({ albumPhotoIdsPage: async () => ({ page: 2, pages: 2, photoIds: ['p'] }) }, {}, state), /changed across pages/);
  assert.deepEqual(state.albums[0].orderedRemotePhotoIds, ['p']);
});
