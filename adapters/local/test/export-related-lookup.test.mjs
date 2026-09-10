import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalSqliteDatabase, LocalExportRelatedLookup, createLocalRepositories } from '../dist/index.js';

for (const [repository, field] of [['publicationIntents', 'workId'], ['integrationAccounts', 'creatorId']]) {
  test(`${repository} pages isolate scope and retain complete records across restart`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ubeeq-export-related-'));
    const config = { databasePath: join(directory, 'db.sqlite'), dataDirectory: directory, publicBaseUrl: 'http://localhost', cellId: 'cell' };
    let local = new LocalSqliteDatabase(config);
    try {
      const repo = createLocalRepositories(local)[repository];
      const scope = { instanceId: 'instance', [field]: 'owner' };
      for (let index = 0; index < 105; index++) await repo.create({ ...scope, homeCellId: 'cell', id: `p-${String(index).padStart(3, '0')}`,
        destination: index % 2 ? 'one' : 'two', idempotencyKey: `key-${index}`, connectorId: 'connector', health: 'unknown', credentialReference: 'caller-must-sanitize' });
      await repo.create({ ...scope, homeCellId: 'cell', id: 'foreign', [field]: 'other' });
      let lookup = new LocalExportRelatedLookup(local);
      const first = await lookup[repository](scope, { limit: 100 });
      assert.equal(first.items.length, 100); assert.ok(first.nextCursor);
      assert.equal(first.items[0].credentialReference, 'caller-must-sanitize');
      local.database.close(); local = new LocalSqliteDatabase(config); lookup = new LocalExportRelatedLookup(local);
      const last = await lookup[repository](scope, { limit: 100, cursor: first.nextCursor });
      assert.equal(last.items.length, 5); assert.equal(last.nextCursor, undefined);
      for (const change of [{ instanceId: 'foreign' }, { [field]: 'other' }]) {
        await assert.rejects(lookup[repository]({ ...scope, ...change }, { limit: 100, cursor: first.nextCursor }), /cursor scope/);
      }
      const otherMethod = repository === 'publicationIntents' ? 'integrationAccounts' : 'publicationIntents';
      await assert.rejects(lookup[otherMethod]({ instanceId: 'instance', creatorId: 'owner', workId: 'owner' }, { limit: 100, cursor: first.nextCursor }), /cursor scope/);
      for (const limit of [0, 101, NaN]) await assert.rejects(lookup[repository](scope, { limit }), /limit/);
      await assert.rejects(lookup[repository](scope, { limit: 1, cursor: '' }), /cursor scope/);
      const other = new LocalSqliteDatabase({ ...config, cellId: 'other-cell' });
      try { assert.deepEqual((await new LocalExportRelatedLookup(other)[repository](scope, { limit: 100 })).items, []); }
      finally { other.database.close(); }
      const plan = local.database.prepare(`EXPLAIN QUERY PLAN SELECT id, payload FROM ubeeq_records WHERE repository = '${repository}'
        AND json_extract(payload, '$.homeCellId') = ? AND json_extract(payload, '$.instanceId') = ?
        AND json_extract(payload, '$.${field}') = ? AND id > ? ORDER BY id LIMIT ?`).all('cell', 'instance', 'owner', '', 101);
      assert.match(JSON.stringify(plan), /USING INDEX ubeeq_export_/);
      assert.doesNotMatch(JSON.stringify(plan), /TEMP B-TREE/);
    } finally { local.database.close(); rmSync(directory, { recursive: true, force: true }); }
  });
}
