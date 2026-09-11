import test from 'node:test';
import assert from 'node:assert/strict';
import { VimeoWriteClient, VimeoApiError } from '../dist/index.js';

test('Vimeo writes preserve explicit clearing, privacy-only updates and deletion paths', async () => {
  const calls = [];
  const client = new VimeoWriteClient(async (url, init) => { calls.push({ url, ...init }); return new Response(null, { status: 204 }); });
  const privacy = { privacy: 'unlisted', embedDomains: [], downloadsAllowed: false };
  await client.configureVideo('token', '/videos/42', { ...privacy, title: '', description: '' });
  await client.configurePrivacy('token', '/videos/42', privacy);
  await client.deleteVideo('token', '/videos/42'); await client.revokeAccessToken('token');
  assert.deepEqual(calls.map(call => call.method), ['PATCH', 'PATCH', 'DELETE', 'DELETE']);
  assert.deepEqual(JSON.parse(calls[0].body), { name: '', description: '', privacy: { view: 'unlisted', download: false }, embed: { domains: [] } });
  assert.deepEqual(JSON.parse(calls[1].body), { privacy: { view: 'unlisted', download: false }, embed: { domains: [] } });
  assert.equal(calls[2].body, undefined); assert.equal(calls[3].url, 'https://api.vimeo.com/tokens');
  for (const call of calls) { assert.equal(call.redirect, 'error'); assert.ok(call.signal); assert.equal(call.headers.authorization, 'Bearer token'); }
});

test('Vimeo video writes cannot target unrelated or foreign resources', async () => {
  let calls = 0;
  const client = new VimeoWriteClient(async () => { calls++; return new Response(null, { status: 204 }); });
  for (const path of ['/tokens', '/users/42', '/videos/42?delete=1', 'https://other.test/videos/42']) {
    await assert.rejects(client.deleteVideo('token', path), VimeoApiError);
    await assert.rejects(client.configurePrivacy('token', path, { privacy: 'nobody', embedDomains: [], downloadsAllowed: false }), VimeoApiError);
  }
  assert.equal(calls, 0);
});

test('Vimeo write failures are preserved without implicit retry or ignored 404', async () => {
  let calls = 0; const lost = new Error('response lost');
  const client = new VimeoWriteClient(async () => { calls++; throw lost; });
  await assert.rejects(client.deleteVideo('token', '/videos/42'), error => error === lost);
  assert.equal(calls, 1);
  const missing = new VimeoWriteClient(async () => new Response('{}', { status: 404 }));
  await assert.rejects(missing.deleteVideo('token', '/videos/42'), error => error instanceof VimeoApiError && error.status === 404 && !error.retryable);
});
