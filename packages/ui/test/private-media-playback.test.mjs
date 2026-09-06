import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateMediaPlayback } from '../dist/index.js';

test('private playback loads on demand, deduplicates requests and revokes exactly once', async () => {
  let downloads = 0; const revoked = [], created = [];
  const blob = new Blob(['media']);
  const playback = createPrivateMediaPlayback(async () => { downloads++; return blob; }, {
    createObjectURL: value => { created.push(value); return 'blob:private'; }, revokeObjectURL: value => revoked.push(value)
  });
  assert.equal(downloads, 0);
  assert.deepEqual(await Promise.all([playback.load(), playback.load()]), ['blob:private', 'blob:private']);
  assert.equal(await playback.load(), 'blob:private'); assert.equal(downloads, 1); assert.deepEqual(created, [blob]);
  playback.dispose(); playback.dispose();
  assert.deepEqual(revoked, ['blob:private']); assert.equal(await playback.load(), undefined); assert.equal(downloads, 1);
});
test('late downloads do not allocate URLs after disposal and failures can be retried', async () => {
  let finish, allocations = 0;
  const playback = createPrivateMediaPlayback(() => new Promise(resolve => { finish = resolve; }), {
    createObjectURL: () => { allocations++; return 'blob:late'; }, revokeObjectURL: () => {}
  });
  const pending = playback.load(); playback.dispose(); finish(new Blob(['late']));
  assert.equal(await pending, undefined); assert.equal(allocations, 0);
  let attempts = 0;
  const retry = createPrivateMediaPlayback(async () => { if (++attempts === 1) throw new Error('denied'); return new Blob(['ok']); });
  await assert.rejects(() => retry.load(), /denied/);
  assert.match(await retry.load(), /^blob:/); retry.dispose();
});
