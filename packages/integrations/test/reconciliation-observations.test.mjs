import test from 'node:test';
import assert from 'node:assert/strict';
import { observeReconciliationSnapshots, resolveReconciliation } from '../dist/index.js';

test('confirmed resolutions own their nested values without carrying excluded copy identities', () => {
  for (const action of ['accept_remote', 'keep_local', 'create_detached_copy']) {
    const local = { tags: ['local'], details: { title: 'Local' } };
    const remote = { tags: ['remote'], details: { title: 'Remote' }, remoteId: 'external' };
    const originals = structuredClone({ local, remote });
    assert.throws(() => resolveReconciliation(local, remote, { action, confirmed: false }), /confirmation/);
    const result = resolveReconciliation(local, remote, { action, confirmed: true }, { detachedCopyExcludedKeys: ['remoteId'] });
    result.local.tags.push('result-only'); result.local.details.title = 'Result';
    if (result.detachedCopy) {
      assert.equal(result.detachedCopy.remoteId, undefined);
      result.detachedCopy.tags.push('copy-only'); result.detachedCopy.details.title = 'Copy';
      assert.equal(result.local.details.title, 'Result');
    }
    assert.deepEqual({ local, remote }, originals);
  }
});

test('observations initialize from remote and retain a divergent baseline across later observations', () => {
  const first = observeReconciliationSnapshots(undefined, { title: 'Original' }, { title: 'Original' }, 'first');
  assert.deepEqual(first, { baseline: { title: 'Original' }, remote: { title: 'Original' }, status: 'in_sync', fields: [], updatedAt: 'first' });
  const next = observeReconciliationSnapshots(first.baseline, { title: 'Local' }, { title: 'Remote' }, 'next');
  assert.equal(next.status, 'conflict'); assert.deepEqual(next.baseline, first.baseline);
  const later = observeReconciliationSnapshots(next.baseline, { title: 'Local' }, { title: 'Remote again' }, 'later');
  assert.deepEqual(later.baseline, { title: 'Original' });
  assert.equal(later.fields[0].lastSynced, 'Original');
  assert.equal(later.fields[0].remote, 'Remote again');
});

test('observation preserves existing classification and ordering semantics', () => {
  const baseline = { title: 'Original', tags: ['one', 'two'] };
  for (const [local, remote, status] of [
    [{ ...baseline, title: 'Local' }, baseline, 'local_newer'],
    [baseline, { ...baseline, title: 'Remote' }, 'remote_newer'],
    [{ ...baseline, title: 'Local' }, { ...baseline, tags: ['remote'] }, 'non_conflicting_changes'],
    [{ ...baseline, tags: ['two', 'one'] }, baseline, 'in_sync']
  ]) assert.equal(observeReconciliationSnapshots(baseline, local, remote, 'now').status, status);
});

test('nested baseline, remote and diff values are detached from inputs and each other', () => {
  const baseline = { tags: ['old'], data: { caption: 'Old' } };
  const local = { tags: ['local'], data: { caption: 'Local' } };
  const remote = { tags: ['remote'], data: { caption: 'Remote' } };
  const observation = observeReconciliationSnapshots(baseline, local, remote, 'now');
  const expected = structuredClone(observation);
  baseline.tags.push('later'); local.data.caption = 'Changed'; remote.tags.push('later');
  assert.deepEqual(observation, expected);
  observation.fields.find(field => field.field === 'tags').remote.push('field-only');
  assert.deepEqual(observation.remote.tags, ['remote']);
  observation.baseline.data.caption = 'Baseline-only';
  assert.equal(observation.fields.find(field => field.field === 'data').lastSynced.caption, 'Old');
});
