import test from 'node:test';
import assert from 'node:assert/strict';
import { canViewBySchedule } from '../dist/index.js';

test('release timing preserves exact boundaries and caller-granted early access', () => {
  const publish = '2026-09-01T10:00:00Z', publicAt = '2026-09-02T10:00:00Z';
  const first = Date.parse(publish), second = Date.parse(publicAt);
  for (const early of [false, true]) {
    assert.equal(canViewBySchedule(undefined, undefined, first, early), true);
    assert.equal(canViewBySchedule('', '', first, early), true);
    assert.equal(canViewBySchedule(publish, publicAt, first - 1, early), false);
    assert.equal(canViewBySchedule(publish, publicAt, first, early), early);
    assert.equal(canViewBySchedule(publish, publicAt, second - 1, early), early);
    assert.equal(canViewBySchedule(publish, publicAt, second, early), true);
    assert.equal(canViewBySchedule(publish, undefined, first, early), true);
    assert.equal(canViewBySchedule(undefined, publicAt, first, early), early);
  }
  assert.equal(canViewBySchedule(publish, publicAt, first, 'yes'), false);
});
test('invalid release dates and invalid clocks fail closed even with early access', () => {
  for (const invalid of ['not-a-date', ' ', '2026-99-99']) for (const early of [false, true]) {
    assert.equal(canViewBySchedule(invalid, undefined, 0, early), false);
    assert.equal(canViewBySchedule(undefined, invalid, 0, early), false);
  }
  for (const now of [NaN, Infinity, -Infinity]) assert.equal(canViewBySchedule(undefined, undefined, now, true), false);
});
