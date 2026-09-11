import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalCommentStore, LocalSqliteDatabase } from '../dist/index.js';
import { CommentService } from '@ubeeq/core';

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
