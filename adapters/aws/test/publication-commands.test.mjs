import test from 'node:test';
import assert from 'node:assert/strict';
import { createDynamoPublicationCommandRepositories } from '../dist/index.js';
import { PublicationCommandService } from '@ubeeq/persistence';
import { makePolicy, scope, dataHome, preparation, selection, binding } from '../../../packages/persistence/test/fixtures/publication-command-policy.mjs';

const fixture = async () => {
  const rows = new Map(), commands = []; let beforeCommit;
  const client = { send: async command => {
    commands.push(command); const input = command.input;
    if (command.constructor.name === 'GetCommand') return { Item: structuredClone(rows.get(input.Key.pk)) };
    if (command.constructor.name !== 'TransactWriteCommand') throw Error(`Unexpected standalone mutation: ${command.constructor.name}`);
    if (beforeCommit) { const hook = beforeCommit; beforeCommit = undefined; hook(); }
    const reasons = input.TransactItems.map(entry => {
      const write = entry.Put || entry.Delete || entry.ConditionCheck, key = write.Item?.pk || write.Key.pk;
      const revision = write.ExpressionAttributeValues?.[':revision'];
      const failed = write.ConditionExpression === 'attribute_not_exists(pk)' && rows.has(key) || revision !== undefined && rows.get(key)?.revision !== revision;
      return { Code: failed ? 'ConditionalCheckFailed' : 'None' };
    });
    if (reasons.some(r => r.Code !== 'None')) throw Object.assign(Error('conflict'), { name: 'TransactionCanceledException', CancellationReasons: reasons });
    const next = new Map(rows);
    for (const entry of input.TransactItems) {
      if (entry.Put) next.set(entry.Put.Item.pk, structuredClone(entry.Put.Item));
      if (entry.Delete) next.delete(entry.Delete.Key.pk);
    }
    rows.clear(); for (const [id, value] of next) rows.set(id, value);
    return {};
  } };
  const repositories = createDynamoPublicationCommandRepositories(client, { tableName: 'records', cellId: 'cell' });
  const { policy, state } = makePolicy(repositories), service = new PublicationCommandService(repositories, policy);
  await repositories.transaction(async transaction => repositories.works.create({ id: 'work', ...scope, ...dataHome, title: 'Image', status: 'ready' }, { transaction }));
  return { rows, commands, repositories, service, state, beforeCommit(hook) { beforeCommit = hook; } };
};
const count = (f, repository) => [...f.rows.values()].filter(row => row.repository === repository).length;
const approve = async (f, id) => f.service.approve({ ...scope, publicationId: id, requestId: `approve-${id}`,
  expectedReviewFingerprint: (await f.service.reviewImage(scope, id)).fingerprint, kind: 'CREATE' });
const dispatch = (f, op) => f.service.beginDispatch({ ...scope, publicationId: op.operation.publicationId, operationId: op.id, workerId: 'worker', leaseSeconds: 300 });

test('transaction-aware concurrent hosted preparation reserves one target and commits compatibility records atomically', async () => {
  const f = await fixture();
  const results = await Promise.all(Array.from({ length: 8 }, (_, n) => f.service.prepare({ ...preparation(`p-${n}`), targetKey: 'premium' })));
  assert.equal(results.filter(r => r.created).length, 1);
  assert.equal(new Set(results.map(r => r.publication.id)).size, 1);
  assert.equal(count(f, 'publications'), 1); assert.equal(count(f, 'publicationIntents'), 1); assert.equal(count(f, 'publicationClaims'), 10);
  assert.equal(count(f, 'publicationOutbox'), 0);
  assert.ok(f.commands.filter(c => c.constructor.name === 'GetCommand').every(c => c.input.ConsistentRead === true));
  const writes = f.commands.filter(c => c.constructor.name === 'TransactWriteCommand');
  assert.ok(writes.some(c => c.input.TransactItems.some(item => item.ConditionCheck?.Key.pk === 'works#work')));
});

test('Work ownership/source revision changing at commit rolls back the entire hosted preparation', async () => {
  const f = await fixture();
  f.beforeCommit(() => {
    const row = f.rows.get('works#work'); f.rows.set('works#work', { ...row, revision: 2, value: { ...row.value, revision: 2 } });
  });
  await assert.rejects(f.service.prepare(preparation('p')), { code: 'publication_revision_conflict' });
  for (const name of ['publications', 'publicationIntents', 'publicationClaims', 'auditEvents']) assert.equal(count(f, name), 0);
});

test('hosted status race retries the configuration patch and preserves observation fields; same-revision editors conflict', async () => {
  const f = await fixture(); await f.service.prepare(preparation('p'));
  f.beforeCommit(() => {
    const row = f.rows.get('publications#p'); f.rows.set('publications#p', { ...row, revision: row.revision + 1,
      value: { ...row.value, revision: row.revision + 1, remoteId: 'observed', status: 'live' } });
  });
  const save = await f.service.saveImageSelection({ ...scope, publicationId: 'p', requestId: 'save', expectedConfigurationRevision: 0, selection: selection('share') });
  assert.equal(save.publication.remoteId, 'observed'); assert.equal(save.publication.configurationRevision, 1);
  const attempts = await Promise.allSettled(['original', 'thumbnail'].map(variant => f.service.saveImageSelection({ ...scope, publicationId: 'p',
    requestId: variant, expectedConfigurationRevision: 1, selection: selection(variant) })));
  assert.equal(attempts.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(attempts.find(r => r.status === 'rejected').reason.code, 'publication_revision_conflict');
});

test('hosted acceptance and outbox share one commit; simultaneous provider claims cannot overwrite one owner', async () => {
  const f = await fixture();
  for (const id of ['p', 'sibling']) await f.service.prepare(preparation(id));
  const accepted = await Promise.all(['p', 'sibling'].map(id => approve(f, id)));
  assert.equal(count(f, 'publicationOperations'), 2); assert.equal(count(f, 'publicationOutbox'), 2);
  const dispatched = await Promise.all(accepted.map(op => dispatch(f, op)));
  const attempts = await Promise.allSettled(dispatched.map(op => f.service.recordResult({ ...scope,
    publicationId: op.operation.publicationId, operationId: op.id, fencingGeneration: op.operation.fencingGeneration,
    workerId: 'worker', result: 'confirmed', binding: binding('same-remote') })));
  assert.equal(attempts.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(attempts.find(r => r.status === 'rejected').reason.code, 'publication_identity_conflict');
  const pubs = ['p', 'sibling'].map(id => f.rows.get(`publications#${id}`).value);
  assert.equal(pubs.filter(p => p.remoteId === 'same-remote').length, 1);
});

test('a publication configuration race at dispatch commit prevents old-image authorization', async () => {
  const f = await fixture(); await f.service.prepare(preparation('p')); const accepted = await approve(f, 'p');
  f.beforeCommit(() => {
    const row = f.rows.get('publications#p'); f.rows.set('publications#p', { ...row, revision: row.revision + 1,
      value: { ...row.value, revision: row.revision + 1, configurationRevision: 1, imageSelection: selection('original') } });
  });
  const paused = await dispatch(f, accepted);
  assert.equal(paused.operation.state, 'CANCELLED'); assert.equal(paused.operation.dispatchedAt, undefined);
  assert.equal(f.rows.get(`publicationOutbox#${accepted.id}`).value.state, 'paused');
});
