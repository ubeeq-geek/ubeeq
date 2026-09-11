import test from 'node:test';
import assert from 'node:assert/strict';
import { FlickrClient } from '../dist/index.js';

const credentials = { token: 'token', tokenSecret: 'secret' };

test('Flickr OAuth and read requests reject redirects and share bounded response transport', async () => {
  let calls = 0;
  const client = new FlickrClient('key', 'secret', async (_url, init) => {
    assert.equal(init.redirect, 'error'); assert.ok(init.signal instanceof AbortSignal);
    calls++;
    return new Response(calls === 1 ? 'oauth_token=t&oauth_token_secret=s' : '{"photos":{"page":1,"pages":1,"photo":[]}}');
  });
  assert.equal((await client.requestToken('https://app.example/callback')).get('oauth_token'), 't');
  assert.deepEqual(await client.inventoryPage(credentials, 1), { page: 1, pages: 1, photos: [] });
  assert.equal(calls, 2);
});

test('Flickr successful oversized streamed responses cancel and are never retried', async () => {
  for (const operation of ['oauth', 'read']) {
    let calls = 0, cancelled = false;
    const client = new FlickrClient('key', 'secret', async () => {
      calls++;
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array(17)); },
        cancel() { cancelled = true; }
      }));
    }, 0, { maxResponseBytes: 16 });
    await assert.rejects(operation === 'oauth' ? client.requestToken('https://app.example/callback') : client.inventoryPage(credentials, 1), /exceeds byte limit/);
    assert.equal(calls, 1); assert.equal(cancelled, true);
  }
});

test('Flickr oversized error bodies retain HTTP retry classification and are cancelled', async () => {
  for (const status of [403, 429]) {
    let calls = 0, cancelled = 0;
    const client = new FlickrClient('key', 'secret', async () => {
      calls++;
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(17)); }, cancel() { cancelled++; } }),
        { status, headers: { 'retry-after': '0' } });
    }, 0, { maxResponseBytes: 16 });
    await assert.rejects(client.inventoryPage(credentials, 1), new RegExp(`Flickr API request failed \\(${status}\\)`));
    assert.equal(calls, status === 403 ? 1 : 3); assert.equal(cancelled, calls);
  }
});

test('Flickr timeout reaches the injected transport without automatic replay', async () => {
  let calls = 0;
  const client = new FlickrClient('key', 'secret', async (_url, init) => {
    calls++;
    return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
  }, 0, { timeoutMs: 10 });
  // AbortSignal.timeout is unref-ed, so keep the test process alive while observing it.
  const keepAlive = setTimeout(() => {}, 1000);
  try { await assert.rejects(client.inventoryPage(credentials, 1), error => error.name === 'TimeoutError'); }
  finally { clearTimeout(keepAlive); }
  assert.equal(calls, 1);
});

test('Flickr request limits reject invalid configuration before any transport use', () => {
  for (const limits of [{ timeoutMs: 0 }, { timeoutMs: 300001 }, { timeoutMs: NaN }, { maxResponseBytes: 0 }, { maxResponseBytes: 1.5 }, { maxResponseBytes: 16777217 }]) {
    assert.throws(() => new FlickrClient('key', 'secret', () => { throw new Error('must not fetch'); }, 0, limits), /Invalid Flickr request limits/);
  }
});
