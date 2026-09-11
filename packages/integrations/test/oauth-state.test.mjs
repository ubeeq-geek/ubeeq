import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { deriveOAuthPkce, issueOAuthState, verifyOAuthState } from '../dist/index.js';

test('issuance supplies fresh nonces, overrides caller nonce injection and does not mutate input', () => {
  const input = Object.freeze({ userId: 'user', nonce: 'injected' });
  const codec = { sign: JSON.stringify };
  const first = issueOAuthState(input, codec), second = issueOAuthState(input, codec);
  assert.notEqual(first.nonce, second.nonce);
  assert.match(first.nonce, /^[0-9a-f-]{36}$/);
  assert.deepEqual(JSON.parse(first.state), { userId: 'user', nonce: first.nonce });
  assert.equal(input.nonce, 'injected');
});

test('verification requires a verified object and propagates codec failures', () => {
  const payload = { nonce: 'nonce', userId: 'user' };
  assert.equal(verifyOAuthState('signed', { verify: value => { assert.equal(value, 'signed'); return payload; } }), payload);
  for (const value of [null, undefined, 'text', 1, false, []]) {
    assert.throws(() => verifyOAuthState('state', { verify: () => value }), /OAuth state is invalid/);
  }
  const error = new Error('signature or expiry rejected');
  assert.throws(() => verifyOAuthState('state', { verify: () => { throw error; } }), value => value === error);
  assert.throws(() => issueOAuthState({}, { sign: () => { throw error; } }), value => value === error);
});

test('PKCE retains deterministic derivation while separating caller domains, keys and nonces', () => {
  const verifier = createHmac('sha256', 'secret').update('connector:nonce').digest('base64url');
  const expected = { codeVerifier: verifier, codeChallenge: createHash('sha256').update(verifier, 'utf8').digest('base64url') };
  assert.deepEqual(deriveOAuthPkce('secret', 'nonce', 'connector:'), expected);
  assert.equal(verifier.length, 43);
  assert.match(verifier, /^[A-Za-z0-9_-]+$/);
  for (const args of [['other', 'nonce', 'connector:'], ['secret', 'other', 'connector:'], ['secret', 'nonce', 'other:']]) {
    assert.notEqual(deriveOAuthPkce(...args).codeVerifier, verifier);
  }
});
