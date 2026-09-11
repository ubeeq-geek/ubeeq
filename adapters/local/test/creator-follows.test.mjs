import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalCreatorFollowStore, LocalSqliteDatabase } from '../dist/index.js';
import { CreatorFollowService } from '@ubeeq/core';

test('follow point reads are scoped, detached, restart-safe and fail closed on corrupt identity', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ubeeq-follow-lookup-'));
  const config = { databasePath: join(directory, 'state.sqlite'), dataDirectory: directory, cellId: 'cell', publicBaseUrl: 'http://localhost' };
  let local = new LocalSqliteDatabase(config);
  try {
    let store = new LocalCreatorFollowStore(local, 'tenant');
    const record = { followId: 'follow', followerUserId: 'user', creatorId: 'creator', insertedDate: 'before', notificationsEnabled: false };
    await store.followCreator(record);
    assert.deepEqual(await store.getFollow('user', 'creator'), record);
    const detached = await store.getFollow('user', 'creator'); detached.notificationsEnabled = true;
    assert.equal((await store.getFollow('user', 'creator')).notificationsEnabled, false);
    for (const [user, creator] of [['other', 'creator'], ['user', 'other']]) assert.equal(await store.getFollow(user, creator), null);
    assert.equal(await new LocalCreatorFollowStore(local, 'foreign').getFollow('user', 'creator'), null);
    for (const id of ['', ' ', null]) await assert.rejects(store.getFollow(id, 'creator'));
    local.database.close(); local = new LocalSqliteDatabase(config); store = new LocalCreatorFollowStore(local, 'tenant');
    assert.deepEqual(await store.getFollow('user', 'creator'), record);
    const foreign = new LocalSqliteDatabase({ ...config, cellId: 'foreign' });
    try { assert.equal(await new LocalCreatorFollowStore(foreign, 'tenant').getFollow('user', 'creator'), null); } finally { foreign.database.close(); }
    local.database.prepare('UPDATE ubeeq_creator_follows SET payload = ?').run(JSON.stringify({ ...record, creatorId: 'wrong' }));
    await assert.rejects(store.getFollow('user', 'creator'), /stored follow scope/);
  } finally { local.database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('local follows retain complete tenant-scoped state, atomically replace pairs and survive restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ubeeq-follows-'));
  const config = { databasePath: join(directory, 'state.sqlite'), dataDirectory: directory, cellId: 'cell', publicBaseUrl: 'http://localhost' };
  let local = new LocalSqliteDatabase(config);
  try {
    let store = new LocalCreatorFollowStore(local, 'tenant');
    let allowed = false;
    const service = new CreatorFollowService(store, async () => allowed);
    const record = { followId: 'follow', followerUserId: 'user', creatorId: 'creator', insertedDate: 'before', notificationsEnabled: false };
    await assert.rejects(service.follow('user', record), { code: 'access_denied' });
    allowed = true;
    for (let i = 0; i < 102; i++) await service.follow('user', { ...record, followId: `follow-${i}`, creatorId: `creator-${i}` });
    await service.follow('user', record);
    const replacement = { ...record, followId: 'replacement', notificationsEnabled: true };
    await service.follow('user', replacement);
    await new LocalCreatorFollowStore(local, 'foreign').followCreator(record);
    await store.followCreator({ ...record, followerUserId: 'other' });
    assert.equal((await service.list('user')).length, 103);
    await assert.rejects(local.transaction(async () => { await service.unfollow('user', 'creator'); throw new Error('rollback'); }), /rollback/);
    local.database.close(); local = new LocalSqliteDatabase(config); store = new LocalCreatorFollowStore(local, 'tenant');
    const follows = await store.listFollowsByUser('user');
    assert.equal(follows.length, 103); assert.deepEqual(follows.find(item => item.creatorId === 'creator'), replacement);
    await store.unfollowCreator('user', 'creator'); await store.unfollowCreator('user', 'creator');
    assert.equal((await store.listFollowsByUser('user')).length, 102);
    assert.equal((await store.listFollowsByUser('other')).length, 1);
    assert.equal((await new LocalCreatorFollowStore(local, 'foreign').listFollowsByUser('user')).length, 1);
  } finally { local.database.close(); rmSync(directory, { recursive: true, force: true }); }
});
