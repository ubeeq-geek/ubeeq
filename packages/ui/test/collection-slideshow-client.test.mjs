import test from 'node:test';
import assert from 'node:assert/strict';
import { CollectionSlideshowClient } from '../dist/index.js';
import { normalizeSlideshowSettings } from '@ubeeq/core';

test('slideshow requests encode scope and authenticate generation, status and binary downloads', async () => {
  const calls = [], bytes = new Uint8Array([1, 2, 3]);
  const client = new CollectionSlideshowClient(() => 'private-session', '/api/v1', async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/content')) return new Response(bytes, { headers: { 'content-type': 'video/mp4' } });
    return Response.json(options.method === 'POST' ? { rendition: { id: 'render' } } : { renditions: [] });
  });
  assert.deepEqual(await client.list('collection/with space'), []);
  const settings = normalizeSlideshowSettings();
  assert.equal((await client.generate('collection/with space', settings, false, 'stable-request')).id, 'render');
  assert.deepEqual(JSON.parse(calls[1].options.body), { settings, musicRightsConfirmed: false, requestId: 'stable-request' });
  const blob = await client.download('collection/with space', 'video/one');
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), bytes);
  assert.equal(calls[2].url, '/api/v1/collections/collection%2Fwith%20space/slideshows/video%2Fone/content');
  for (const { url, options } of calls) {
    assert.equal(options.headers.authorization, 'Bearer private-session');
    assert.equal(options.cache, 'no-store'); assert.equal(options.redirect, 'error');
    assert.ok(!url.includes('private-session'));
  }
});
test('slideshow client surfaces permission and stale-render failures', async () => {
  const client = new CollectionSlideshowClient(() => 'session', '/api/v1', async () => Response.json({ error: { message: 'The collection changed; regenerate.' } }, { status: 409 }));
  await assert.rejects(client.download('collection', 'video'), /regenerate/);
});
