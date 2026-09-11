import test from "node:test";
import assert from "node:assert/strict";
import { equalJitterRetryDelaySeconds as delay } from "../dist/index.js";

const options = { attempt: 1, baseDelaySeconds: 60, maximumDelaySeconds: 3600, maximumExponent: 10 };

test("equal jitter grows exponentially, includes both integer bounds, and caps delays", () => {
  for (const [attempt, lower, upper] of [[0, 30, 60], [1, 30, 60], [2, 60, 120], [3, 120, 240], [20, 1800, 3600]]) {
    assert.equal(delay({ ...options, attempt }, () => 0), lower);
    assert.equal(delay({ ...options, attempt }, () => 1 - Number.EPSILON), upper);
  }
  assert.equal(delay({ ...options, maximumExponent: 0, attempt: 100 }, () => 0), 30);
  assert.equal(delay({ ...options, baseDelaySeconds: 1 }, () => 0), 1);
  assert.equal(delay({ ...options, baseDelaySeconds: 5000 }, () => 0), 1800);
});

test("the caller controls caps and very large exponents cannot produce an infinite delay", () => {
  assert.equal(delay({ ...options, attempt: Number.MAX_SAFE_INTEGER, maximumExponent: Number.MAX_SAFE_INTEGER, maximumDelaySeconds: 99 }, () => 0), 50);
  const frozen = Object.freeze({ ...options, maximumDelaySeconds: 5 });
  assert.equal(delay(frozen, () => 0), 3);
});

test("invalid scheduling inputs fail before reading randomness", () => {
  for (const [key, values] of Object.entries({ attempt: [-1, 1.5, NaN, Infinity], baseDelaySeconds: [0, -1, 1.5, NaN],
    maximumDelaySeconds: [0, Infinity, 2.5], maximumExponent: [-1, Infinity, 0.5] })) {
    for (const value of values) assert.throws(() => delay({ ...options, [key]: value }, () => assert.fail("must validate first")));
  }
  for (const value of [-1, 1, NaN, Infinity]) assert.throws(() => delay(options, () => value), /random sample/);
});
