import test from 'node:test';
import assert from 'node:assert/strict';
import { VimeoOAuthClient, VimeoApiError } from '../dist/index.js';
const input = { code: 'code+value', clientId: 'client', clientSecret: 'secret', redirectUri: 'https://example.test/callback?a=1' };

test('Vimeo OAuth uses bounded POST, keeps credentials out of URL, and normalizes tokens', async () => {
  const before = Date.now();
  const client = new VimeoOAuthClient(async (url, init) => {
    assert.equal(url, 'https://api.vimeo.com/oauth/access_token'); assert.equal(init.method, 'POST');
    assert.equal(init.headers.authorization, `Basic ${Buffer.from('client:secret').toString('base64')}`);
    assert.equal(init.body.get('code'), input.code); assert.equal(init.body.get('redirect_uri'), input.redirectUri);
    assert.equal(init.redirect, 'error'); assert.ok(init.signal);
    return new Response(JSON.stringify({ access_token: 'access', refresh_token: 'refresh', expires_in: 60, scope: ' private\tupload ' }));
  });
  const result = await client.exchangeCode(input);
  assert.equal(result.accessToken, 'access'); assert.equal(result.refreshToken, 'refresh');
  assert.deepEqual(result.scopes, ['private', 'upload']);
  assert.ok(Date.parse(result.expiresAt) >= before + 60000);
});

test('Vimeo invalid optional expiry cannot discard a valid token via a date conversion error', async () => {
  for (const expires_in of [null, {}, [], 0, -1, 1e100, 'invalid', '1e100']) {
    const client = new VimeoOAuthClient(async () => new Response(JSON.stringify({ access_token: 'access', expires_in, scope: {} })));
    const result = await client.exchangeCode(input);
    assert.equal(result.accessToken, 'access'); assert.equal(result.expiresAt, undefined); assert.deepEqual(result.scopes, []);
  }
});

test('Vimeo OAuth rejects unusable tokens and never replays an uncertain exchange', async () => {
  for (const access_token of [undefined, null, {}, '', ' ']) {
    const client = new VimeoOAuthClient(async () => new Response(JSON.stringify({ access_token })));
    await assert.rejects(client.exchangeCode(input), VimeoApiError);
  }
  const failure = new Error('response lost'); let calls = 0;
  const client = new VimeoOAuthClient(async () => { calls++; throw failure; });
  await assert.rejects(client.exchangeCode(input), error => error === failure); assert.equal(calls, 1);
});
