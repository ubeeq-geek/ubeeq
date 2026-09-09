import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryFlickrRepository } from '../dist/index.js';

test('Flickr repository detaches stored and returned connection and migration state', async () => {
  const repository = new InMemoryFlickrRepository();
  const connection = { connectionId: 'connection', capabilities: { inventory: true } };
  await repository.putConnection(connection);
  connection.capabilities.inventory = false;
  const saved = await repository.getConnection('connection');
  assert.equal(saved.capabilities.inventory, true);
  saved.capabilities.inventory = false;
  assert.equal((await repository.getConnection('connection')).capabilities.inventory, true);
  const migration = { migrationId: 'migration', connectionId: 'connection', items: [{ remoteId: 'photo' }] };
  await repository.putMigration(migration);
  migration.items[0].remoteId = 'changed';
  const byConnection = await repository.getMigrationByConnection('connection');
  assert.equal(byConnection.items[0].remoteId, 'photo');
  byConnection.items.length = 0;
  const byId = await repository.getMigration('migration');
  assert.equal(byId.items.length, 1);
  byId.items.length = 0;
  assert.equal((await repository.getMigration('migration')).items.length, 1);
  assert.equal(await repository.getMigration('missing'), undefined);
  assert.equal(await repository.getMigrationByConnection('missing'), undefined);
  assert.equal(await repository.getConnection('missing'), undefined);
});

test('Flickr OAuth claims preserve requests after wrong-owner attempts and consume once', async () => {
  const repository = new InMemoryFlickrRepository();
  const request = { requestToken: 'token', userId: 'user', creatorId: 'creator', encryptedRequestTokenSecret: 'encrypted' };
  await repository.putOAuthRequest(request);
  request.encryptedRequestTokenSecret = 'mutated';
  assert.equal(await repository.takeOAuthRequest('token', 'other', 'creator'), undefined);
  assert.equal(await repository.takeOAuthRequest('token', 'user', 'other'), undefined);
  const claims = await Promise.all([
    repository.takeOAuthRequest('token', 'user', 'creator'),
    repository.takeOAuthRequest('token', 'user', 'creator'),
  ]);
  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal(claims.find(Boolean).encryptedRequestTokenSecret, 'encrypted');
  assert.equal(await repository.takeOAuthRequest('token', 'user', 'creator'), undefined);
});
