import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareCollectionReleaseManifest, readCollectionReleaseManifest } from '../dist/index.js';
const scope = { tenantId: 'tenant', creatorId: 'creator', collectionId: 'collection', releaseId: 'release' };
const requirement = (id) => ({ resultId: `result-${id}`, publicationId: `publication-${id}`, workId: `work-${id}`,
  target: { provider: 'provider', accountId: 'account', connectionId: 'connection', targetId: 'gallery', postType: 'image' },
  contentRevision: 'revision-1', collectionRevision: 'revision-3', placementId: 'gallery', audience: 'public', required: true, kind: 'external_gallery' });
test('large manifests chunk before item/transaction limits and restore exactly the snapshotted scope', () => {
  const requirements = Array.from({ length: 2501 }, (_, i) => requirement(i));
  const { reference, chunks } = prepareCollectionReleaseManifest({ ...scope, generation: 1, requirements });
  assert.equal(chunks.length, 26); assert.equal(reference.resultCount, 2501);
  assert.equal(chunks.every(c => c.requirements.length <= 100 && Buffer.byteLength(JSON.stringify(c)) < 240 * 1024), true);
  assert.deepEqual(readCollectionReleaseManifest(scope, reference, [...chunks].reverse()), requirements);
  requirements[0].contentRevision = 'later-edit';
  assert.equal(chunks[0].requirements[0].contentRevision, 'revision-1');
});
test('byte bounds include encoded non-ASCII data and a single oversized result fails', () => {
  const requirements = Array.from({ length: 10 }, (_, i) => ({ ...requirement(i), audience: '作'.repeat(300) }));
  const { chunks } = prepareCollectionReleaseManifest({ ...scope, generation: 1, requirements, maximumChunkBytes: 2048 });
  assert.equal(chunks.length, 10);
  assert.equal(chunks.every(c => Buffer.byteLength(JSON.stringify(c)) <= 2048), true);
  assert.throws(() => prepareCollectionReleaseManifest({ ...scope, generation: 1, requirements, maximumChunkBytes: 1024 }), /exceeds/);
});
test('incomplete, corrupt, mixed-generation and cross-tenant manifests never activate', () => {
  const { reference, chunks } = prepareCollectionReleaseManifest({ ...scope, generation: 3, requirements: [requirement(1), requirement(2)], maximumChunkResults: 1 });
  const cases = [chunks.slice(1), [chunks[0], chunks[0]], [{ ...chunks[0], tenantId: 'other' }, chunks[1]],
    [{ ...chunks[0], generation: 2 }, chunks[1]], [{ ...chunks[0], requirements: [requirement(99)] }, chunks[1]]];
  for (const value of cases) assert.throws(() => readCollectionReleaseManifest(scope, reference, value), { code: 'GENERATION_CONFLICT' });
  assert.throws(() => readCollectionReleaseManifest(scope, { ...reference, resultCount: 3 }, chunks));
  assert.throws(() => readCollectionReleaseManifest(scope, { ...reference, checksumSha256: 'corrupt' }, chunks));
});
test('empty operations have a verifiable empty manifest and duplicate publication results are rejected', () => {
  const { reference, chunks } = prepareCollectionReleaseManifest({ ...scope, generation: 1, requirements: [] });
  assert.deepEqual(readCollectionReleaseManifest(scope, reference, chunks), []);
  assert.throws(() => prepareCollectionReleaseManifest({ ...scope, generation: 1, requirements: [requirement(1), requirement(1)] }), /unique/);
});
