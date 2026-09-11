import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
test('scoped uniqueness migration preserves complete existing rows and isolates ambiguous stored keys', () => {
  const database = new DatabaseSync(':memory:');
  const sql = name => readFileSync(new URL(`../migrations/${name}.sql`, import.meta.url), 'utf8');
  try {
    database.exec(sql('001-initial')); database.exec(sql('005-regional-cell'));
    database.prepare(`INSERT INTO ubeeq_jobs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      'existing', 'render', '{"private":true}', 'a:b:c', 'leased', 2, 3, 'due', 'lease-token', 'expiry', 'created', 'updated', 'correlation', '{"code":"retry"}', 'a:b');
    const before = database.prepare('SELECT * FROM ubeeq_jobs').get();
    database.exec(sql('019-job-scope-uniqueness'));
    assert.deepEqual(database.prepare('SELECT * FROM ubeeq_jobs').get(), before);
    database.exec(sql('019-job-scope-uniqueness')); // Safe after commit-before-migration-marker interruption.
    assert.deepEqual(database.prepare('SELECT * FROM ubeeq_jobs').get(), before);
    database.prepare(`INSERT INTO ubeeq_jobs SELECT 'other',type,payload,idempotency_key,state,attempt,max_attempts,available_at,lease_token,lease_expires_at,created_at,updated_at,correlation_id,last_error,'a' FROM ubeeq_jobs WHERE id='existing'`).run();
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM ubeeq_jobs').get().count, 2);
    assert.throws(() => database.prepare(`INSERT INTO ubeeq_jobs SELECT 'duplicate',type,payload,idempotency_key,state,attempt,max_attempts,available_at,lease_token,lease_expires_at,created_at,updated_at,correlation_id,last_error,cell_id FROM ubeeq_jobs WHERE id='existing'`).run(), /UNIQUE/);
  } finally { database.close(); }
});
