import test from 'node:test';
import assert from 'node:assert/strict';
import { publishPublicDerivative } from '../dist/index.js';
const input = { product: 'fixture', environment: 'dev', dataHomeRegion: 'region-a', assetId: 'asset', mediaVersionId: 'version', scanGroupId: 'scan',
  contentHash: 'a'.repeat(64), contentType: 'image/webp', sourceBucket: 'private', sourceObjectKey: 'preview.webp',
  expectedPrivateDerivativesBucket: 'private', publicDerivativesBucket: 'public', expectedPublicDerivativesBucket: 'public' };
const fixture = () => {
  const events = [], records = new Map();
  const repository = {
    begin: async p => { events.push('begin'); if (records.has(p.id)) throw new Error('duplicate'); records.set(p.id, { ...p }); },
    complete: async p => { events.push('complete'); if (records.get(p.id)?.state !== 'PUBLISHING') throw new Error('conflict'); records.set(p.id, { ...p }); },
    fail: async p => { events.push('fail'); if (records.get(p.id)?.state !== 'PUBLISHING') throw new Error('conflict'); records.set(p.id, { ...p, state: 'FAILED' }); },
    completedReceipt: async p => { events.push('recover'); const saved = records.get(p.id); return saved?.state === 'PUBLISHED' ? { createdAt: saved.createdAt, publishedAt: saved.publishedAt } : undefined; }
  };
  const store = { copy: async () => { events.push('copy'); }, remove: async () => { events.push('remove'); } };
  return { events, records, repository, store };
};
test('publication requires explicit admission before claims or recovery', async () => {
  const f = fixture();
  for (const admit of [undefined, () => false, () => undefined, () => 'true'])
    await assert.rejects(publishPublicDerivative(input, f.repository, f.store, admit), /not admitted/);
  assert.deepEqual(f.events, []);
});
test('publication snapshots input, isolates scan keys and recovers duplicates without storage writes', async () => {
  const f = fixture(), mutable = { ...input };
  const first = await publishPublicDerivative(mutable, f.repository, f.store, admitted => {
    admitted.assetId = 'changed'; mutable.assetId = 'also-changed'; return true;
  }, '2026-01-01T00:00:00Z');
  assert.equal(first.assetId, 'asset'); assert.equal(first.state, 'PUBLISHED');
  assert.deepEqual(f.events, ['begin', 'copy', 'complete']);
  f.events.length = 0;
  const replay = await publishPublicDerivative(input, f.repository, f.store, () => true, '2026-02-01T00:00:00Z');
  assert.deepEqual(replay, first); assert.deepEqual(f.events, ['begin', 'recover']);
  const second = await publishPublicDerivative({ ...input, scanGroupId: 'other' }, f.repository, f.store, () => true);
  assert.notEqual(first.destinationObjectKey, second.destinationObjectKey);
});
test('lost successful completion is recovered without cleanup', async () => {
  const f = fixture(), complete = f.repository.complete;
  f.repository.complete = async p => { await complete(p); throw new Error('response lost'); };
  assert.equal((await publishPublicDerivative(input, f.repository, f.store, () => true)).state, 'PUBLISHED');
  assert.deepEqual(f.events, ['begin', 'copy', 'complete', 'recover']);
});
test('failed completion is fenced before cleanup and ambiguous recovery never deletes', async () => {
  const f = fixture();
  f.repository.complete = async () => { f.events.push('complete'); throw new Error('not committed'); };
  await assert.rejects(publishPublicDerivative(input, f.repository, f.store, () => true), /not committed/);
  assert.deepEqual(f.events, ['begin', 'copy', 'complete', 'recover', 'fail', 'remove']);
  const g = fixture(); g.repository.complete = async () => { g.events.push('complete'); throw new Error('not committed'); };
  g.repository.completedReceipt = async () => { throw new Error('read unavailable'); };
  await assert.rejects(publishPublicDerivative(input, g.repository, g.store, () => true), /read unavailable/);
  assert.deepEqual(g.events, ['begin', 'copy', 'complete']);
});
test('invalid source locations, identities and formats cannot create publication state', async () => {
  const f = fixture();
  for (const change of [{ sourceBucket: 'quarantine' }, { publicDerivativesBucket: 'foreign' }, { assetId: '../escape' },
    { sourceObjectKey: '../original' }, { contentHash: 'bad' }, { contentType: 'text/html' }])
    await assert.rejects(publishPublicDerivative({ ...input, ...change }, f.repository, f.store, () => true));
  assert.deepEqual(f.events, []);
});
