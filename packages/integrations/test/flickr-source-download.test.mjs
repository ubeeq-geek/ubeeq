import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { downloadFlickrSource } from '../dist/index.js';
const url = 'https://live.staticflickr.com/source.jpg';
test('Flickr source download retains bytes and checksum without trusting response MIME', async () => {
  const bytes = Buffer.from([255, 216, 255, 1]);
  const result = await downloadFlickrSource(url, 8, async (_url, init) => {
    assert.equal(init.redirect, 'error'); assert.ok(init.signal instanceof AbortSignal);
    return new Response(bytes, { headers: { 'content-type': 'text/plain' } });
  });
  assert.deepEqual(result.body, bytes); assert.equal(result.mimeType, 'image/jpeg');
  assert.equal(result.sizeBytes, 4); assert.equal(result.checksumSha256, createHash('sha256').update(bytes).digest('hex'));
});
test('Flickr source admission rejects invalid budgets and hosts before fetching', async () => {
  let calls = 0; const fetcher = async () => { calls++; throw Error('unexpected'); };
  for (const budget of [0, -1, Infinity, 1.5]) await assert.rejects(downloadFlickrSource(url, budget, fetcher), /INVALID_BYTE_LIMIT/);
  for (const source of ['http://live.staticflickr.com/a', 'https://example.test/a', 'https://staticflickr.com.evil.test/a'])
    await assert.rejects(downloadFlickrSource(source, 8, fetcher), /URL_REJECTED/);
  assert.equal(calls, 0);
});
test('Flickr source cancels bounded stream and HTTP failures; signatures are not full decoding', async () => {
  for (const mode of ['stream', 'declared', 'http']) {
    let cancelled = false;
    await assert.rejects(downloadFlickrSource(url, 8, async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(9)); }, cancel() { cancelled = true; }
    }), { status: mode === 'http' ? 503 : 200, headers: mode === 'declared' ? { 'content-length': '9' } : {} })),
    mode === 'http' ? /TEMPORARILY_UNAVAILABLE/ : /TOO_LARGE/);
    assert.equal(cancelled, true);
  }
  await assert.rejects(downloadFlickrSource(url, 100, async () => new Response('not an image')), /MIME_INVALID/);
});
