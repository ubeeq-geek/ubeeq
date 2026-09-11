import test from 'node:test';
import assert from 'node:assert/strict';
import { CommentService } from '../dist/index.js';

const comment = { commentId: 'c', userId: 'user', targetType: 'work', targetId: 'work', body: 'Comment', hidden: false, createdAt: 'now', author: { labels: ['Author'] } };
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
