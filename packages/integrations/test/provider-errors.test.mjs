import test from 'node:test';
import assert from 'node:assert/strict';
import { ExternalProviderError, parseRetryAfterSeconds } from '../dist/index.js';

test('connector errors preserve identity, failure category and optional recovery metadata', () => {
  for (const code of ['authentication_required', 'rate_limited', 'temporarily_unavailable', 'ambiguous_submission', 'invalid_response', 'unsupported', 'preflight_blocked']) {
    const error = new ExternalProviderError('Provider failure', code, 90, 'account_lookup');
    assert.ok(error instanceof Error); assert.ok(error instanceof ExternalProviderError);
    assert.equal(error.name, 'ExternalProviderError'); assert.equal(error.message, 'Provider failure');
    assert.equal(error.code, code); assert.equal(error.retryAfterSeconds, 90); assert.equal(error.operation, 'account_lookup');
  }
  const error = new ExternalProviderError('Missing grant', 'authentication_required');
  assert.equal(error.retryAfterSeconds, undefined); assert.equal(error.operation, undefined);
});

test('retry hint compatibility covers numeric rounding, date delays, expired dates and missing values', () => {
  for (const [input, expected] of [['90', 90], ['0', 0], ['1.2', 2], [' 4 ', 4], [' ', 0], ['1e2', 100]]) {
    assert.equal(parseRetryAfterSeconds(input, 1000), expected);
  }
  assert.equal(parseRetryAfterSeconds(new Date(121000).toUTCString(), 1000), 120);
  assert.equal(parseRetryAfterSeconds(new Date(0).toUTCString(), 1000), 0);
  for (const input of [undefined, null, '', 'not-a-date']) assert.equal(parseRetryAfterSeconds(input, 1000), undefined);
});
