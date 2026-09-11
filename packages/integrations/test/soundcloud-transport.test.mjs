import test from 'node:test';
import assert from 'node:assert/strict';
import { SoundCloudTransport, soundCloudResponseError } from '../dist/index.js';
const credentials = { clientId: 'synthetic-client', clientSecret: 'synthetic-secret', redirectUri: 'https://example.test/callback' };
test('transport exchanges tokens and sends API form requests without following redirects', async () => {
  const calls = [];
  const transport = new SoundCloudTransport(credentials, async (url, options) => {
    calls.push([url, options]); return url.includes('/oauth/token') ? Response.json({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh' }) : Response.json({ id: 1 });
  });
  assert.equal((await transport.exchangeToken({ grant_type: 'refresh_token', refresh_token: 'old', client_id: 'forged' })).accessToken, 'synthetic-access');
  assert.equal(new URLSearchParams(calls[0][1].body).get('client_id'), credentials.clientId);
  assert.equal(calls[0][1].redirect, 'error');
  assert.deepEqual(await transport.request('/tracks/1', 'synthetic-access', { method: 'PUT', body: new URLSearchParams({ title: 'New' }) }), { id: 1 });
  assert.equal(calls[1][0], 'https://api.soundcloud.com/tracks/1');
  assert.equal(calls[1][1].redirect, 'error'); assert.equal(calls[1][1].headers.Authorization, 'OAuth synthetic-access');
  assert.equal(calls[1][1].body, 'title=New');
});
test('disabled transports and foreign cursors make no requests', async () => {
  let calls = 0; const fetcher = async () => { calls++; return Response.json({}); };
  const disabled = new SoundCloudTransport({ ...credentials, enabled: false }, fetcher);
  await assert.rejects(disabled.exchangeToken({}), { code: 'unsupported' });
  await assert.rejects(disabled.request('/me', 'token'), { code: 'unsupported' });
  const transport = new SoundCloudTransport(credentials, fetcher);
  for (const url of ['https://example.test/me', 'http://api.soundcloud.com/me', 'https://user@api.soundcloud.com/me', 'https://api.soundcloud.com/me#fragment']) await assert.rejects(transport.request(url, 'token'), { code: 'invalid_response' });
  assert.equal(calls, 0); assert.equal(transport.safeNextHref(null), undefined);
});
test('transport preserves provider failure categories, empty success and explicit missing-resource handling', async () => {
  for (const [status, code] of [[401, 'authentication_required'], [429, 'rate_limited'], [503, 'temporarily_unavailable'], [400, 'invalid_response']]) {
    assert.equal(soundCloudResponseError(status, {}, '90').code, code);
    const transport = new SoundCloudTransport(credentials, async () => Response.json({ message: 'Synthetic error' }, { status, headers: { 'retry-after': '90' } }));
    await assert.rejects(transport.request('/me', 'token'), { code });
  }
  assert.equal(soundCloudResponseError(429, {}, '90').retryAfterSeconds, 90);
  assert.deepEqual(await new SoundCloudTransport(credentials, async () => new Response(null, { status: 204 })).request('/me', 'token', { emptyResponse: true }), {});
  assert.deepEqual(await new SoundCloudTransport(credentials, async () => new Response(null, { status: 404 })).request('/me', 'token', { ignoreNotFound: true }), {});
  await assert.rejects(new SoundCloudTransport(credentials, async () => Response.json({})).exchangeToken({}), { code: 'invalid_response' });
});
