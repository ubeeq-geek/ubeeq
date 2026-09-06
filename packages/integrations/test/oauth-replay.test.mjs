import test from 'node:test';
import assert from 'node:assert/strict';
import { claimVerifiedOAuthState } from '../dist/index.js';

test('one-time claims hash namespace and nonce and reject duplicates', async () => {
  const claims = new Map();
  const store = { claimOAuthNonce: async input => {
    if (claims.has(input.key)) return false;
    claims.set(input.key, input); return true;
  } };
  const input = { namespace: 'tenant/provider', nonce: 'nonce-secret', expiresAt: 100, now: 10 };
  const results = await Promise.allSettled([claimVerifiedOAuthState(input, store), claimVerifiedOAuthState(input, store)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.match(results.find(result => result.status === 'rejected').reason.message, /already been used/);
  const record = [...claims.values()][0];
  assert.match(record.key, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(record).includes(input.nonce), false);
  assert.equal(record.expiresAt, 100);
  await claimVerifiedOAuthState({ ...input, namespace: 'another/provider' }, store);
  assert.equal(claims.size, 2);
});

test('invalid or expired claims never reach storage and storage errors propagate', async () => {
  const input = { namespace: 'tenant/provider', nonce: 'nonce', expiresAt: 100, now: 10 };
  for (const patch of [{ namespace: '' }, { nonce: '' }, { expiresAt: undefined }, { expiresAt: 10 }, { expiresAt: 9 }, { expiresAt: Infinity }, { now: NaN }, { now: -1 }, { now: 1.5 }]) {
    await assert.rejects(claimVerifiedOAuthState({ ...input, ...patch }, { claimOAuthNonce: async () => assert.fail('must validate before storage') }), /invalid or expired/);
  }
  const failure = new Error('database unavailable');
  await assert.rejects(claimVerifiedOAuthState(input, { claimOAuthNonce: async () => { throw failure; } }), error => error === failure);
});
