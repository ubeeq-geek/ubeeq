import test from 'node:test';
import assert from 'node:assert/strict';
import { SmugMugHttpGateway } from '../dist/index.js';

const options = { apiKey: 'key', apiSecret: 'secret', callbackUrl: 'https://app.example/callback', vault: { async get() { return { token: 'token', tokenSecret: 'secret' }; } } };
const image = { remoteId: 'i', galleryId: 'a', url: 'https://photos.example/i', keywords: [], position: 0, originalAvailable: true, sourceUrl: 'https://photos.example/original', privacy: {}, licence: {} };

test('SmugMug streams enforce byte limits without trusting content length and cancel once', async () => {
  for (const headers of [{}, { 'content-length': '1' }, { 'content-length': '99' }]) {
    let calls = 0, cancelled = 0;
    const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(9)); }, cancel() { cancelled++; } }), { headers });
    const gateway = new SmugMugHttpGateway({ ...options, maxDownloadBytes: 8, fetch: async (_url, init) => {
      calls++; assert.ok(init.signal instanceof AbortSignal); assert.equal(init.redirect, 'error'); return response;
    } });
    await assert.rejects(gateway.download('ref', image), /exceeds/);
    assert.equal(calls, 1); assert.equal(cancelled, 1); assert.equal(response.body.locked, false);
  }
});

test('SmugMug verifies actual bytes against both catalogue and header sizes', async () => {
  for (const [byteSize, declared] of [[6, undefined], [6, '6'], [undefined, '6'], [4, undefined], [undefined, '4']]) {
    const gateway = new SmugMugHttpGateway({ ...options, fetch: async () => new Response('short', { headers: declared ? { 'content-length': declared } : {} }) });
    await assert.rejects(gateway.download('ref', { ...image, byteSize }), /partial/);
  }
});

test('SmugMug admits exact binary bytes with and without advertised sizes', async () => {
  for (const advertised of [true, false]) {
    const gateway = new SmugMugHttpGateway({ ...options, maxDownloadBytes: 4, fetch: async () => new Response(new Uint8Array([0, 255, 128, 42]), { headers: { 'content-type': 'image/jpeg; fixture=true', ...(advertised ? { 'content-length': '4' } : {}) } }) });
    const result = await gateway.download('ref', { ...image, ...(advertised ? { byteSize: 4 } : {}) });
    assert.deepEqual(result.body, Buffer.from([0, 255, 128, 42])); assert.equal(result.mimeType, 'image/jpeg');
  }
});

test('SmugMug rejects invalid limits and invalid or oversized catalogue sizes before fetching', async () => {
  for (const maxDownloadBytes of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => new SmugMugHttpGateway({ ...options, maxDownloadBytes }), /Invalid SmugMug request limits/);
  }
  let calls = 0;
  const gateway = new SmugMugHttpGateway({ ...options, maxDownloadBytes: 8, fetch: async () => { calls++; return new Response('unused'); } });
  for (const byteSize of [0, -1, NaN, 1.5, Infinity, 9]) await assert.rejects(gateway.download('ref', { ...image, byteSize }), /size|exceeds/);
  assert.equal(calls, 0);
});

test('SmugMug rejects empty and malformed responses and preserves read failures', async () => {
  for (const value of ['', '-1', 'no', '1.5']) {
    let cancelled = false;
    const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-length': value } });
    const gateway = new SmugMugHttpGateway({ ...options, fetch: async () => response });
    await assert.rejects(gateway.download('ref', image), /Invalid SmugMug source size/);
    assert.equal(cancelled, true); assert.equal(response.body.locked, false);
  }
  for (const response of [new Response(null), new Response('')]) {
    const gateway = new SmugMugHttpGateway({ ...options, fetch: async () => response });
    await assert.rejects(gateway.download('ref', image), /empty/);
  }
  const response = new Response(new ReadableStream({ pull(controller) { controller.error(new Error('read interrupted')); } }));
  const gateway = new SmugMugHttpGateway({ ...options, fetch: async () => response });
  await assert.rejects(gateway.download('ref', image), /read interrupted/);
  assert.equal(response.body.locked, false);
});
