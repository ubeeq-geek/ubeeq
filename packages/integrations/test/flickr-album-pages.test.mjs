import test from 'node:test';
import assert from 'node:assert/strict';
import { FlickrClient } from '../dist/index.js';
const credentials = { token: 'token', tokenSecret: 'secret' };
const create = payload => new FlickrClient('key', 'secret', async () => new Response(JSON.stringify({ stat: 'ok', ...payload })));

test('album page methods perform one request and retain provider order and pagination', async () => {
  let calls = 0;
  const client = new FlickrClient('key', 'secret', async url => {
    calls++;
    const params = new URL(url).searchParams;
    assert.equal(params.get('page'), '2'); assert.equal(params.get('per_page'), '2');
    return new Response(JSON.stringify({ stat: 'ok', ...(params.get('method') === 'flickr.photosets.getList'
      ? { photosets: { page: '2', pages: '3', photoset: [{ id: 'b', title: 'B' }, { id: 'a' }] } }
      : { photoset: { id: 'album', page: 2, pages: 3, photo: [{ id: 'z' }, { id: 'y' }] } }) }));
  });
  assert.deepEqual(await client.albumsPage(credentials, 2, 2), { page: 2, pages: 3, albums: [{ id: 'b', title: 'B' }, { id: 'a' }] });
  assert.equal(calls, 1);
  assert.deepEqual(await client.albumPhotoIdsPage(credentials, 'album', 2, 2), { page: 2, pages: 3, photoIds: ['z', 'y'] });
  assert.equal(calls, 2);
});

test('album pagination rejects invalid requests before network calls', async () => {
  let calls = 0;
  const client = new FlickrClient('key', 'secret', async () => { calls++; throw Error(); });
  for (const [page, size] of [[0, 1], [1.5, 1], [Number.MAX_SAFE_INTEGER, 1], [1, 0], [1, 501]]) {
    await assert.rejects(client.albumsPage(credentials, page, size), /pagination/);
    await assert.rejects(client.albumPhotoIdsPage(credentials, 'album', page, size), /pagination/);
  }
  await assert.rejects(client.albumPhotoIdsPage(credentials, '', 1), /identity/);
  assert.equal(calls, 0);
});

test('album page responses reject missing, inconsistent, duplicate and over-limit records', async () => {
  for (const bad of [undefined, {}, { page: 2, pages: 2, photoset: [] }, { page: 1, pages: 'bad', photoset: [] },
    { page: 1, pages: 0, photoset: [{ id: 'a' }] }, { page: 1, pages: 1, photoset: [{}] },
    { page: 1, pages: 1, photoset: [{ id: 'a' }, { id: 'a' }] }, { page: 1, pages: 1, photoset: [{ id: 'a' }, { id: 'b' }] }]) {
    await assert.rejects(create({ photosets: bad }).albumsPage(credentials, 1, 1), /Invalid Flickr album/);
    const mapped = bad && { ...bad, id: 'album', photo: bad.photoset };
    await assert.rejects(create({ photoset: mapped }).albumPhotoIdsPage(credentials, 'album', 1, 1), /Invalid Flickr album/);
  }
  await assert.rejects(create({ photoset: { id: 'other', page: 1, pages: 1, photo: [] } }).albumPhotoIdsPage(credentials, 'album', 1), /identity/);
  const duplicates = [{ id: 'same' }, { id: 'same' }];
  await assert.rejects(create({ photosets: { page: 1, pages: 1, photoset: duplicates } }).albumsPage(credentials, 1, 2), /page item/);
  await assert.rejects(create({ photoset: { id: 'album', page: 1, pages: 1, photo: duplicates } }).albumPhotoIdsPage(credentials, 'album', 1, 2), /page item/);
  assert.deepEqual(await create({ photosets: { page: 1, pages: 0, photoset: [] } }).albumsPage(credentials, 1), { page: 1, pages: 0, albums: [] });
});
