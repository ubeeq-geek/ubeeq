import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalCommentStore, LocalSqliteDatabase } from '../dist/index.js';
import { CommentModerationService, CommentService } from '@ubeeq/core';

test('comment erasure clears text, preserves scoped identity across restart and cannot be restored or recreated', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ubeeq-comment-erasure-'));
  const config = { databasePath: join(directory, 'state.sqlite'), dataDirectory: directory, cellId: 'cell', publicBaseUrl: 'http://localhost' };
  let local = new LocalSqliteDatabase(config);
  try {
    let store = new LocalCommentStore(local, 'tenant');
    const record = { commentId: 'id', userId: 'author', targetType: 'work', targetId: 'work', body: 'Private text', hidden: false, createdAt: '2026-01-01' };
    await store.createComment(record);
    await new LocalCommentStore(local, 'other').createComment(record);
    assert.equal(await store.eraseComment('work', 'foreign', 'id', '2026-01-02'), false);
    assert.equal(await store.eraseComment('work', 'work', 'id', '2026-01-02'), true);
    assert.equal(await store.eraseComment('work', 'work', 'id', '2026-01-03'), false);
    await store.updateCommentVisibility('id', false);
    assert.deepEqual(await store.listComments('work', 'work'), []);
    assert.deepEqual((await store.listCommentPage('work', 'work', { limit: 1, includeHidden: true })).items, []);
    assert.equal((await new LocalCommentStore(local, 'other').getComment('work', 'work', 'id')).body, 'Private text');
    local.database.close(); local = new LocalSqliteDatabase(config); store = new LocalCommentStore(local, 'tenant');
    assert.deepEqual(await store.getComment('work', 'work', 'id'), { ...record, body: '', hidden: true, deletedAt: '2026-01-02' });
    await assert.rejects(store.createComment(record));
    await assert.rejects(store.createComment({ ...record, commentId: 'new', deletedAt: '2026-01-02' }), /Invalid comment record/);
  } finally { local.database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('comment keyset pages bound results, filter hidden records before paging and retain target scope', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ubeeq-comment-pages-'));
  const config = { databasePath: join(directory, 'state.sqlite'), dataDirectory: directory, cellId: 'cell', publicBaseUrl: 'http://localhost' };
  let local = new LocalSqliteDatabase(config);
  try {
    let store = new LocalCommentStore(local, 'tenant');
    const comment = id => ({ commentId: id, userId: 'author', targetType: 'work', targetId: 'work', body: id, hidden: ['b', 'd'].includes(id), createdAt: '2026-01-01' });
    for (const id of ['e', 'b', 'a', 'd', 'c']) await store.createComment(comment(id));
    await store.createComment({ ...comment('foreign-target'), targetId: 'other' });
    await new LocalCommentStore(local, 'other').createComment(comment('foreign-tenant'));
    const first = await store.listCommentPage('work', 'work', { limit: 2 });
    assert.deepEqual(first.items.map(item => item.commentId), ['a', 'c']);
    assert.deepEqual(first.nextCursor, { createdAt: '2026-01-01', commentId: 'c' });
    const second = await store.listCommentPage('work', 'work', { limit: 2, after: first.nextCursor });
    assert.deepEqual(second.items.map(item => item.commentId), ['e']); assert.equal(second.nextCursor, undefined);
    const moderation = await store.listCommentPage('work', 'work', { limit: 2, includeHidden: true });
    assert.deepEqual(moderation.items.map(item => item.commentId), ['a', 'b']);
    for (const options of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: 2, includeHidden: 'false' }, { limit: 2, after: {} }]) {
      await assert.rejects(store.listCommentPage('work', 'work', options), /Invalid comment page/);
    }
    const plan = local.database.prepare("EXPLAIN QUERY PLAN SELECT payload FROM ubeeq_comments WHERE cell_id = ? AND tenant_id = ? AND target_type = ? AND target_id = ? AND json_extract(payload, '$.hidden') = 0 AND (created_at, comment_id) > (?, ?) ORDER BY created_at, comment_id LIMIT ?")
      .all('cell', 'tenant', 'work', 'work', '2026-01-01', 'a', 3);
    assert.ok(plan.some(row => row.detail.includes('ubeeq_comments_visible_target')));
    await store.deleteComment('c'); // A continuation is a position, not a required live row.
    local.database.close(); local = new LocalSqliteDatabase(config); store = new LocalCommentStore(local, 'tenant');
    assert.deepEqual((await store.listCommentPage('work', 'work', { limit: 2, after: first.nextCursor })).items.map(item => item.commentId), ['e']);
    await store.updateCommentVisibility('b', false);
    assert.deepEqual((await store.listCommentPage('work', 'work', { limit: 2 })).items.map(item => item.commentId), ['a', 'b']);
    assert.deepEqual((await store.listCommentPage('work', 'missing', { limit: 2 })).items, []);
  } finally { local.database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('exact comment lookup is scoped, includes hidden retry records and survives restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ubeeq-comment-lookup-'));
  const config = { databasePath: join(directory, 'state.sqlite'), dataDirectory: directory, cellId: 'cell', publicBaseUrl: 'http://localhost' };
  let local = new LocalSqliteDatabase(config);
  try {
    let store = new LocalCommentStore(local, 'tenant');
    const comment = { commentId: 'id', userId: 'author', targetType: 'work', targetId: 'work', body: 'Retained', hidden: true, createdAt: 'now' };
    await store.createComment(comment);
    assert.deepEqual(await store.getComment('work', 'work', 'id'), comment);
    for (const args of [['work', 'other', 'id'], ['post', 'work', 'id'], ['work', 'work', 'missing']]) assert.equal(await store.getComment(...args), null);
    assert.equal(await new LocalCommentStore(local, 'other').getComment('work', 'work', 'id'), null);
    for (const args of [['', 'work', 'id'], ['work', '', 'id'], ['work', 'work', ' ']]) await assert.rejects(store.getComment(...args), /Invalid comment lookup/);
    const result = await store.getComment('work', 'work', 'id'); result.body = 'Changed';
    assert.equal((await store.getComment('work', 'work', 'id')).body, 'Retained');
    local.database.close(); local = new LocalSqliteDatabase(config); store = new LocalCommentStore(local, 'tenant');
    assert.deepEqual(await store.getComment('work', 'work', 'id'), comment);
    local.database.prepare("UPDATE ubeeq_comments SET payload = json_set(payload, '$.targetId', 'wrong') WHERE comment_id = 'id'").run();
    await assert.rejects(store.getComment('work', 'work', 'id'), /Invalid stored comment identity/);
    local.database.close(); local = new LocalSqliteDatabase({ ...config, cellId: 'other-cell' });
    assert.equal(await new LocalCommentStore(local, 'tenant').getComment('work', 'work', 'id'), null);
  } finally { local.database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('local comment moderation is scoped, durable, non-resurrecting and participates in rollback', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ubeeq-comment-moderation-'));
  const config = { databasePath: join(directory, 'state.sqlite'), dataDirectory: directory, cellId: 'cell', publicBaseUrl: 'http://localhost' };
  let local = new LocalSqliteDatabase(config);
  try {
    let store = new LocalCommentStore(local, 'tenant');
    const foreign = new LocalCommentStore(local, 'foreign');
    const comment = { commentId: 'comment', userId: 'author', targetType: 'work', targetId: 'work', body: 'Retained', hidden: false, createdAt: 'now', labels: ['extra'] };
    await store.createComment(comment); await foreign.createComment(comment);
    let allowed = false;
    const service = new CommentModerationService(store, async () => allowed);
    await assert.rejects(service.setHidden('actor', 'comment', true), { code: 'access_denied' });
    await assert.rejects(service.delete('actor', 'comment'), { code: 'access_denied' });
    allowed = true;
    await service.setHidden('actor', 'comment', true);
    assert.deepEqual(await store.listComments('work', 'work'), [{ ...comment, hidden: true }]);
    assert.deepEqual(await foreign.listComments('work', 'work'), [comment]);
    await assert.rejects(local.transaction(async () => {
      await service.setHidden('actor', 'comment', false); throw new Error('audit failed');
    }), /audit failed/);
    await assert.rejects(local.transaction(async () => {
      await service.delete('actor', 'comment'); throw new Error('audit failed');
    }), /audit failed/);
    local.database.close(); local = new LocalSqliteDatabase(config); store = new LocalCommentStore(local, 'tenant');
    assert.deepEqual(await store.listComments('work', 'work'), [{ ...comment, hidden: true }]);
    const restored = new CommentModerationService(store, async () => true);
    await restored.setHidden('actor', 'comment', false);
    assert.deepEqual(await store.listComments('work', 'work'), [comment]);
    await restored.delete('actor', 'comment'); await restored.delete('actor', 'comment');
    await restored.setHidden('actor', 'comment', false); // Missing rows are not recreated.
    await assert.rejects(store.updateCommentVisibility('comment', 'false'), /Invalid/);
    local.database.close(); local = new LocalSqliteDatabase(config);
    assert.deepEqual(await new LocalCommentStore(local, 'tenant').listComments('work', 'work'), []);
    assert.deepEqual(await new LocalCommentStore(local, 'foreign').listComments('work', 'work'), [comment]);
  } finally { local.database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('local comments survive restart without overwrites, hidden leakage or cross-tenant reads', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ubeeq-comments-'));
  const config = { databasePath: join(directory, 'state.sqlite'), dataDirectory: directory, cellId: 'cell', publicBaseUrl: 'http://localhost' };
  let local = new LocalSqliteDatabase(config);
  try {
    let store = new LocalCommentStore(local, 'tenant');
    let allowed = false;
    const service = new CommentService(store, async () => allowed);
    const comment = { commentId: 'comment', userId: 'user', targetType: 'work', targetId: 'work', body: '<b>literal</b>', hidden: false, createdAt: 'now' };
    await assert.rejects(service.create('user', comment), { code: 'access_denied' });
    allowed = true;
    await service.create('user', comment);
    await assert.rejects(service.create('user', { ...comment, body: 'replacement' }), error => error.constraint?.name === 'comment_id');
    await service.create('user', { ...comment, commentId: 'hidden', hidden: true });
    for (let i = 0; i < 101; i++) await service.create('user', { ...comment, commentId: `later-${i}` });
    await new LocalCommentStore(local, 'foreign').createComment({ ...comment, body: 'foreign' });
    await store.createComment({ ...comment, commentId: 'other-target', targetId: 'other' });
    const listed = await service.list('work', 'work'); assert.equal(listed.length, 102);
    assert.equal(listed.find(item => item.commentId === 'comment').body, '<b>literal</b>');
    listed[0].body = 'caller-mutation';
    await assert.rejects(local.transaction(async () => { await service.create('user', { ...comment, commentId: 'rollback' }); throw new Error('rollback'); }), /rollback/);
    local.database.close(); local = new LocalSqliteDatabase(config); store = new LocalCommentStore(local, 'tenant');
    const restored = await new CommentService(store, async () => true).list('work', 'work');
    assert.equal(restored.length, 102); assert.equal(restored.find(item => item.commentId === 'comment').body, '<b>literal</b>');
    assert.equal((await store.listComments('work', 'work')).length, 103);
  } finally { local.database.close(); rmSync(directory, { recursive: true, force: true }); }
});
