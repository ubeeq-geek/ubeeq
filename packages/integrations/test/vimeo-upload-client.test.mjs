import test from 'node:test';
import assert from 'node:assert/strict';
import { VimeoUploadClient, VimeoApiError } from '../dist/index.js';

test('Vimeo ticket and tus requests retain bodies, headers and authoritative offsets', async () => {
  const calls = [];
  const client = new VimeoUploadClient(async (url, init) => {
    calls.push({ url, ...init });
    if (init.method === 'POST') return new Response(JSON.stringify({ uri: '/videos/42', upload: { upload_link: 'https://upload.test/42' } }));
    return new Response(null, { status: 204, headers: { 'upload-offset': init.method === 'HEAD' ? '2' : '5' } });
  });
  const ticket = await client.createUpload('token', { sizeBytes: 5, title: 'Film' });
  assert.equal(ticket.videoId, '42'); assert.equal(await client.uploadOffset(ticket.uploadUrl), 2);
  const bytes = Buffer.from('abc'); assert.equal(await client.uploadChunk(ticket.uploadUrl, 2, bytes), 5);
  assert.deepEqual(JSON.parse(calls[0].body), { upload: { approach: 'tus', size: 5 }, name: 'Film' });
  assert.equal(calls[2].body, bytes); assert.equal(calls[2].headers['upload-offset'], '2');
  for (const call of calls) { assert.equal(call.redirect, 'error'); assert.ok(call.signal); }
});

test('Vimeo offset responses cannot silently coerce missing or malformed values to zero', async () => {
  for (const raw of [undefined, '', '-1', '1.5', '1e2', '9007199254740992']) {
    const client = new VimeoUploadClient(async () => new Response(null, { headers: raw === undefined ? {} : { 'upload-offset': raw } }));
    await assert.rejects(client.uploadOffset('https://upload.test/42'), VimeoApiError);
  }
  const zero = new VimeoUploadClient(async () => new Response(null, { headers: { 'upload-offset': '0' } }));
  assert.equal(await zero.uploadOffset('https://upload.test/42'), 0);
  await assert.rejects(zero.uploadChunk('https://upload.test/42', 0, Buffer.from('a')), VimeoApiError);
});

test('Vimeo invalid sources never fetch and uncertain creation is not replayed', async () => {
  let calls = 0; const lost = new Error('response lost');
  const client = new VimeoUploadClient(async () => { calls++; throw lost; });
  for (const sizeBytes of [0, -1, NaN, Infinity, 1.5]) await assert.rejects(client.createUpload('token', { sizeBytes, title: 'Film' }), VimeoApiError);
  await assert.rejects(client.uploadChunk('https://upload.test/42', -1, Buffer.from('a')), VimeoApiError);
  await assert.rejects(client.uploadChunk('https://upload.test/42', 0, Buffer.alloc(0)), VimeoApiError);
  assert.equal(calls, 0);
  await assert.rejects(client.createUpload('token', { sizeBytes: 1, title: 'Film' }), error => error === lost); assert.equal(calls, 1);
});
