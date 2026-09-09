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
