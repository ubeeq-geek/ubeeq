import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalSqliteDatabase, createLocalPublicationCommandRepositories } from '../dist/index.js';
import { PublicationCommandService, recoverPublicationOutbox, repositoryItems, savePublicationImageSelectionBatch, inventoryPublicationCommands } from '@ubeeq/persistence';
import { makePolicy, scope, dataHome, preparation, selection, binding, account } from '../../../packages/persistence/test/fixtures/publication-command-policy.mjs';

const fixture = async t => {
  const directory = mkdtempSync(join(tmpdir(), 'publication-commands-'));
  const config = { databasePath: join(directory, 'db.sqlite'), dataDirectory: directory, publicBaseUrl: 'http://localhost', cellId: 'cell' };
  let local, repositories, service, policy, state;
  let time = Date.parse('2026-11-05T00:00:00.000Z');
  const open = () => {
    local = new LocalSqliteDatabase(config); repositories = createLocalPublicationCommandRepositories(local);
    const product = makePolicy(repositories); policy = product.policy; state = product.state;
    service = new PublicationCommandService(repositories, policy, () => new Date(time));
  };
  open();
  await repositories.works.create({ id: 'work', ...scope, ...dataHome, title: 'Image', status: 'ready' });
  t.after(() => { local.database.close(); rmSync(directory, { recursive: true, force: true }); });
  return {
    get repositories() { return repositories; }, get service() { return service; }, get state() { return state; }, get policy() { return policy; },
    restart() { const previous = structuredClone(state); local.database.close(); open(); Object.assign(state, previous); },
    advance(seconds) { time += seconds * 1000; },
    prepare: id => service.prepare(preparation(id)),
    save: (id, variant, text, revision = 0, requestId = `${id}-${revision}-${variant}-${text ?? ''}`) => service.saveImageSelection({ ...scope, publicationId: id,
      requestId, expectedConfigurationRevision: revision, selection: selection(variant, text) }),
    async approve(id, requestId = `approve-${id}`, kind = 'CREATE') {
      const review = await service.reviewImage(scope, id);
      return service.approve({ ...scope, publicationId: id, requestId, expectedReviewFingerprint: review.fingerprint, kind });
    },
    dispatch: (record, workerId = 'worker') => service.beginDispatch({ ...scope, publicationId: record.operation.publicationId, operationId: record.id, workerId, leaseSeconds: 10 }),
    result: (record, remoteId, result = 'confirmed', workerId = 'worker') => service.recordResult({ ...scope, publicationId: record.operation.publicationId,
      operationId: record.id, fencingGeneration: record.operation.fencingGeneration, workerId, result, ...(remoteId ? { binding: binding(remoteId) } : {}) })
  };
};
const rows = async repository => { const output = []; for await (const row of repositoryItems(request => repository.list(request))) output.push(row); return output; };

test('three settings survive SQLite restart; config edits preserve sibling bytes, metadata and copy IDs', async t => {
  const f = await fixture(t);
  for (const id of ['preview', 'collection', 'volume']) await f.prepare(id);
  await f.save('preview', 'share'); await f.save('collection', 'original'); await f.save('volume', 'watermarked-original', 'Volume');
  const siblings = await Promise.all(['preview', 'collection'].map(id => f.service.get(scope, id)));
  f.restart();
  for (const [id, variant] of [['preview', 'share'], ['collection', 'original'], ['volume', 'watermarked-original']]) {
    const review = await f.service.reviewImage(scope, id); assert.equal(review.snapshot.variant, variant);
    assert.equal((await f.service.get(scope, id)).configurationRevision, 1);
  }
  await f.save('volume', 'watermarked-original', 'New Volume', 1);
  assert.deepEqual(await Promise.all(['preview', 'collection'].map(id => f.service.get(scope, id))), siblings);
  assert.equal((await rows(f.repositories.works)).length, 1); assert.equal((await rows(f.repositories.publications)).length, 3);
  assert.equal((await rows(f.repositories.publicationIntents)).length, 3);
  assert.equal((await rows(f.repositories.operations)).length, 0); assert.equal((await rows(f.repositories.outbox)).length, 0);
});

test('concurrent editors: one desired revision wins; replay never resets later settings or remote observations', async t => {
  const f = await fixture(t); await f.prepare('p');
  const attempts = await Promise.allSettled([f.save('p', 'share'), f.save('p', 'original')]);
  assert.equal(attempts.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(attempts.find(r => r.status === 'rejected').reason.code, 'publication_revision_conflict');
  const first = attempts.find(r => r.status === 'fulfilled').value.publication.imageSelection.variant.value;
  await f.save('p', 'watermarked-original', 'Later', 1, 'later');
  const replay = await f.save('p', first);
  assert.equal(replay.replayed, true); assert.equal(replay.appliedRevision, 1); assert.equal(replay.publication.configurationRevision, 2);
  await assert.rejects(f.save('p', 'thumbnail', undefined, 1, 'later'), { code: 'idempotency_conflict' });
  const p = await f.service.get(scope, 'p'); await f.repositories.publications.update(p.id, p.revision, { remoteId: 'observed', status: 'live' });
  await f.save('p', 'original', undefined, 2);
  assert.equal((await f.service.get(scope, 'p')).remoteId, 'observed');
});

test('atomic preparation retries reuse stable IDs/intent and never reset configuration; changed request intent conflicts', async t => {
  const f = await fixture(t);
  const results = await Promise.all(Array.from({ length: 8 }, (_, n) => f.service.prepare({ ...preparation(`candidate-${n}`), requestId: `request-${n}`, targetKey: 'premium' })));
  assert.equal(results.filter(r => r.created).length, 1);
  const p = results[0].publication;
  assert.ok(results.every(r => r.publication.id === p.id));
  await f.save(p.id, 'share'); f.restart();
  const replay = await f.service.prepare({ ...preparation('unused'), requestId: 'request-0', targetKey: 'premium' });
  assert.equal(replay.publication.id, p.id); assert.equal(replay.publication.imageSelection.variant.value, 'share');
  await assert.rejects(f.service.prepare({ ...preparation('unused'), requestId: 'request-0', targetKey: 'premium', intent: { full: false } }), { code: 'idempotency_conflict' });
  assert.equal((await rows(f.repositories.publicationIntents)).length, 1);
  assert.equal((await rows(f.repositories.outbox)).length, 0);
});

test('interruption after staging compatibility rows rolls back the entire real database bundle', async t => {
  const f = await fixture(t); f.state.failPreparation = true;
  await assert.rejects(f.prepare('p'), /simulated interruption/);
  f.restart();
  for (const name of ['publications', 'claims', 'publicationIntents', 'auditEvents', 'outbox']) assert.deepEqual(await rows(f.repositories[name]), []);
  f.state.failPreparation = false; await f.prepare('p'); f.restart();
  assert.equal((await f.prepare('p')).created, false);
});

test('historical gallery-derived ID cannot silently move back or allocate over an existing ID', async t => {
  const f = await fixture(t); await f.prepare('da-gallery-old');
  const p = await f.service.get(scope, 'da-gallery-old');
  await f.repositories.publications.update(p.id, p.revision, { currentTargetKey: 'new-gallery' });
  await assert.rejects(f.service.prepare({ ...preparation('another-id'), targetKey: 'da-gallery-old' }), { code: 'publication_identity_conflict' });
  await assert.rejects(f.service.prepare({ ...preparation('da-gallery-old'), requestId: 'new-request', targetKey: 'another-target' }), { code: 'publication_identity_conflict' });
  assert.equal((await f.service.get(scope, p.id)).currentTargetKey, 'new-gallery');
});

test('stale acceptance and edits before dispatch cannot change approved bytes; sibling metadata remains unrelated', async t => {
  const f = await fixture(t); await f.prepare('p'); await f.prepare('sibling');
  const review = await f.service.reviewImage(scope, 'p'); f.state.metadata.p = 'Edited';
  await assert.rejects(f.service.approve({ ...scope, publicationId: 'p', requestId: 'stale', kind: 'CREATE', expectedReviewFingerprint: review.fingerprint }), { code: 'publication_review_stale' });
  assert.equal((await rows(f.repositories.operations)).length, 0);
  const accepted = await f.approve('p');
  f.state.metadata.sibling = 'Unrelated edit';
  await f.save('sibling', 'original');
  assert.equal((await f.dispatch(accepted)).operation.state, 'IN_FLIGHT');
  const sibling = await f.approve('sibling'); await f.save('sibling', 'share', undefined, 1);
  const paused = await f.dispatch(sibling);
  assert.equal(paused.operation.state, 'CANCELLED'); assert.equal(paused.operation.blockedCode, 'publication_review_stale');
  assert.deepEqual(paused.operation.snapshot, sibling.operation.snapshot);
});

test('queue outage recovers the same accepted operation after restart; duplicate delivery cannot dispatch twice', async t => {
  const f = await fixture(t); await f.prepare('p'); const accepted = await f.approve('p');
  assert.deepEqual(await recoverPublicationOutbox(f.repositories, async () => { throw Error('queue unavailable'); }), { submitted: 0, failed: 1 });
  f.restart(); const queued = [];
  assert.deepEqual(await recoverPublicationOutbox(f.repositories, async job => queued.push(job)), { submitted: 1, failed: 0 });
  assert.equal(queued[0].operationId, accepted.id);
  const attempts = await Promise.allSettled([f.dispatch(accepted), f.dispatch(accepted)]);
  assert.equal(attempts.filter(r => r.status === 'fulfilled').length, 1);
  const dispatched = attempts.find(r => r.status === 'fulfilled').value;
  await f.result(dispatched, 'remote'); f.restart();
  const replay = await f.approve('p'); assert.equal(replay.id, accepted.id);
  await assert.rejects(f.dispatch(accepted), { code: 'publication_reconciliation_required' });
});

test('post-dispatch settings remain desired; success records the old immutable snapshot and independent evidence', async t => {
  const f = await fixture(t); await f.prepare('p'); await f.save('p', 'share');
  const accepted = await f.approve('p'), dispatched = await f.dispatch(accepted);
  await f.save('p', 'watermarked-original', 'Changed', 1);
  const result = await f.result(dispatched, 'remote');
  assert.equal(result.quarantined, false);
  const p = await f.service.get(scope, 'p');
  assert.equal(p.configurationRevision, 2); assert.equal(p.imageSelection.variant.value, 'watermarked-original');
  assert.equal(p.lastConfirmedImage.variant, 'share'); assert.equal(p.lastConfirmedImage.fileChecksum, accepted.operation.snapshot.file.checksum);
  assert.deepEqual(result.record.operation.snapshot, accepted.operation.snapshot);
});

test('lost response, lease expiry, new fencing generation and stale completion preserve reconciliation evidence', async t => {
  const f = await fixture(t); await f.prepare('p'); const dispatched = await f.dispatch(await f.approve('p'));
  await f.result(dispatched, undefined, 'uncertain'); f.restart();
  await assert.rejects(f.dispatch(dispatched), { code: 'publication_reconciliation_required' });
  await assert.rejects(f.approve('p', 'another'), { code: 'publication_busy' });
  f.advance(11);
  const reconciler = await f.service.beginReconciliation({ ...scope, publicationId: 'p', operationId: dispatched.id, workerId: 'reconciler', leaseSeconds: 10 });
  assert.equal(reconciler.operation.fencingGeneration, 2);
  assert.equal((await f.result(dispatched, 'remote')).quarantined, true);
  assert.equal((await f.service.get(scope, 'p')).remoteId, undefined);
  await f.result(reconciler, 'remote', 'confirmed', 'reconciler');
  assert.equal((await f.service.get(scope, 'p')).remoteId, 'remote');
  assert.ok((await rows(f.repositories.auditEvents)).some(r => r.action === 'publication.result-quarantined'));
});

test('remote claims are exclusive; another principal and foreign IDs cannot acquire authority', async t => {
  const f = await fixture(t); await f.prepare('p'); await f.prepare('sibling');
  const first = await f.dispatch(await f.approve('p')), second = await f.dispatch(await f.approve('sibling'));
  await f.result(first, 'same-remote');
  await assert.rejects(f.result(second, 'same-remote'), { code: 'publication_identity_conflict' });
  assert.equal((await f.service.get(scope, 'sibling')).remoteId, undefined);
  f.state.principal = 'different-account';
  await assert.rejects(f.result(second, 'other-remote'), { code: 'publication_identity_conflict' });
  await assert.rejects(f.service.get({ ...scope, creatorId: 'foreign' }, 'p'), { code: 'publication_not_found' });
  await assert.rejects(f.service.get(scope, 'absent'), { code: 'publication_not_found' });
});

test('current membership loss blocks selected context, without discarding saved settings or delivery history', async t => {
  const f = await fixture(t); await f.prepare('p');
  f.state.collections = [{ tenantId: 'instance', creatorId: 'creator', collectionId: 'collection', workIds: ['work'], preferences: {} }];
  await f.service.saveImageSelection({ ...scope, publicationId: 'p', requestId: 'context', expectedConfigurationRevision: 0,
    selection: { ...selection('original'), context: { mode: 'collection', collectionId: 'collection' } } });
  const accepted = await f.approve('p'); f.state.collections[0].workIds = [];
  await assert.rejects(f.dispatch(accepted), { code: 'publication_context_unavailable' });
  assert.equal((await f.repositories.operations.get(accepted.id)).operation.dispatchedAt, undefined);
  assert.equal((await f.service.get(scope, 'p')).imageSelection.context.collectionId, 'collection');
});

test('legacy adaptation requires explicit inventory, preserves identity/receipts and verifies the execution-policy marker', async t => {
  const f = await fixture(t);
  const copy = { slotId: 'original-slot', creationRequestId: 'original-request', account, purpose: 'VOLUME_FULL', context: { volumeId: 'original-volume' } };
  const draft = await f.repositories.publications.create({ id: 'legacy', ...dataHome, instanceId: scope.instanceId, creatorId: scope.creatorId,
    workId: scope.workId, destination: 'deviantart', status: 'draft', copy });
  const input = { ...scope, publicationId: draft.id, requestId: 'adapt', expectedPublicationRevision: draft.revision, expectedWorkRevision: 1,
    connectionId: 'connection', account, targetKey: 'premium', intent: { full: true } };
  await assert.rejects(f.service.reviewImage(scope, draft.id), { code: 'publication_reconciliation_required' });
  await assert.rejects(f.service.adaptLegacyDraft(input), { code: 'publication_reconciliation_required' });
  f.policy.validateLegacyAdaptation = async () => {};
  const adapted = await f.service.adaptLegacyDraft(input);
  assert.deepEqual(adapted.copy, copy); assert.equal(adapted.createdAt, draft.createdAt); assert.equal(adapted.id, draft.id);
  assert.equal((await f.service.adaptLegacyDraft(input)).id, draft.id);
  assert.equal((await f.service.reviewImage(scope, draft.id)).snapshot.publicationId, draft.id);
  assert.equal((await rows(f.repositories.outbox)).length, 0);
  await assert.rejects(f.repositories.publications.update(adapted.id, adapted.revision, { executionPolicy: { schemaVersion: 1, adaptationReceiptId: 'forged' } }), { code: 'publication_identity_conflict' });
  await f.save(draft.id, 'share');
  assert.equal((await f.dispatch(await f.approve(draft.id))).operation.state, 'IN_FLIGHT');
});

test('bulk settings use exact Publication IDs, preserve mixed siblings and retain stable per-item receipts', async t => {
  const f = await fixture(t); for (const id of ['preview', 'collection', 'volume']) await f.prepare(id);
  const input = { instanceId: scope.instanceId, creatorId: scope.creatorId, requestId: 'batch', items: ['preview', 'volume'].map(id => ({
    workId: scope.workId, publicationId: id, expectedConfigurationRevision: 0, selection: selection(id === 'preview' ? 'share' : 'watermarked-original') })) };
  const saved = await savePublicationImageSelectionBatch(f.service, input);
  assert.equal(saved.workCount, 1); assert.equal(saved.publicationCount, 2); assert.ok(saved.results.every(r => r.status === 'saved'));
  assert.equal((await f.service.get(scope, 'collection')).configurationRevision, 0);
  f.restart();
  const replay = await savePublicationImageSelectionBatch(f.service, { ...input, items: [...input.items].reverse() });
  assert.ok(replay.results.every(r => r.status === 'saved' && r.replayed && r.appliedRevision === 1));
  const changed = await savePublicationImageSelectionBatch(f.service, { ...input, items: [{ ...input.items[0], selection: selection('original') }] });
  assert.equal(changed.results[0].code, 'idempotency_conflict');
  const inventory = await inventoryPublicationCommands(f.repositories, scope);
  assert.equal(inventory.works[0].operationalPublicationIds.length, 3); assert.equal(inventory.providerRequests, 0);
});

test('generic repository writers cannot alter approved snapshots, drop settings or erase identity reservations', async t => {
  const f = await fixture(t); await f.prepare('p'); await f.save('p', 'share'); const accepted = await f.approve('p');
  const p = await f.service.get(scope, 'p');
  await assert.rejects(f.repositories.publications.update(p.id, p.revision, { imageSelection: undefined }), { code: 'publication_revision_conflict' });
  await assert.rejects(f.repositories.operations.update(accepted.id, accepted.revision, { operation: { ...accepted.operation,
    snapshot: { ...accepted.operation.snapshot, variant: 'original' } } }), { code: 'publication_review_stale' });
  await f.repositories.publications.remove(p.id, p.revision);
  await assert.rejects(f.service.prepare({ ...preparation('p'), requestId: 'reuse-deleted-id', targetKey: 'another-target' }), { code: 'publication_identity_conflict' });
});

test('an unverified failure cannot grant another create; a verified final rejection can', async t => {
  const f = await fixture(t); await f.prepare('p'); const dispatched = await f.dispatch(await f.approve('p'));
  await assert.rejects(f.result(dispatched, undefined, 'failed'), { code: 'publication_reconciliation_required' });
  await assert.rejects(f.approve('p', 'new-request'), { code: 'publication_busy' });
  f.policy.verifyFinalFailure = async (_op, evidence) => { assert.equal(evidence.code, 'provider-rejected'); };
  await f.service.recordResult({ ...scope, publicationId: 'p', operationId: dispatched.id, fencingGeneration: 1, workerId: 'worker',
    result: 'failed', failureEvidence: { code: 'provider-rejected' } });
  const fresh = await f.approve('p', 'new-request');
  assert.notEqual(fresh.id, dispatched.id); assert.equal(fresh.operation.state, 'PREPARED');
});

test('an explicitly reviewed context save can correct an unresolved restore marker', async t => {
  const f = await fixture(t); await f.prepare('p');
  let p = await f.service.get(scope, 'p');
  await f.repositories.publications.update(p.id, p.revision, { imageSelection: { ...selection('original'), context: { mode: 'collection', collectionId: 'old-context' } },
    configurationRevision: 1, unresolvedImageContext: { sourceCollectionId: 'old-context' } });
  await assert.rejects(f.service.reviewImage(scope, 'p'), { code: 'publication_context_unavailable' });
  f.state.collections = [{ tenantId: 'instance', creatorId: 'creator', collectionId: 'new-context', workIds: ['work'], preferences: {} }];
  const saved = await f.service.saveImageSelection({ ...scope, publicationId: 'p', requestId: 'correct-context', expectedConfigurationRevision: 1,
    selection: { ...selection('original'), context: { mode: 'collection', collectionId: 'new-context' } } });
  assert.equal(saved.publication.unresolvedImageContext, undefined); assert.equal(saved.publication.configurationRevision, 2);
  assert.equal((await f.service.reviewImage(scope, 'p')).snapshot.variant, 'original');
});
