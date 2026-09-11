import test from 'node:test';
import assert from 'node:assert/strict';
import { SmugMugHttpGateway } from '../dist/index.js';
const options = { apiKey: 'key', apiSecret: 'secret', callbackUrl: 'https://app.example/callback', vault: { async get() { return { token: 'token', tokenSecret: 'secret' }; } } };
const cursor = `smugmug:v1:${Buffer.from(JSON.stringify(['/api/v2/node/root!children'])).toString('base64url')}`;

test('SmugMug OAuth, inventory and upload metadata cancel overflow without retrying', async () => {
  for (const operation of ['oauth', 'inventory', 'upload']) {
    let calls = 0, cancelled = false;
    const gateway = new SmugMugHttpGateway({ ...options, maxMetadataBytes: 8, fetch: async (_url, init) => {
      calls++; assert.ok(init.signal instanceof AbortSignal); assert.equal(init.redirect, 'error');
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(9)); }, cancel() { cancelled = true; } }));
    } });
    const result = operation === 'oauth' ? gateway.startAuthorization('state') : operation === 'inventory' ? gateway.inventory('ref', cursor)
      : gateway.publish('ref', { galleryUri: '/api/v2/album/a', body: Buffer.from('image'), filename: 'image.jpg', mimeType: 'image/jpeg', title: '', keywords: [] });
    await assert.rejects(result, /exceeds byte limit/); assert.equal(calls, 1); assert.equal(cancelled, true);
  }
});

test('SmugMug HTTP errors and unused successful update bodies are cancelled', async () => {
  for (const status of [403, 503, 200]) {
    let cancelled = false;
    const gateway = new SmugMugHttpGateway({ ...options, fetch: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status }) });
    const result = gateway.updateMetadata('ref', { remoteUri: '/api/v2/image/i', title: '', keywords: [] });
    if (status === 200) await result;
    else await assert.rejects(result, new RegExp(`metadata update failed \\(${status}\\)`));
    assert.equal(cancelled, true);
  }
});

test('SmugMug invalid limits reject at construction and request timeout reaches fetch', async () => {
  for (const limits of [{ requestTimeoutMs: 0 }, { requestTimeoutMs: 300001 }, { maxMetadataBytes: NaN }, { maxMetadataBytes: 0 }, { maxMetadataBytes: 16777217 }]) {
    assert.throws(() => new SmugMugHttpGateway({ ...options, ...limits }), /Invalid SmugMug request limits/);
  }
  const gateway = new SmugMugHttpGateway({ ...options, requestTimeoutMs: 10, fetch: async (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })) });
  const keepAlive = setTimeout(() => {}, 1000);
  try { await assert.rejects(gateway.inventory('ref', cursor), error => error.name === 'TimeoutError'); }
  finally { clearTimeout(keepAlive); }
});
