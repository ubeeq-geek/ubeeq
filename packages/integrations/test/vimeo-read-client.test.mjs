import test from 'node:test';
import assert from 'node:assert/strict';
import { VimeoReadClient, VimeoApiError } from '../dist/index.js';

test('Vimeo shared reads use bounded transport and preserve metadata and continuation', async () => {
  const urls = [], payloads = [{ uri: '/users/42', name: 'Creator' }, { data: [{ uri: '/videos/7', name: 'Film' }], paging: { next: '/me/videos?page=3' } }, { transcode: { status: 'complete' } }];
  const client = new VimeoReadClient(async (url, init) => {
    urls.push(url); assert.equal(init.headers.authorization, 'Bearer fixture');
    assert.equal(init.redirect, 'error'); assert.ok(init.signal);
    return new Response(JSON.stringify(payloads.shift()));
  });
  assert.equal((await client.account('fixture')).id, '42');
  const page = await client.listVideos('fixture', 2, 200);
  assert.equal(page.videos[0].id, '7'); assert.equal(page.nextPage, 3);
  assert.deepEqual(await client.video('fixture', '/videos/7'), { transcode: { status: 'complete' } });
  assert.deepEqual(urls, ['https://api.vimeo.com/me', 'https://api.vimeo.com/me/videos?page=2&per_page=100', 'https://api.vimeo.com/videos/7']);
});

test('Vimeo read admission rejects invalid pages and foreign resource paths before fetch', async () => {
  let calls = 0;
  const client = new VimeoReadClient(async () => { calls++; return new Response('{}'); });
  for (const page of [0, -1, 1.5, NaN, Infinity]) await assert.rejects(client.listVideos('token', page), VimeoApiError);
  await assert.rejects(client.listVideos('token', 1, NaN), VimeoApiError);
  for (const path of ['https://other.test/video', '/users/1', '/videos/7?extra=1', '/videos/7/../8']) await assert.rejects(client.video('token', path), VimeoApiError);
  assert.equal(calls, 0);
});

test('Vimeo read failures preserve HTTP errors and reject malformed metadata', async () => {
  const denied = new VimeoReadClient(async () => new Response('{}', { status: 403 }));
  await assert.rejects(denied.account('token'), error => error instanceof VimeoApiError && error.status === 403);
  const malformed = new VimeoReadClient(async () => new Response('[]'));
  await assert.rejects(malformed.account('token'), VimeoApiError);
  await assert.rejects(malformed.listVideos('token'), VimeoApiError);
  await assert.rejects(malformed.video('token', '/videos/7'), VimeoApiError);
});
