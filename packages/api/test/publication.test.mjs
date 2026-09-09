import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicationService } from '../dist/index.js';

test('publication service requires explicit ownership, readiness and admission before any transaction', async () => {
  const work = { id: 'work', creatorId: 'creator', instanceId: 'instance', homeCellId: 'cell', revision: 1, title: 'Original' };
  let reads = 0, writes = 0, admission = 0;
  let assets = [{ id: 'asset', workId: 'work', creatorId: 'creator', status: 'ready' }];
  const repositories = {
    publicationIntents: { get: async () => { reads++; return undefined; } },
    assets: { list: async () => { reads++; return { items: assets }; } },
    transaction: async () => { writes++; throw new Error('unexpected transaction'); }
  };
  const input = { workId: 'work', actorId: 'owner', destination: 'local', idempotencyKey: 'key' };
  const denied = new PublicationService(repositories, async () => { throw new Error('ownership denied'); }, async () => { admission++; });
  await assert.rejects(denied.publish(input), /ownership denied/);
  assert.equal(reads, 0); assert.equal(writes, 0); assert.equal(admission, 0);
  const mismatched = new PublicationService(repositories, async () => ({ ...work, id: 'other' }), async () => { admission++; });
  await assert.rejects(mismatched.publish(input), { code: 'invalid_request' });
  const held = new PublicationService(repositories, async (id, actor) => {
    assert.equal(id, 'work'); assert.equal(actor, 'owner'); return work;
  }, async (snapshot, attached) => {
    admission++; snapshot.title = 'Changed by policy'; attached[0].creatorId = 'foreign';
    throw new Error('publication held');
  });
  await assert.rejects(held.publish(input), /publication held/);
  assert.equal(work.title, 'Original'); assert.equal(assets[0].creatorId, 'creator');
  assert.equal(writes, 0); assert.equal(admission, 1);
  assets = [{ ...assets[0], creatorId: 'foreign' }];
  await assert.rejects(held.publish(input), { code: 'processing_incomplete' });
  assert.equal(admission, 1); assert.equal(writes, 0);
  await assert.rejects(held.publish({ ...input, idempotencyKey: [] }), { code: 'invalid_idempotency_key' });
  assert.equal(writes, 0);
});

test('publishing without assets requires explicit opt-in and still enforces admission and attachment readiness', async () => {
  const work = { id: 'work', creatorId: 'creator', instanceId: 'instance', homeCellId: 'cell', revision: 1, title: 'Text' };
  let assets = [], admissions = 0, writes = 0;
  const repositories = { publicationIntents: { get: async () => undefined }, assets: { list: async () => ({ items: assets }) },
    transaction: async () => { writes++; throw new Error('transaction reached'); } };
  const input = { workId: 'work', actorId: 'owner', destination: 'local', idempotencyKey: 'text' };
  for (const allowWithoutAssets of [undefined, () => false, () => 'yes']) {
    const service = new PublicationService(repositories, async () => work, async () => { admissions++; }, { allowWithoutAssets });
    await assert.rejects(service.publish(input), { code: 'processing_incomplete' });
  }
  assert.equal(admissions, 0); assert.equal(writes, 0);
  const options = { allowWithoutAssets: snapshot => { snapshot.title = 'Mutated'; return true; } };
  const held = new PublicationService(repositories, async () => work, async (snapshot, attached) => {
    admissions++; assert.equal(snapshot.title, 'Text'); assert.deepEqual(attached, []); throw new Error('policy held');
  }, options);
  await assert.rejects(held.publish(input), /policy held/);
  assert.equal(work.title, 'Text'); assert.equal(writes, 0);
  const admitted = new PublicationService(repositories, async () => work, async () => { admissions++; }, options);
  await assert.rejects(admitted.publish(input), /transaction reached/);
  assert.equal(writes, 1);
  for (const asset of [{ id: 'asset', workId: 'work', creatorId: 'creator', status: 'pending' }, { id: 'asset', workId: 'work', creatorId: 'foreign', status: 'ready' }]) {
    assets = [asset]; await assert.rejects(admitted.publish(input), { code: 'processing_incomplete' });
  }
  assert.equal(admissions, 2); assert.equal(writes, 1);
});
