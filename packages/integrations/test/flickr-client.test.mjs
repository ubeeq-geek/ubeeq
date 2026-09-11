import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { FlickrClient } from '../dist/index.js';

const credentials = { token: 'fixture-token', tokenSecret: 'fixture-secret' };
const json = value => new Response(JSON.stringify({ stat: 'ok', ...value }));
const encode = value => encodeURIComponent(value).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);

test('Flickr shared OAuth exchanges sign callback and verifier without transmitting secrets', async () => {
  const calls = [];
  const client = new FlickrClient('fixture-key', 'consumer&secret', async (url, init) => {
    const params = new URLSearchParams(init.body);
    const signature = params.get('oauth_signature'); params.delete('oauth_signature');
    const normalized = [...params].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${encode(k)}=${encode(v)}`).join('&');
    const base = ['POST', encode(url), encode(normalized)].join('&');
    assert.equal(signature, createHmac('sha1', `${encode('consumer&secret')}&${calls.length ? encode('request-secret') : ''}`).update(base).digest('base64'));
    assert.equal(init.method, 'POST'); assert.equal(params.get('oauth_consumer_key'), 'fixture-key');
    assert.ok(params.get('oauth_nonce')); assert.ok(params.get('oauth_timestamp'));
    assert.ok(!String(init.body).includes('consumer%26secret'));
    calls.push({ url, params });
    return new Response(calls.length === 1 ? 'oauth_token=request-token&oauth_token_secret=request-secret&oauth_callback_confirmed=true' : 'oauth_token=access-token&oauth_token_secret=access-secret&user_nsid=owner%40N01');
  });
  const callback = 'https://app.example/oauth/callback?state=a!b';
  const request = await client.requestToken(callback);
  const access = await client.accessToken(request.get('oauth_token'), request.get('oauth_token_secret'), 'verifier');
  assert.equal(access.get('user_nsid'), 'owner@N01');
  assert.equal(calls[0].url, 'https://www.flickr.com/services/oauth/request_token');
  assert.equal(calls[0].params.get('oauth_callback'), callback);
  assert.equal(calls[1].url, 'https://www.flickr.com/services/oauth/access_token');
  assert.equal(calls[1].params.get('oauth_verifier'), 'verifier');
  assert.equal(calls[1].params.get('oauth_token'), 'request-token');
});

test('Flickr shared inventory preserves metadata, owner scope and page size ceiling', async () => {
  const photos = [{ id: '1', description: { _content: 'Caption' }, url_o: 'https://images.example/original', license: '4', media: 'photo' }];
  const client = new FlickrClient('key', 'secret', async url => {
    const params = new URL(url).searchParams;
    assert.equal(params.get('method'), 'flickr.people.getPhotos'); assert.equal(params.get('user_id'), 'me');
    assert.equal(params.get('page'), '2'); assert.equal(params.get('per_page'), '500');
    assert.ok(params.get('extras').includes('original_format'));
    assert.equal(params.get('oauth_token'), credentials.token); assert.ok(params.get('oauth_signature'));
    return json({ photos: { page: '2', pages: '3', photo: photos } });
  });
  assert.deepEqual(await client.inventoryPage(credentials, 2, 700), { page: 2, pages: 3, photos });
});

test('Flickr shared album reads retry throttling and preserve all pages and photo IDs', async () => {
  const urls = [], responses = [new Response('limited', { status: 429, headers: { 'retry-after': '0' } }),
    json({ photosets: { pages: 2, photoset: [{ id: 'a' }] } }), json({ photosets: { pages: 2, photoset: [{ id: 'b' }] } }),
    json({ photoset: { pages: 2, photo: [{ id: 'p1' }, {}] } }), json({ photoset: { pages: 2, photo: [{ id: 'p2' }] } })];
  const client = new FlickrClient('key', 'secret', async url => { urls.push(new URL(url)); return responses.shift(); });
  assert.deepEqual(await client.albums(credentials), [{ id: 'a' }, { id: 'b' }]);
  assert.deepEqual(await client.albumPhotoIds(credentials, 'a'), ['p1', 'p2']);
  assert.deepEqual(urls.map(url => url.searchParams.get('page')), ['1', '1', '2', '1', '2']);
  assert.equal(urls[3].searchParams.get('photoset_id'), 'a');
});

test('Flickr shared failures retain retry limits and do not retry token exchanges or transport failures', async () => {
  for (const status of [403, 429, 503]) {
    let calls = 0;
    const client = new FlickrClient('key', 'secret', async () => { calls++; return new Response('', { status, headers: { 'retry-after': '0' } }); });
    await assert.rejects(client.inventoryPage(credentials, 1), new RegExp(`Flickr API request failed \\(${status}\\)`));
    assert.equal(calls, status === 403 ? 1 : 3);
  }
  for (const response of [new Response('', { status: 503 }), new Response('oauth_token=only')]) {
    let calls = 0;
    const client = new FlickrClient('key', 'secret', async () => { calls++; return response; });
    await assert.rejects(client.requestToken('https://app.example/callback'), /Flickr OAuth/);
    assert.equal(calls, 1);
  }
  const failure = new Error('transport failure'); let calls = 0;
  const client = new FlickrClient('key', 'secret', async () => { calls++; throw failure; });
  await assert.rejects(client.inventoryPage(credentials, 1), error => error === failure);
  assert.equal(calls, 1);
  await assert.rejects(new FlickrClient('key', 'secret', async () => new Response('{"stat":"fail","code":99}')).albums(credentials), /Flickr API error 99/);
});
