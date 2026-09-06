import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalSqliteDatabase } from '../dist/index.js';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const fixture = () => {
  const directory = mkdtempSync(join(tmpdir(), 'ubeeq-tx-'));
  const local = new LocalSqliteDatabase({ databasePath: join(directory, 'state.sqlite'), dataDirectory: directory, publicBaseUrl: 'http://localhost', cellId: 'cell' });
  local.database.exec('CREATE TABLE isolation_test (id TEXT PRIMARY KEY)');
  return { local, close: () => { local.database.close(); rmSync(directory, { recursive: true, force: true }); } };
};

test('independent transactions serialize and unrelated operations cannot join a rollback', async () => {
  const { local, close } = fixture();
  const entered = deferred(), resume = deferred();
  const insert = local.database.prepare('INSERT INTO isolation_test VALUES (?)');
  const read = local.database.prepare('SELECT id FROM isolation_test');
  try {
    const first = local.transaction(async () => { insert.run('rolled-back'); entered.resolve(); await resume.promise; throw Error('rollback first'); });
    const rejected = assert.rejects(first, /rollback first/);
    await entered.promise;
    let secondEntered = false;
    const second = local.transaction(async () => { secondEntered = true; insert.run('committed'); });
    assert.equal(secondEntered, false);
    assert.throws(() => insert.run('unrelated'), /another transaction/);
    assert.throws(() => read.all(), /another transaction/);
    resume.resolve(); await rejected; await second;
    assert.deepEqual(read.all().map(row => row.id), ['committed']);
  } finally { close(); }
});

test('nested calls share one identity and a caught nested failure still rolls back', async () => {
  const { local, close } = fixture();
  try {
    await assert.rejects(local.transaction(async outer => {
      local.database.prepare('INSERT INTO isolation_test VALUES (?)').run('outer');
      await assert.rejects(local.transaction(async inner => { assert.equal(inner.id, outer.id); throw Error('nested'); }), /nested/);
    }), /rollback-only/);
    assert.equal(local.database.prepare('SELECT count(*) AS total FROM isolation_test').get().total, 0);
    await local.transaction(async () => { local.database.prepare('INSERT INTO isolation_test VALUES (?)').run('after'); });
    assert.equal(local.database.prepare('SELECT count(*) AS total FROM isolation_test').get().total, 1);
  } finally { close(); }
});

test('late asynchronous descendants cannot reuse an ended transaction', async () => {
  const { local, close } = fixture(); const trigger = deferred(); let late;
  try {
    await local.transaction(async () => {
      late = trigger.promise.then(() => local.database.prepare('INSERT INTO isolation_test VALUES (?)').run('late'));
    });
    const rejected = assert.rejects(late, /context has ended/); trigger.resolve(); await rejected;
    assert.equal(local.database.prepare('SELECT count(*) AS total FROM isolation_test').get().total, 0);
  } finally { close(); }
});
