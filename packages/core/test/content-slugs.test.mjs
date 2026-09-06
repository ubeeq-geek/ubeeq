import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeContentSlug, normalizeSlugHistory, matchesContentSlug } from '../dist/index.js';

const legacy = value => normalizeContentSlug(value, { maxLength: 120, fallback: 'item' });

test('content slugs preserve legacy ASCII normalization and post-normalization limits', () => {
  const original = value => value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'item';
  const values = ['', '  ', 'Hello / World!', 'Café & 日本語', 'İ'.repeat(160), 'a'.repeat(119) + ' b', '---', 'A_B.C', '😀 title 😀'];
  for (const value of values) assert.equal(legacy(value), original(value));
  // Do not silently repair a historical trailing hyphen introduced by truncation.
  assert.equal(legacy('a'.repeat(119) + ' b'), 'a'.repeat(119) + '-');
  assert.equal(normalizeContentSlug('!!!', { fallback: 'untitled' }), 'untitled');
  assert.equal(normalizeContentSlug('a'.repeat(300), { fallback: 'untitled' }).length, 300);
  for (const maxLength of [0, -1, 1.5, NaN, Infinity]) assert.throws(() => normalizeContentSlug('x', { maxLength, fallback: 'item' }));
  assert.throws(() => normalizeContentSlug('x', { fallback: '../unsafe' }));
});

test('slug histories preserve first-seen aliases without mutating caller records', () => {
  const values = [undefined, '', 'Old Name', 'old-name', 'NEW', '!!!', 'new'];
  const before = structuredClone(values);
  assert.deepEqual(normalizeSlugHistory(values, legacy), ['old-name', 'new', 'item']);
  assert.deepEqual(values, before);
  const record = { slug: 'current', slugHistory: ['Old Name', 'older'] };
  assert.equal(matchesContentSlug(record, ' CURRENT ', legacy), true);
  assert.equal(matchesContentSlug(record, 'old-name', legacy), true);
  assert.equal(matchesContentSlug(record, 'other', legacy), false);
  assert.equal(matchesContentSlug({ slug: 'Current' }, 'current', legacy), false);
  assert.equal(matchesContentSlug({ slug: 'item' }, '', () => ''), false);
});
