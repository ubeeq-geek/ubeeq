import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { LocalSqliteDatabase, createLocalRepositories } from '../dist/index.js';
import { UniqueConstraintError, OptimisticConcurrencyError } from '@ubeeq/persistence';

test('handle migration refuses existing duplicates without rewriting identities', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ubeeq-duplicate-handles-'));
  const config = { databasePath: join(directory, 'state.sqlite'), dataDirectory: directory, publicBaseUrl: 'http://localhost', cellId: 'one' };
  const local = new LocalSqliteDatabase(config);
  try {
    local.database.exec('DROP INDEX ubeeq_creator_current_handle');
    local.database.exec('DROP TRIGGER ubeeq_creator_handle_insert');
    local.database.prepare('DELETE FROM ubeeq_schema_migrations WHERE id = ?').run('009-creator-handles');
    for (const id of ['first', 'second']) local.database.prepare('INSERT INTO ubeeq_records VALUES (?, ?, ?, ?, ?, ?)')
      .run('creators', id, 1, JSON.stringify({ id, instanceId: 'tenant', handle: 'duplicate' }), 'now', 'now');
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import { LocalSqliteDatabase } from ${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)}; new LocalSqliteDatabase(JSON.parse(process.argv[1]));`, JSON.stringify(config)], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /UNIQUE constraint failed/);
    assert.equal(local.database.prepare('SELECT id FROM ubeeq_schema_migrations WHERE id = ?').get('009-creator-handles'), undefined);
    assert.deepEqual(local.database.prepare("SELECT id, json_extract(payload, '$.handle') AS handle FROM ubeeq_records WHERE repository = 'creators' ORDER BY id").all().map(row => ({ ...row })),
      [{ id: 'first', handle: 'duplicate' }, { id: 'second', handle: 'duplicate' }]);
  } finally { local.database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('current creator handles are atomic, instance scoped and durable across connections', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ubeeq-creator-handles-'));
  const config = { databasePath: join(directory, 'state.sqlite'), dataDirectory: directory, publicBaseUrl: 'http://localhost', cellId: 'one' };
  const local = new LocalSqliteDatabase(config), other = new LocalSqliteDatabase(config);
  const a = createLocalRepositories(local).creators, b = createLocalRepositories(other).creators;
  const record = (id, handle = 'studio', instanceId = 'tenant') => ({ id, handle, instanceId, displayName: id,
    homeCellId: 'one', dataHomeRegion: 'test', dataHomeAssignedAt: 'now', routingRevision: 1 });
  try {
    const results = await Promise.allSettled([a.create(record('first')), b.create(record('second'))]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = results.find(result => result.status === 'rejected');
    assert.ok(rejected.reason instanceof UniqueConstraintError);
    assert.equal(rejected.reason.constraint.name, 'creator_current_handle');
    const winner = results.find(result => result.status === 'fulfilled').value;
    assert.equal((await a.list({ limit: 100 })).items.length, 1);
    await b.create(record('different-tenant', 'studio', 'other'));
    const editable = await a.create(record('editable', 'different'));
    await assert.rejects(b.update(editable.id, editable.revision, { handle: 'studio' }), UniqueConstraintError);
    assert.equal((await a.get(editable.id)).revision, 1);
    assert.equal((await a.get(editable.id)).handle, 'different');
    await assert.rejects(b.update(editable.id, 0, { handle: 'studio' }), OptimisticConcurrencyError);
    const renamed = await a.update(winner.id, 1, { handle: 'renamed', handleHistory: [] });
    assert.deepEqual(renamed.handleHistory, ['studio', 'renamed']);
    await assert.rejects(b.create(record('alias-thief', 'studio')), UniqueConstraintError);
    await assert.rejects(b.update(editable.id, 1, { handle: 'studio' }), UniqueConstraintError);
    await assert.rejects(b.update(editable.id, 1, { handle: 'unreserved', handleHistory: ['studio'] }), UniqueConstraintError);
    assert.equal((await a.get(editable.id)).revision, 1);
    // The failed multi-alias claim must not reserve even its conflict-free alias.
    await b.create(record('free-after-failure', 'unreserved'));
    await assert.rejects(a.update(winner.id, renamed.revision, { instanceId: 'other' }), /instance is immutable/);
    const restored = await a.update(winner.id, renamed.revision, { handle: 'studio', handleHistory: [] });
    assert.deepEqual(restored.handleHistory, ['studio', 'renamed']);
    const reopened = new LocalSqliteDatabase(config);
    try {
      const creators = createLocalRepositories(reopened).creators;
      await assert.rejects(creators.create(record('after-restart', winner.handle)), UniqueConstraintError);
      await assert.rejects(creators.create(record('old-alias-after-restart', 'renamed')), UniqueConstraintError);
      assert.deepEqual((await creators.get(winner.id)).handleHistory, ['studio', 'renamed']);
    }
    finally { reopened.database.close(); }
  } finally { local.database.close(); other.database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('history migration backfills aliases from existing canonical records', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ubeeq-handle-backfill-'));
  const config = { databasePath: join(directory, 'state.sqlite'), dataDirectory: directory, publicBaseUrl: 'http://localhost', cellId: 'one' };
  const local = new LocalSqliteDatabase(config);
  try {
    local.database.exec('DROP TRIGGER ubeeq_creator_handle_insert; DROP TRIGGER ubeeq_creator_handle_update; DROP TRIGGER ubeeq_creator_handle_delete; DROP TABLE ubeeq_creator_handle_aliases;');
    local.database.prepare('DELETE FROM ubeeq_schema_migrations WHERE id = ?').run('010-creator-handle-history');
    const stored = { id: 'existing', instanceId: 'tenant', handle: 'current', handleHistory: ['legacy'], displayName: 'Existing',
      revision: 1, createdAt: 'now', updatedAt: 'now', homeCellId: 'one', dataHomeRegion: 'test', dataHomeAssignedAt: 'now', routingRevision: 1 };
    local.database.prepare('INSERT INTO ubeeq_records VALUES (?, ?, ?, ?, ?, ?)').run('creators', stored.id, 1, JSON.stringify(stored), 'now', 'now');
    local.database.prepare('INSERT INTO ubeeq_records VALUES (?, ?, ?, ?, ?, ?)').run('creators', 'collision', 1,
      JSON.stringify({ ...stored, id: 'collision', handle: 'other-current' }), 'now', 'now');
    const failed = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import { LocalSqliteDatabase } from ${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)}; new LocalSqliteDatabase(JSON.parse(process.argv[1]));`, JSON.stringify(config)], { encoding: 'utf8' });
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /UNIQUE constraint failed/);
    assert.equal(local.database.prepare('SELECT id FROM ubeeq_schema_migrations WHERE id = ?').get('010-creator-handle-history'), undefined);
    assert.equal(local.database.prepare("SELECT COUNT(*) AS count FROM ubeeq_records WHERE repository = 'creators'").get().count, 2);
    assert.equal(local.database.prepare('SELECT COUNT(*) AS count FROM ubeeq_creator_handle_aliases').get().count, 0);
    // Resolve only this synthetic collision, then prove migration can be retried.
    local.database.prepare("DELETE FROM ubeeq_records WHERE repository = 'creators' AND id = ?").run('collision');
    const reopened = new LocalSqliteDatabase(config);
    try {
      const creators = createLocalRepositories(reopened).creators;
      assert.deepEqual(await creators.get(stored.id), stored);
      await assert.rejects(creators.create({ ...stored, id: 'thief', handle: 'legacy', handleHistory: [] }), UniqueConstraintError);
      await creators.remove(stored.id, 1);
      assert.equal((await creators.create({ ...stored, id: 'after-explicit-delete', handle: 'legacy', handleHistory: [] })).handle, 'legacy');
    } finally { reopened.database.close(); }
  } finally { local.database.close(); rmSync(directory, { recursive: true, force: true }); }
});
