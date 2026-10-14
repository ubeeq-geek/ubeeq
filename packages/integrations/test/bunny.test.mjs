import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { BunnyStreamClient, BunnyStorageClient, bunnyStoragePath, bunnyStreamUrl, bunnyStorageOrigin, bunnyCdnUrl } from '../dist/bunny.js';
import { uploadBunnyFile } from '../dist/bunny-upload.js';
const id = '12345678-1234-1234-1234-123456789abc';
const json = value => new Response(JSON.stringify(value));
test('Bunny Stream bounds inventory, pins the origin, and signs scoped upload/playback capabilities', async () => {
  let call;
  const client = new BunnyStreamClient('123', 'private-key', async (...args) => { call = args; return json({ items: [{ guid: id, title: 'Video', status: 4 }], totalItems: 51 }); });
  assert.deepEqual(await client.list(), { items: [{ id, title: 'Video', status: 4 }], nextPage: 2 });
  assert.equal(call[0], 'https://video.bunnycdn.com/library/123/videos?page=1&itemsPerPage=50&search=');
  assert.equal(call[1].headers.AccessKey, 'private-key'); assert.equal(call[1].redirect, 'error');
  const grant = client.uploadGrant(id, 1234567);
  assert.equal(grant.signature, createHash('sha256').update(`123private-key1234567${id}`).digest('hex'));
  assert.ok(!JSON.stringify(grant).includes('private-key'));
  const signed = new URL(bunnyStreamUrl('123', id, { embed: true, signingKey: 'separate-embed-key', expires: 9999999 }));
  assert.equal(signed.searchParams.get('token'), createHash('sha256').update(`separate-embed-key${id}9999999`).digest('hex'));
  assert.equal(signed.searchParams.get('autoplay'), 'false');
  assert.throws(() => new BunnyStreamClient('../123', 'key'));
  await assert.rejects(client.get('../../secrets'));
});
test('Bunny HTTP errors redact provider bodies and reject unbounded responses', async () => {
  const failed = new BunnyStreamClient('123', 'private', async () => new Response('private-key-echo', { status: 401 }));
  await assert.rejects(failed.list(), error => error.status === 401 && !error.message.includes('echo'));
  const oversized = new BunnyStreamClient('123', 'key', async () => new Response('x'.repeat(4 * 1024 * 1024 + 1)));
  await assert.rejects(oversized.list(), /byte limit/);
  const tooMany = new BunnyStreamClient('123', 'key', async () => json({ items: Array(51).fill({ guid: id, title: 'a', status: 4 }), totalItems: 51 }));
  await assert.rejects(tooMany.list(), /inventory/);
});
test('Bunny Storage prevents traversal, cross-origin credentials and folder deletion', async () => {
  for (const path of ['../secret', 'a/../b', '%2e%2e/x', '/root', 'a//b', 'a\\b', 'a?key', 'a#key']) assert.throws(() => bunnyStoragePath(path));
  assert.equal(bunnyStorageOrigin('de'), 'https://storage.bunnycdn.com');
  assert.equal(bunnyStorageOrigin('ny', true), 'https://ny-s3.storage.bunnycdn.com');
  assert.throws(() => bunnyStorageOrigin('evil.example'));
  assert.throws(() => bunnyCdnUrl('example.org', 'a.mp4'));
  let target;
  const client = new BunnyStorageClient('my-zone', 'de', 'secret', async (url, init) => { target = url; assert.equal(init.redirect, 'error'); return json([{ ObjectName: 'a video.mp4', IsDirectory: false, Length: 12 }]); });
  assert.deepEqual(await client.list('folder/'), [{ name: 'a video.mp4', path: 'folder/a video.mp4', directory: false, sizeBytes: 12 }]);
  assert.equal(target, 'https://storage.bunnycdn.com/my-zone/folder/');
  await assert.rejects(client.deleteFile('folder/'));
});
test('TUS browser transfer uses exact byte offsets and rejects foreign resume destinations', async () => {
  const file = new File(['hello'], 'video.mp4', { type: 'video/mp4' }); const calls = [];
  const grant = { id, service: 'stream', videoId: id, libraryId: '123', signature: 'a'.repeat(64), expires: 9999999, endpoint: 'https://video.bunnycdn.com/tusupload' };
  let progress;
  await uploadBunnyFile(file, grant, new AbortController().signal, value => { progress = value; }, async (url, init) => {
    calls.push([url, init]); return init.method === 'POST' ? new Response(null, { status: 201, headers: { Location: '/tusupload/test' } }) : new Response(null, { status: 204, headers: { 'Upload-Offset': '5' } });
  });
  assert.equal(progress, 100); assert.equal(calls[1][1].headers['Upload-Offset'], '0'); assert.equal(calls[1][1].body.size, 5);
  await assert.rejects(uploadBunnyFile(file, grant, new AbortController().signal, () => {}, async () => new Response(null, { status: 201, headers: { Location: 'https://evil.example/upload' } })), /Unexpected/);
});
