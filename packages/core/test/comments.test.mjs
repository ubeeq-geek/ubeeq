import test from 'node:test';
import assert from 'node:assert/strict';
import { CommentModerationService, CommentService } from '../dist/index.js';

const comment = { commentId: 'c', userId: 'user', targetType: 'work', targetId: 'work', body: 'Comment', hidden: false, createdAt: 'now', author: { labels: ['Author'] } };
test('comment moderation authorizes the exact actor and ID before forwarding explicit operations', async () => {
  const calls = [];
  const service = new CommentModerationService({ updateCommentVisibility: async (...args) => calls.push(['visibility', ...args]),
    deleteComment: async (...args) => calls.push(['delete', ...args]) }, async (...args) => { calls.push(['admit', ...args]); return true; });
  await service.setHidden('moderator', 'comment', true);
  await service.setHidden('moderator', 'comment', false);
  await service.delete('moderator', 'comment');
  assert.deepEqual(calls, [['admit', 'visibility', 'comment', 'moderator'], ['visibility', 'comment', true],
    ['admit', 'visibility', 'comment', 'moderator'], ['visibility', 'comment', false],
    ['admit', 'delete', 'comment', 'moderator'], ['delete', 'comment']]);
});
test('comment moderation rejects denied actors, missing IDs and coerced visibility without storage writes', async () => {
  let writes = 0;
  const store = { updateCommentVisibility: async () => writes++, deleteComment: async () => writes++ };
  const denied = new CommentModerationService(store, async () => false);
  await assert.rejects(denied.setHidden('actor', 'comment', true), { code: 'access_denied' });
  await assert.rejects(denied.delete('actor', 'comment'), { code: 'access_denied' });
  const allowed = new CommentModerationService(store, async () => true);
  for (const value of [undefined, null, 0, 1, 'false', {}, []]) await assert.rejects(allowed.setHidden('actor', 'comment', value), { code: 'invalid_comment' });
  await assert.rejects(allowed.delete('', 'comment'), { code: 'access_denied' });
  await assert.rejects(allowed.delete('actor', ' '), { code: 'invalid_comment' });
  assert.equal(writes, 0);
});
test('comment moderation propagates storage and policy failures', async () => {
  const failure = new Error('unavailable');
  const service = new CommentModerationService({ updateCommentVisibility: async () => { throw failure; }, deleteComment: async () => { throw failure; } }, async () => true);
  await assert.rejects(service.setHidden('actor', 'comment', true), error => error === failure);
  await assert.rejects(service.delete('actor', 'comment'), error => error === failure);
  const denied = new CommentModerationService({}, async () => { throw failure; });
  await assert.rejects(denied.delete('actor', 'comment'), error => error === failure);
});
test('comment listing filters target and hidden state before returning independent records', async () => {
  const rows = [structuredClone(comment), { ...comment, hidden: true }, { ...comment, targetId: 'foreign' }, { ...comment, targetType: 'collection' }];
  const calls = [];
  const service = new CommentService({ listComments: async (...args) => { calls.push(args); return rows; } }, async (...args) => { calls.push(args); return true; });
  const result = await service.list('work', 'work');
  assert.deepEqual(result, [comment]);
  result[0].author.labels.push('later');
  assert.deepEqual(rows[0], comment);
  assert.deepEqual(calls, [['list', { targetType: 'work', targetId: 'work' }], ['work', 'work']]);
});
test('comment creation snapshots before admission and owns returned record data', async () => {
  const input = structuredClone(comment); let saved;
  const service = new CommentService({ createComment: async record => { saved = record; } }, async () => { input.body = 'Late edit'; return true; });
  const result = await service.create('user', input);
  assert.deepEqual(result, comment);
  result.author.labels.push('result'); input.author.labels.push('input');
  assert.deepEqual(saved, comment);
});
test('denied, foreign and empty-body comments cannot reach storage', async () => {
  let calls = 0;
  const store = { createComment: async () => { calls++; }, listComments: async () => { calls++; return []; } };
  const denied = new CommentService(store, async () => false);
  await assert.rejects(() => denied.list('work', 'work'), { code: 'access_denied' });
  await assert.rejects(() => denied.create('user', comment), { code: 'access_denied' });
  const service = new CommentService(store, async () => true);
  await assert.rejects(() => service.create('foreign', comment), { code: 'invalid_comment' });
  await assert.rejects(() => service.create('user', { ...comment, body: ' ' }), { code: 'invalid_comment' });
  assert.equal(calls, 0);
});
test('comment storage failures propagate without successful results', async () => {
  const failure = new Error('unavailable');
  const service = new CommentService({ createComment: async () => { throw failure; }, listComments: async () => { throw failure; } }, async () => true);
  await assert.rejects(() => service.list('work', 'work'), error => error === failure);
  await assert.rejects(() => service.create('user', comment), error => error === failure);
});
