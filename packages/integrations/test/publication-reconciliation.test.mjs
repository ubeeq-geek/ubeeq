import test from 'node:test';
import assert from 'node:assert/strict';
import { runPublicationReconciliation } from '../dist/index.js';
const fixture = () => {
  let position = {}, offset = 0;
  const repository = {
    reconciliationPosition: async () => position,
    reconciliationStep: async () => ({ publication: { id: `publication-${offset}` }, nextKey: offset < 101 ? String(offset + 1) : undefined }),
    checkpointReconciliation: async (expected, afterKey) => { assert.equal(expected, position); offset++; position = { afterKey, revision: String(offset) }; return position; }
  };
  return { repository, position: () => position };
};
test('publication reconciliation advances bounded sweeps only after attempts, including failed items', async () => {
  const f = fixture(), attempted = [];
  const reconcile = async id => { attempted.push(id); if (id === 'publication-2') throw Error('provider unavailable'); };
  assert.deepEqual(await runPublicationReconciliation(f.repository, reconcile), { checked: 100, failed: 1, advanced: 100, contention: false });
  assert.equal(f.position().afterKey, '100');
  assert.deepEqual(await runPublicationReconciliation(f.repository, reconcile), { checked: 2, failed: 0, advanced: 2, contention: false });
  assert.equal(f.position().afterKey, undefined); assert.equal(attempted.length, 102);
});
test('failed checkpoint propagates and contention stops advancement', async () => {
  const f = fixture(), failure = Error('checkpoint unavailable'); let attempts = 0;
  f.repository.checkpointReconciliation = async () => { throw failure; };
  await assert.rejects(runPublicationReconciliation(f.repository, async () => { attempts++; }), error => error === failure);
  assert.deepEqual(f.position(), {}); assert.equal(attempts, 1);
  f.repository.checkpointReconciliation = async () => undefined;
  assert.deepEqual(await runPublicationReconciliation(f.repository, async () => {}), { checked: 1, failed: 0, advanced: 0, contention: true });
});
test('continuation admission and step budgets bound work; repeated cursors fail', async () => {
  const f = fixture();
  assert.deepEqual(await runPublicationReconciliation(f.repository, async () => {}, () => false), { checked: 0, failed: 0, advanced: 0, contention: false });
  for (const limit of [0, 101, 1.5]) await assert.rejects(runPublicationReconciliation(f.repository, async () => {}, () => true, limit), /step budget/);
  await runPublicationReconciliation(f.repository, async () => {}, () => true, 1);
  f.repository.reconciliationStep = async () => ({ nextKey: '1' });
  await assert.rejects(runPublicationReconciliation(f.repository, async () => {}), /Repeated reconciliation cursor/);
});
