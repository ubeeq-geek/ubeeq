import test from 'node:test';
import assert from 'node:assert/strict';
import { findCreatorContentSlugConflicts } from '../dist/index.js';
const findConflicts = (manifest, lookup) => findCreatorContentSlugConflicts(manifest, lookup, 5000);

test('preflight includes historical aliases and incoming conflicts without exposing target records', async () => {
  const manifest = { works: [
    { work: { workId: 'first', slug: 'new', slugHistory: ['old', 'new'] } },
    { work: { workId: 'second', slug: 'old' } },
    { work: { workId: 'deleted', slug: 'old', status: 'deleted' } }
  ], collections: [{ collection: { collectionId: 'collection', slug: 'old' } }] };
  const calls = [], before = structuredClone(manifest);
  const result = await findConflicts(manifest, async (kind, slug) => { calls.push([kind, slug]); return kind === 'work' && slug === 'old'; });
  assert.deepEqual(result, [
    { resource: 'work', id: 'first', slug: 'old', reason: 'slug_exists' },
    { resource: 'work', id: 'second', slug: 'old', reason: 'duplicate_import_slug' },
    { resource: 'work', id: 'second', slug: 'old', reason: 'slug_exists' }
  ]);
  assert.deepEqual(calls, [['work', 'new'], ['work', 'old'], ['work', 'old'], ['collection', 'old']]);
  assert.deepEqual(manifest, before);
});
test('malformed or excessive slug histories reject without authorizing restore', async () => {
  for (const slugHistory of ['not-array', [null], ['']]) await assert.rejects(findConflicts({ works: [{ work: { workId: 'work', slugHistory } }], collections: [] }, async () => false), { code: 'invalid_import_slugs' });
  await assert.rejects(findConflicts({ works: [{ work: { workId: 'work', slugHistory: Array.from({ length: 5001 }, (_, i) => `slug-${i}`) } }], collections: [] }, async () => false), { code: 'import_preflight_budget_exceeded' });
});
