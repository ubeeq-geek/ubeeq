import test from 'node:test';
import assert from 'node:assert/strict';
import { requestVimeo, VimeoApiError } from '../dist/index.js';

test('Vimeo requests enforce redirects and deadlines while preserving request and JSON response', async () => {
  const controller = new AbortController(); let signal;
  const response = await requestVimeo(async (url, init) => {
    assert.equal(url, 'https://api.vimeo.com/me'); assert.equal(init.method, 'POST');
    assert.equal(init.body, 'body'); assert.equal(init.headers.authorization, 'Bearer fixture');
    assert.equal(init.redirect, 'error'); signal = init.signal;
    return new Response('{"ok":true}');
  }, 'https://api.vimeo.com/me', { method: 'POST', body: 'body', headers: { authorization: 'Bearer fixture' }, redirect: 'follow', signal: controller.signal });
  assert.deepEqual(await response.json(), { ok: true });
  controller.abort(); assert.equal(signal.aborted, true);
  assert.equal((await requestVimeo(async () => new Response(null, { status: 204 }), 'https://api.vimeo.com/tokens')).status, 204);
});

test('Vimeo streamed responses are bounded and failed HTTP status survives unreadable bodies', async () => {
  for (const status of [200, 403, 429, 503]) {
    let cancelled = false;
    const body = new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(9)); }, cancel() { cancelled = true; } });
    await assert.rejects(requestVimeo(async () => new Response(body, { status, headers: { 'retry-after': '2' } }), 'https://api.vimeo.com/me', {}, { maxResponseBytes: 8 }), error => {
      if (status === 200) return /byte limit/.test(error.message);
      assert.ok(error instanceof VimeoApiError); assert.equal(error.status, status);
      assert.equal(error.retryable, status !== 403); assert.equal(error.retryAfterSeconds, 2); return true;
    });
    assert.equal(cancelled, true);
  }
});

test('Vimeo request failures are never retried and invalid limits never fetch', async () => {
  let calls = 0; const failure = new Error('uncertain transport');
  const fetcher = async () => { calls++; throw failure; };
  await assert.rejects(requestVimeo(fetcher, 'https://api.vimeo.com/me/videos', { method: 'POST' }), error => error === failure);
  assert.equal(calls, 1);
  for (const limits of [{ timeoutMs: 0 }, { maxResponseBytes: Infinity }, { timeoutMs: 300001 }]) await assert.rejects(requestVimeo(fetcher, 'https://api.vimeo.com/me', {}, limits));
  assert.equal(calls, 1);
});
