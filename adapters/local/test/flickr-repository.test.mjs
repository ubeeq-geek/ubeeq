import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalSqliteDatabase, LocalFlickrRepository } from '../dist/index.js';

test('Flickr SQLite state survives restart, isolates scopes and atomically claims owner-bound OAuth requests', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ubeeq-flickr-'));
  const config = { databasePath: join(directory, 'state.sqlite'), dataDirectory: directory, publicBaseUrl: 'http://localhost', cellId: 'cell' };
  let local = new LocalSqliteDatabase(config);
  try {
    let repository = new LocalFlickrRepository(local, 'tenant');
    const connection = { connectionId: 'c', capabilities: { originals: true } };
    await repository.putConnection(connection);
    connection.capabilities.originals = false;
    await repository.putMigration({ migrationId: 'm', connectionId: 'c', items: [{ remoteId: 'photo' }] });
    await repository.putMigration({ migrationId: 'second', connectionId: 'c', items: [] });
    await repository.putMigration({ migrationId: 'm', connectionId: 'c', items: [{ remoteId: 'updated' }] });
    await repository.putOAuthRequest({ requestToken: 'token', userId: 'user', creatorId: 'creator', encryptedRequestTokenSecret: 'encrypted' });
    local.database.close(); local = new LocalSqliteDatabase(config);
    repository = new LocalFlickrRepository(local, 'tenant');
    assert.equal((await repository.getConnection('c')).capabilities.originals, true);
    assert.equal((await repository.getMigrationByConnection('c')).migrationId, 'm');
    const saved = await repository.getMigration('m'); saved.items.length = 0;
    assert.equal((await repository.getMigration('m')).items[0].remoteId, 'updated');
    const foreign = new LocalFlickrRepository(local, 'other');
    for (const connectionId of ['one', 'two', 'three']) await repository.putConnection({ connectionId, userId: 'user', creatorId: 'creator', state: 'CONNECTED' });
    await repository.putConnection({ connectionId: 'foreign-user', userId: 'other', creatorId: 'creator' });
    const first = await repository.listConnections('user', 'creator', { limit: 2 });
    assert.deepEqual(first.items.map(item => item.connectionId), ['one', 'three']);
    assert.ok(first.nextCursor);
    first.items[0].state = 'mutated';
    assert.equal((await repository.getConnection('one')).state, 'CONNECTED');
    assert.deepEqual((await repository.listConnections('user', 'creator', { limit: 2, cursor: first.nextCursor })).items.map(item => item.connectionId), ['two']);
    assert.deepEqual((await foreign.listConnections('user', 'creator', { limit: 2 })).items, []);
    for (const scope of [['other', 'creator'], ['user', 'other']]) await assert.rejects(repository.listConnections(...scope, { limit: 2, cursor: first.nextCursor }), /cursor/);
    await assert.rejects(foreign.listConnections('user', 'creator', { limit: 2, cursor: first.nextCursor }), /cursor/);
    for (const limit of [0, 101, 1.5]) await assert.rejects(repository.listConnections('user', 'creator', { limit }), /page/);
    const plan = local.database.prepare("EXPLAIN QUERY PLAN SELECT id, payload FROM ubeeq_flickr_state INDEXED BY ubeeq_flickr_owner_connections WHERE cell_id = ? AND tenant_id = ? AND kind = 'connection' AND json_extract(payload, '$.userId') = ? AND json_extract(payload, '$.creatorId') = ? AND id > ? ORDER BY id LIMIT ?")
      .all('cell', 'tenant', 'user', 'creator', '', 3);
    assert.match(JSON.stringify(plan), /ubeeq_flickr_owner_connections/);
    assert.doesNotMatch(JSON.stringify(plan), /TEMP B-TREE/);
    assert.equal(await foreign.getConnection('c'), undefined);
    assert.equal(await foreign.getMigration('m'), undefined);
    assert.equal(await foreign.getMigrationByConnection('c'), undefined);
    assert.equal(await foreign.takeOAuthRequest('token', 'user', 'creator'), undefined);
    assert.equal(await repository.takeOAuthRequest('token', 'wrong', 'creator'), undefined);
    assert.equal(await repository.takeOAuthRequest('token', 'user', 'wrong'), undefined);
    const second = new LocalSqliteDatabase(config), otherCell = new LocalSqliteDatabase({ ...config, cellId: 'other' });
    try {
      const isolated = new LocalFlickrRepository(otherCell, 'tenant');
      assert.equal(await isolated.getConnection('c'), undefined);
      assert.equal(await isolated.getMigrationByConnection('c'), undefined);
      assert.equal(await isolated.takeOAuthRequest('token', 'user', 'creator'), undefined);
      const claims = await Promise.all([repository.takeOAuthRequest('token', 'user', 'creator'),
        new LocalFlickrRepository(second, 'tenant').takeOAuthRequest('token', 'user', 'creator')]);
      assert.equal(claims.filter(Boolean).length, 1);
      assert.equal(claims.find(Boolean).encryptedRequestTokenSecret, 'encrypted');
    } finally { second.database.close(); otherCell.database.close(); }
    await assert.rejects(local.transaction(async () => {
      await repository.putConnection({ connectionId: 'rolled-back' });
      throw new Error('rollback');
    }), /rollback/);
    assert.equal(await repository.getConnection('rolled-back'), undefined);
  } finally { local.database.close(); rmSync(directory, { recursive: true, force: true }); }
});
