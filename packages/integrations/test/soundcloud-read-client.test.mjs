import test from 'node:test';
import assert from 'node:assert/strict';
import { SoundCloudReadClient, SoundCloudTransport } from '../dist/index.js';
const credentials = { clientId: 'synthetic', clientSecret: 'synthetic-secret', redirectUri: 'https://example.test/callback' };
const fixture = responder => {
  const calls = [];
  const client = new SoundCloudReadClient(new SoundCloudTransport(credentials, async (url, options) => {
    calls.push([url, options]); return Response.json(await responder(new URL(url), calls.length));
  }));
  return { client, calls };
};
test('read client selects encoded endpoints and executes shared mapping through real bounded transport', async () => {
  const payloads = [{ id: 1, username: 'Artist' }, { full_name: ' Name ' }, { id: 2, title: 'Track' },
    { tracks: [{ id: 2 }] }, { collection: [{ id: 3, body: 'Comment' }] }, { collection: [{ id: 4, username: 'Fan' }] },
    { collection: [{ urn: 'event:1', type: 'track-like' }] }];
  const { client, calls } = fixture((_url, count) => payloads[count - 1]);
  assert.equal((await client.getAccount('token')).externalUserId, '1');
  assert.equal((await client.getProfile('token', 'user:/1')).realName, 'Name');
  assert.equal((await client.getContent('token', 'track:/2')).externalContentId, '2');
  assert.equal((await client.listCollectionContent('token', 'playlist:/1')).items[0].externalContentId, '2');
  assert.equal((await client.listComments('token', 'track:/2')).items[0].body, 'Comment');
  assert.equal((await client.listFavourites('token', 'track:/2')).items[0].username, 'Fan');
  assert.equal((await client.listFeed('token')).items[0].remoteActivityId, 'soundcloud:event:1');
  assert.deepEqual(calls.map(([url]) => url.replace('https://api.soundcloud.com', '')), ['/me', '/users/user%3A%2F1', '/tracks/track%3A%2F2',
    '/playlists/playlist%3A%2F1', '/tracks/track%3A%2F2/comments?linked_partitioning=true&limit=100',
    '/tracks/track%3A%2F2/favoriters?linked_partitioning=true&limit=100', '/me/feed?linked_partitioning=true&limit=50']);
  for (const [, options] of calls) { assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error'); assert.equal(options.headers.Authorization, 'OAuth token'); }
});
test('single-page reads expose continuation, preserve limit clamping and reject foreign cursors before fetch', async () => {
  const next = 'https://api.soundcloud.com/me/tracks?cursor=next';
  const { client, calls } = fixture(() => ({ collection: [{ id: 1 }], next_href: next }));
  assert.equal((await client.listContent('token', { limit: 999 })).nextCursor, next);
  assert.match(calls[0][0], /limit=200$/);
  await client.listContent('token', { cursor: next }); assert.equal(calls[1][0], next);
  await assert.rejects(client.listComments('token', '1', 'https://example.test/steal'), { code: 'invalid_response' });
  assert.equal(calls.length, 2);
});
test('playlist traversal follows empty pages and fails cycles or malformed identities without partial success', async () => {
  const complete = fixture((_url, count) => count === 1 ? { collection: [], next_href: 'https://api.soundcloud.com/me/playlists?cursor=2' } : { collection: [{ id: 2 }] });
  assert.equal((await complete.client.listCollections('token'))[0].externalCollectionId, '2'); assert.equal(complete.calls.length, 2);
  for (const payload of [{}, { collection: null }, { collection: [{}] }]) await assert.rejects(fixture(() => payload).client.listCollections('token'), { code: 'invalid_response' });
  const cycle = fixture(() => ({ collection: [], next_href: 'https://api.soundcloud.com/me/playlists?linked_partitioning=true&limit=50' }));
  await assert.rejects(cycle.client.listCollections('token'), { code: 'invalid_response' }); assert.equal(cycle.calls.length, 1);
});
test('playlist budget requires a complete terminal page; single-resource identity failures propagate', async () => {
  for (const complete of [false, true]) {
    const run = fixture((_url, count) => ({ collection: [{ id: count }], ...(complete && count === 20 ? {} : { next_href: `https://api.soundcloud.com/me/playlists?cursor=${count}` }) }));
    if (complete) assert.equal((await run.client.listCollections('token')).length, 20);
    else await assert.rejects(run.client.listCollections('token'), { code: 'preflight_blocked' });
    assert.equal(run.calls.length, 20);
  }
  const invalid = fixture(() => ({}));
  await assert.rejects(invalid.client.getAccount('token'), { code: 'invalid_response' });
  await assert.rejects(invalid.client.getContent('token', '1'), { code: 'invalid_response' });
});
