import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalFavoriteStore, LocalSqliteDatabase } from '../dist/index.js';
import { FavoriteService } from '@ubeeq/core';

test('local favorites survive restart, isolate tenants and keep duplicate counts exact', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ubeeq-favorites-'));
  const configuration = { databasePath: join(directory, 'state.sqlite'), dataDirectory: directory, cellId: 'cell', publicBaseUrl: 'http://localhost' };
  let local = new LocalSqliteDatabase(configuration);
  try {
    let store = new LocalFavoriteStore(local, 'tenant');
    const record = { userId: 'actor', ownerProfileType: 'creator', ownerProfileId: 'profile', targetType: 'work', targetId: 'work', visibility: 'private', createdAt: 'now' };
    let allowed = false;
    const service = new FavoriteService(store, async () => allowed);
    await assert.rejects(service.add(record), { code: 'access_denied' });
    assert.equal(await store.countByTarget('work', 'work'), 0);
    allowed = true;
    await Promise.all([service.add(record), service.add({ ...record, userId: 'delegate' })]);
    await service.add({ ...record, ownerProfileType: 'user', ownerProfileId: 'actor' });
    await new LocalFavoriteStore(local, 'foreign').addFavorite(record);
    assert.equal(await store.countByTarget('work', 'work'), 2);
    assert.equal((await store.listByProfile('creator', 'profile')).length, 1);
    await assert.rejects(local.transaction(async () => { await store.removeFavorite('actor', 'work', 'work', 'creator', 'profile'); throw new Error('rollback'); }), /rollback/);
    assert.equal(await store.countByTarget('work', 'work'), 2);
    local.database.close(); local = new LocalSqliteDatabase(configuration); store = new LocalFavoriteStore(local, 'tenant');
    assert.deepEqual(await store.listByProfile('creator', 'profile'), [record]);
    await store.removeFavorite('delegate', 'work', 'work', 'creator', 'profile');
    await store.removeFavorite('delegate', 'work', 'work', 'creator', 'profile');
    assert.equal(await store.countByTarget('work', 'work'), 1);
    assert.equal(await new LocalFavoriteStore(local, 'foreign').countByTarget('work', 'work'), 1);
  } finally { local.database.close(); rmSync(directory, { recursive: true, force: true }); }
});
