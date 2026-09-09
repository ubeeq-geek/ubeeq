import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalSqliteDatabase, LocalWorkPublicationLookup, createLocalRepositories } from '../dist/index.js';

test('Work publication lookup scopes pages and current live state without repository enumeration', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ubeeq-publication-lookup-'));
  const config = { databasePath: join(directory, 'db.sqlite'), dataDirectory: directory, publicBaseUrl: 'http://localhost', cellId: 'cell' };
  let local = new LocalSqliteDatabase(config);
  try {
    const repositories = createLocalRepositories(local), lookup = new LocalWorkPublicationLookup(local);
    const scope = { instanceId: 'instance', workId: 'work', destination: 'local' };
    for (let index = 0; index < 105; index++) await repositories.publications.create({ ...scope, id: `p-${String(index).padStart(3, '0')}`, homeCellId: 'cell', status: index === 104 ? 'live' : 'removed' });
    await repositories.publications.create({ ...scope, id: 'foreign-work', workId: 'other', homeCellId: 'cell', status: 'live' });
    const first = await lookup.list(scope, { limit: 100 }); assert.equal(first.items.length, 100); assert.ok(first.nextCursor);
    const second = await lookup.list(scope, { limit: 100, cursor: first.nextCursor }); assert.equal(second.items.length, 5); assert.equal(second.nextCursor, undefined);
    await assert.rejects(lookup.list({ ...scope, workId: 'other' }, { limit: 100, cursor: first.nextCursor }), /cursor scope/);
    await assert.rejects(lookup.list(scope, { limit: 101 }), /limit/);
    assert.equal(await lookup.hasLive(scope), true);
    assert.equal(await lookup.hasLive({ ...scope, instanceId: 'other' }), false);
    assert.equal(await lookup.hasLive({ ...scope, destination: 'other' }), false);
    const live = await repositories.publications.get('p-104'); await repositories.publications.update(live.id, live.revision, { status: 'removed' });
    assert.equal(await lookup.hasLive(scope), false);
    local.database.close(); local = new LocalSqliteDatabase(config);
    assert.equal((await new LocalWorkPublicationLookup(local).list(scope, { limit: 100, cursor: first.nextCursor })).items.length, 5);
    const other = new LocalSqliteDatabase({ ...config, cellId: 'other-cell' });
    try { assert.deepEqual((await new LocalWorkPublicationLookup(other).list(scope, { limit: 100 })).items, []); }
    finally { other.database.close(); }
  } finally { local.database.close(); rmSync(directory, { recursive: true, force: true }); }
});
