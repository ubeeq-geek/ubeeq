import test from 'node:test';
import assert from 'node:assert/strict';
import { CreatorFollowService } from '../dist/index.js';

const record = { followId: 'f', followerUserId: 'user', creatorId: 'creator', insertedDate: 'now', notificationsEnabled: true, extra: { tags: ['retained'] } };
test('follow reads recheck access after storage and snapshot page controls and results', async () => {
  for (const paged of [false, true]) {
    let allowed = true, reads = 0;
    const store = { listFollowsByUser: async () => { reads++; allowed = false; return [record]; },
      listFollowPage: async () => { reads++; allowed = false; return { items: [record] }; } };
    const service = new CreatorFollowService(store, async () => allowed);
    await assert.rejects(paged ? service.listPage('user', { limit: 2 }) : service.list('user'), { code: 'access_denied' });
    assert.equal(reads, 1);
  }
  const options = { limit: 2, afterCreatorId: 'before' }, result = { items: [structuredClone(record)], nextCreatorId: 'creator' };
  let checks = 0;
  const service = new CreatorFollowService({ listFollowPage: async (_user, supplied) => {
    assert.deepEqual(supplied, { limit: 2, afterCreatorId: 'before' }); return result;
  } }, async () => {
    if (++checks === 1) { options.limit = 100; options.afterCreatorId = 'changed'; }
    else { result.items[0].followerUserId = 'other'; result.nextCreatorId = 'changed'; }
    return true;
  });
  assert.deepEqual(await service.listPage('user', options), { items: [record], nextCreatorId: 'creator' });
  assert.equal(checks, 2);
});
test('follow operations isolate records and scope lists before returning adapter data', async () => {
  const records = []; const calls = [];
  const service = new CreatorFollowService({
    followCreator: async value => { records.splice(0, records.length, value); },
    listFollowsByUser: async () => [...records, { ...record, followerUserId: 'other' }],
    unfollowCreator: async (...args) => { calls.push(args); records.length = 0; }
  }, async (...args) => { calls.push(args); return true; });
  const input = structuredClone(record);
  const saved = await service.follow('user', input);
  input.extra.tags.push('input'); saved.extra.tags.push('output');
  const listed = await service.list('user');
  assert.deepEqual(listed, [record]); listed[0].extra.tags.push('list');
  assert.deepEqual(records, [record]);
  await service.follow('user', { ...record, notificationsEnabled: false });
  assert.equal((await service.list('user')).length, 1);
  await service.unfollow('user', 'creator');
  assert.deepEqual(calls.at(-1), ['user', 'creator']);
  assert.deepEqual(await service.list('user'), []);
});
test('denied actors and foreign follow records never reach storage', async () => {
  let writes = 0, reads = 0;
  const store = { followCreator: async () => { writes++; }, unfollowCreator: async () => { writes++; }, listFollowsByUser: async () => { reads++; return []; } };
  const denied = new CreatorFollowService(store, async () => false);
  for (const operation of [() => denied.list('user'), () => denied.follow('user', record), () => denied.unfollow('user', 'creator')]) {
    await assert.rejects(operation, { code: 'access_denied' });
  }
  const allowed = new CreatorFollowService(store, async () => true);
  await assert.rejects(() => allowed.follow('other', record), { code: 'invalid_follow' });
  await assert.rejects(() => allowed.unfollow('user', ' '), { code: 'invalid_follow' });
  assert.equal(writes, 0); assert.equal(reads, 0);
});
test('storage failures propagate without returning successful follow state', async () => {
  const failure = new Error('durable write failed');
  const service = new CreatorFollowService({ followCreator: async () => { throw failure; }, unfollowCreator: async () => { throw failure; } }, async () => true);
  await assert.rejects(() => service.follow('user', record), error => error === failure);
  await assert.rejects(() => service.unfollow('user', 'creator'), error => error === failure);
});
