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
