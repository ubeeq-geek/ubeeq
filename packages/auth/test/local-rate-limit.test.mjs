import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalSlidingWindowRateLimiter } from '../dist/index.js';

test('sliding windows enforce exact thresholds, isolate keys and expire at the boundary', () => {
  let now = 1_000;
  const limiter = new LocalSlidingWindowRateLimiter(() => now);
  for (let attempt = 0; attempt < 90; attempt++) assert.equal(limiter.check('action:actor', 60_000, 90), true);
  assert.equal(limiter.check('action:actor', 60_000, 90), false);
  assert.equal(limiter.check('action:other', 60_000, 90), true);
  now = 60_999; assert.equal(limiter.check('action:actor', 60_000, 90), false);
  now = 61_000; assert.equal(limiter.check('action:actor', 60_000, 90), true);
});

test('denied requests do not extend the window and instances do not share state', () => {
  let now = 0;
  const first = new LocalSlidingWindowRateLimiter(() => now), second = new LocalSlidingWindowRateLimiter(() => now);
  assert.equal(first.check('key', 100, 1), true);
  now = 99; assert.equal(first.check('key', 100, 1), false);
  assert.equal(second.check('key', 100, 1), true);
  now = 100; assert.equal(first.check('key', 100, 1), true);
  assert.equal(first.check('closed', 100, 0), false);
  for (const args of [['', 100, 1], ['key', 0, 1], ['key', 100, -1], ['key', 100, 1.5]]) assert.throws(() => first.check(...args), /configuration/);
});
