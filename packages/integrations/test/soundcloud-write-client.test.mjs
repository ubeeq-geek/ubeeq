import test from 'node:test';
import assert from 'node:assert/strict';
import { SoundCloudTransport, SoundCloudWriteClient } from '../dist/index.js';
const credentials = { clientId: 'synthetic', clientSecret: 'synthetic-secret', redirectUri: 'https://example.test/callback' };
test('metadata updates preserve explicit clearing, false values and no-op requests', async () => {
  const calls = [];
  const client = new SoundCloudWriteClient(new SoundCloudTransport(credentials, async (url, options) => {
    calls.push([url, options]); return Response.json({ id: 1 });
  }));
  assert.equal(calls.length, 0);
  await client.updateContent('token', 'track:/1', {}); assert.equal(calls.length, 0);
  await client.updateContent('token', 'track:/1', { title: 'Title & more', description: '', tags: [], allowComments: false });
  assert.equal(calls[0][0], 'https://api.soundcloud.com/tracks/track%3A%2F1');
  assert.equal(calls[0][1].method, 'PUT'); assert.equal(calls[0][1].redirect, 'error');
  assert.deepEqual(Object.fromEntries(calls[0][1].body ? new URLSearchParams(calls[0][1].body) : []), {
    'track[title]': 'Title & more', 'track[description]': '', 'track[tag_list]': '', 'track[commentable]': 'false'
  });
});
test('state operations use encoded paths, accept empty success and ignore only delete 404s', async () => {
  const methods = ['likeContent', 'unlikeContent', 'repostContent', 'unrepostContent', 'followUser', 'unfollowUser', 'deleteContent'];
  const paths = ['/likes/tracks/', '/likes/tracks/', '/reposts/tracks/', '/reposts/tracks/', '/me/followings/', '/me/followings/', '/tracks/'];
  for (let i = 0; i < methods.length; i++) {
    let status = 204, calls = 0;
    const deletion = methods[i].startsWith('un') || methods[i] === 'deleteContent';
    const client = new SoundCloudWriteClient(new SoundCloudTransport(credentials, async (url, options) => {
      calls++; assert.equal(url, `https://api.soundcloud.com${paths[i]}item%3A%2F1`);
      assert.equal(options.method, deletion ? 'DELETE' : 'PUT');
      return new Response(null, { status });
    }));
    await client[methods[i]]('token', 'item:/1');
    status = 404;
    if (deletion) await client[methods[i]]('token', 'item:/1');
    else await assert.rejects(client[methods[i]]('token', 'item:/1'), { code: 'invalid_response' });
    assert.equal(calls, 2);
  }
});
test('timed comment mapping preserves timestamp normalization and requires a receipt identity', async () => {
  let payload = { id: 7, body: 'Hello', timestamp: 12 }, calls = [];
  const client = new SoundCloudWriteClient(new SoundCloudTransport(credentials, async (url, options) => {
    calls.push([url, options]); return Response.json(payload);
  }));
  assert.equal((await client.postTimedComment('token', 'track:1', 'Hello', 12.9)).externalCommentId, '7');
  assert.equal(new URLSearchParams(calls[0][1].body).get('comment[timestamp]'), '12');
  assert.equal(calls[0][0], 'https://api.soundcloud.com/tracks/track%3A1/comments');
  await client.postTimedComment('token', 'track:1', 'Hello', -1);
  assert.equal(new URLSearchParams(calls[1][1].body).get('comment[timestamp]'), '0');
  await client.postTimedComment('token', 'track:1', 'Hello');
  assert.equal(new URLSearchParams(calls[2][1].body).has('comment[timestamp]'), false);
  payload = {};
  await assert.rejects(client.postTimedComment('token', 'track:1', 'Hello'), { code: 'ambiguous_submission' });
  assert.equal(calls.length, 4);
});
test('write uncertainty propagates without automatic retry and known HTTP errors keep their category', async () => {
  for (const [response, code] of [[() => { throw new Error('lost'); }, 'ambiguous_submission'],
    [() => new Response('broken'), 'ambiguous_submission'], [() => Response.json({}, { status: 401 }), 'authentication_required']]) {
    let calls = 0;
    const client = new SoundCloudWriteClient(new SoundCloudTransport(credentials, async () => { calls++; return response(); }));
    await assert.rejects(client.postTimedComment('token', '1', 'Hello'), { code });
    assert.equal(calls, 1);
  }
});
