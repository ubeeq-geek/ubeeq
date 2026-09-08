import test from 'node:test';
import assert from 'node:assert/strict';
import { SoundCloudTransport, soundCloudResponseError } from '../dist/index.js';
const credentials = { clientId: 'synthetic-client', clientSecret: 'synthetic-secret', redirectUri: 'https://example.test/callback' };
test('OAuth request construction preserves PKCE, opaque values and configured redirect without leaking secrets', async () => {
  const calls = [];
  const transport = new SoundCloudTransport(credentials, async (url, options) => {
    calls.push([url, options]); return Response.json({ access_token: 'synthetic-access' });
  });
  const pkce = { codeChallenge: 'challenge+with/symbols=', codeVerifier: 'opaque-verifier' };
  const state = 'opaque+state&return=private';
  const url = new URL(transport.createAuthorizationUrl(state, pkce));
  assert.equal(url.origin + url.pathname, 'https://secure.soundcloud.com/authorize');
  assert.deepEqual(Object.fromEntries(url.searchParams), { response_type: 'code', client_id: credentials.clientId,
    redirect_uri: credentials.redirectUri, state, code_challenge: pkce.codeChallenge, code_challenge_method: 'S256' });
  assert.equal(url.toString().includes(credentials.clientSecret), false);
  assert.equal(url.toString().includes(pkce.codeVerifier), false);
  assert.equal(calls.length, 0);
  await transport.exchangeAuthorizationCode('opaque+code&x=y', pkce);
  await transport.refreshAuthentication('opaque+refresh&x=y');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(calls[0][1].body)), { grant_type: 'authorization_code', code: 'opaque+code&x=y',
    code_verifier: pkce.codeVerifier, redirect_uri: credentials.redirectUri, client_id: credentials.clientId, client_secret: credentials.clientSecret });
  assert.deepEqual(Object.fromEntries(new URLSearchParams(calls[1][1].body)), { grant_type: 'refresh_token', refresh_token: 'opaque+refresh&x=y',
    client_id: credentials.clientId, client_secret: credentials.clientSecret });
  for (const [endpoint, options] of calls) {
    assert.equal(endpoint, 'https://secure.soundcloud.com/oauth/token'); assert.equal(options.redirect, 'error');
  }
});
test('OAuth helpers reject missing PKCE and disabled configuration before fetch', async () => {
  let calls = 0;
  const fetcher = async () => { calls++; return Response.json({}); };
  const transport = new SoundCloudTransport(credentials, fetcher);
  assert.throws(() => transport.createAuthorizationUrl('state'), { code: 'unsupported' });
  await assert.rejects(transport.exchangeAuthorizationCode('code'), { code: 'unsupported', operation: 'token_exchange' });
  const disabled = new SoundCloudTransport({ ...credentials, enabled: false }, fetcher);
  const pkce = { codeChallenge: 'challenge', codeVerifier: 'verifier' };
  assert.throws(() => disabled.createAuthorizationUrl('state', pkce), { code: 'unsupported' });
  await assert.rejects(disabled.exchangeAuthorizationCode('code', pkce), { code: 'unsupported' });
  await assert.rejects(disabled.refreshAuthentication('refresh'), { code: 'unsupported' });
  assert.equal(calls, 0);
});
test('transport failure before response headers preserves uncertainty for token and write operations', async () => {
  const transport = new SoundCloudTransport(credentials, async () => { throw new Error('connection lost'); });
  await assert.rejects(transport.exchangeToken({}), { code: 'ambiguous_submission' });
  await assert.rejects(transport.request('/tracks/1', 'token', { method: 'PUT' }), { code: 'ambiguous_submission' });
  await assert.rejects(transport.request('/me', 'token'), { code: 'temporarily_unavailable' });
});
test('bounded transport rejects malformed/oversized successful reads and marks uncertain write receipts', async () => {
  for (const body of ['invalid', '[]', 'null', JSON.stringify({ data: 'x'.repeat(100) })]) {
    const transport = new SoundCloudTransport(credentials, async () => new Response(body), { maxResponseBytes: 32 });
    await assert.rejects(transport.request('/me', 'token'), { code: 'invalid_response' });
    await assert.rejects(transport.request('/tracks/1/comments', 'token', { method: 'POST' }), { code: 'ambiguous_submission' });
    await assert.rejects(transport.exchangeToken({}), { code: 'ambiguous_submission' });
  }
  const denied = new SoundCloudTransport(credentials, async () => new Response('invalid', { status: 401 }));
  await assert.rejects(denied.request('/me', 'token'), { code: 'authentication_required' });
});
test('transport supplies a deadline signal to token and API fetches and validates limits', async () => {
  const signals = [];
  const transport = new SoundCloudTransport(credentials, async (_url, options) => {
    signals.push(options.signal); return Response.json({ access_token: 'synthetic' });
  }, { timeoutMs: 5 });
  await transport.exchangeToken({}); await transport.request('/me', 'token');
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(signals.length, 2); for (const signal of signals) assert.equal(signal.aborted, true);
  for (const limits of [{ timeoutMs: 0 }, { timeoutMs: 300001 }, { maxResponseBytes: 0 }, { maxResponseBytes: 16777217 }]) assert.throws(() => new SoundCloudTransport(credentials, undefined, limits), /limits/);
});
test('a stalled body honoring the fetch deadline fails as retryable read or ambiguous write', async () => {
  const fetcher = async (_url, options) => new Response(new ReadableStream({ start(controller) {
    options.signal.addEventListener('abort', () => controller.error(options.signal.reason), { once: true });
  } }));
  const transport = new SoundCloudTransport(credentials, fetcher, { timeoutMs: 5 });
  await Promise.all([
    assert.rejects(transport.request('/me', 'token'), { code: 'temporarily_unavailable' }),
    assert.rejects(transport.exchangeToken({}), { code: 'ambiguous_submission' }),
    new Promise(resolve => setTimeout(resolve, 20))
  ]);
});
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
