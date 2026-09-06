import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalSqliteDatabase, LocalCreatorMemberStore } from '../dist/index.js';

test('member storage isolates tenants and cells and upserts one membership', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ubeeq-members-'));
  const config = { databasePath: join(directory, 'state.sqlite'), dataDirectory: directory, publicBaseUrl: 'http://localhost', cellId: 'one' };
  const local = new LocalSqliteDatabase(config), foreign = new LocalSqliteDatabase({ ...config, cellId: 'two' });
  try {
    const a = new LocalCreatorMemberStore(local, 'tenant'), b = new LocalCreatorMemberStore(local, 'other'), c = new LocalCreatorMemberStore(foreign, 'tenant');
    const member = { creatorId: 'creator', userId: 'user', role: 'editor', createdAt: 'now' };
    await a.addCreatorMember(member); await a.addCreatorMember(member);
    assert.equal((await a.listCreatorMembers('creator')).length, 1);
    assert.deepEqual(await b.listCreatorMembers('creator'), []);
    assert.deepEqual(await c.listCreatorMembers('creator'), []);
    await b.removeCreatorMember('creator', 'user'); await c.removeCreatorMember('creator', 'user');
    assert.equal((await a.listCreatorMembers('creator')).length, 1);
    await a.removeCreatorMember('creator', 'user');
    assert.deepEqual(await a.listCreatorMembers('creator'), []);
  } finally { local.database.close(); foreign.database.close(); rmSync(directory, { recursive: true, force: true }); }
});
