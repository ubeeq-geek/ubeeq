import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { SoundCloudTransport, SoundCloudUploadClient } from '../dist/index.js';
const credentials = { clientId: 'synthetic', clientSecret: 'synthetic-secret', redirectUri: 'https://example.test/callback' };
const source = () => {
  const stream = Readable.from([Buffer.from([0, 255, 1])]);
  return { stream, filename: 'audio.bin', contentType: 'audio/example', openReadStream: async () => stream };
};
test('upload streams caller fields and bytes, closes source and returns provider receipt identity', async () => {
  const file = source(); let calls = 0;
  const client = new SoundCloudUploadClient(new SoundCloudTransport(credentials), async (url, options) => {
    calls++; assert.equal(url, 'https://api.soundcloud.com/tracks');
    assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error'); assert.equal(options.duplex, 'half');
    assert.equal(options.headers.Authorization, 'OAuth token'); assert.equal(options.signal.aborted, false);
    const chunks = []; for await (const chunk of options.body) chunks.push(chunk);
    const bytes = Buffer.concat(chunks), body = bytes.toString();
    assert.match(body, /name="track\[title\]"\r\n\r\nTitle/);
    assert.match(body, /name="track\[asset_data\]"; filename="audio.bin"/);
    assert.notEqual(bytes.indexOf(Buffer.from([0, 255, 1])), -1);
    return Response.json({ urn: 'track:7', id: 8, permalink_url: 'https://example.test/track' });
  });
  assert.equal(calls, 0);
  assert.deepEqual(await client.upload('token', [['track[title]', 'Title']], file), {
    externalContentId: 'track:7', externalUrl: 'https://example.test/track', rawMetadata: { urn: 'track:7', id: 8, permalink_url: 'https://example.test/track' }
  });
  assert.equal(calls, 1); assert.equal(file.stream.destroyed, true);
});
test('upload admission does not open sources; invalid headers close opened sources before fetch', async () => {
  let opens = 0, calls = 0;
  const file = source(); file.openReadStream = async () => { opens++; return file.stream; };
  const fetcher = async () => { calls++; return Response.json({ id: 1 }); };
  const disabled = new SoundCloudUploadClient(new SoundCloudTransport({ ...credentials, enabled: false }), fetcher);
  await assert.rejects(disabled.upload('token', [], file), { code: 'unsupported' });
  assert.equal(opens, 0);
  await assert.rejects(new SoundCloudUploadClient(new SoundCloudTransport(credentials), fetcher).upload('token', [['bad\r\nheader', 'x']], file), /Invalid multipart/);
  assert.equal(opens, 1); assert.equal(calls, 0); assert.equal(file.stream.destroyed, true);
});
test('unconfirmed uploads and invalid successful receipts remain ambiguous without retrying', async () => {
  for (const response of [() => { throw new Error('lost'); }, () => new Response('broken'), () => Response.json({}), () => Response.json([])]) {
    const file = source(); let calls = 0;
    const client = new SoundCloudUploadClient(new SoundCloudTransport(credentials), async () => { calls++; return response(); });
    await assert.rejects(client.upload('token', [], file), { code: 'ambiguous_submission' });
    assert.equal(calls, 1); assert.equal(file.stream.destroyed, true);
  }
});
test('oversized receipts cancel the response and known HTTP failures retain status mapping', async () => {
  let cancelled = false;
  const client = new SoundCloudUploadClient(new SoundCloudTransport(credentials), async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1)); }, cancel() { cancelled = true; }
  }), { headers: { 'content-length': '1' } }));
  const file = source();
  await assert.rejects(client.upload('token', [], file), { code: 'ambiguous_submission' });
  assert.equal(cancelled, true); assert.equal(file.stream.destroyed, true);
  for (const [status, code] of [[401, 'authentication_required'], [429, 'rate_limited'], [503, 'temporarily_unavailable']]) {
    const failed = new SoundCloudUploadClient(new SoundCloudTransport(credentials), async () => new Response('broken', { status }));
    await assert.rejects(failed.upload('token', [], source()), { code });
  }
});
