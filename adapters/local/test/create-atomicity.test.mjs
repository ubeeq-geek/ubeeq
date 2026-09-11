import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalSqliteDatabase, createLocalRepositories } from '../dist/index.js';

const fixture = () => {
  const directory = mkdtempSync(join(tmpdir(), 'ubeeq-create-atomicity-'));
  const local = new LocalSqliteDatabase({ databasePath: join(directory, 'state.sqlite'), dataDirectory: directory, publicBaseUrl: 'http://localhost', cellId: 'cell' });
  return { local, repository: createLocalRepositories(local).federationActors, cleanup: () => { local.database.close(); rmSync(directory, { recursive: true, force: true }); } };
};
const failReceipt = local => local.database.exec(`CREATE TEMP TRIGGER reject_receipt BEFORE INSERT ON ubeeq_idempotency BEGIN SELECT RAISE(ABORT, 'receipt rejected'); END`);

test('failed retry-key persistence rolls back the record and permits a corrected retry', async () => {
  const { local, repository, cleanup } = fixture();
  try {
    failReceipt(local);
    await assert.rejects(repository.create({ id: 'record' }, { idempotencyKey: 'retry' }), /receipt rejected/);
    assert.equal(await repository.get('record'), undefined);
    local.database.exec('DROP TRIGGER reject_receipt');
    const created = await repository.create({ id: 'record' }, { idempotencyKey: 'retry' });
    assert.deepEqual(await repository.create({ id: 'record' }, { idempotencyKey: 'retry' }), created);
  } finally { cleanup(); }
});

test('a caught create failure makes its enclosing transaction rollback-only', async () => {
  const { local, repository, cleanup } = fixture();
  try {
    failReceipt(local);
    await assert.rejects(local.transaction(async () => {
      await repository.create({ id: 'companion' });
      await assert.rejects(repository.create({ id: 'record' }, { idempotencyKey: 'retry' }), /receipt rejected/);
    }), /rollback-only/);
    assert.equal(await repository.get('companion'), undefined);
    assert.equal(await repository.get('record'), undefined);
  } finally { cleanup(); }
});

test('concurrent identical creates on one connection serialize into one record and retry key', async () => {
  const { local, repository, cleanup } = fixture();
  try {
    const results = await Promise.all(Array.from({ length: 8 }, () => repository.create({ id: 'record' }, { idempotencyKey: 'retry' })));
    for (const result of results) assert.deepEqual(result, results[0]);
    assert.equal(local.database.prepare('SELECT count(*) AS count FROM ubeeq_records').get().count, 1);
    assert.equal(local.database.prepare('SELECT count(*) AS count FROM ubeeq_idempotency').get().count, 1);
  } finally { cleanup(); }
});
