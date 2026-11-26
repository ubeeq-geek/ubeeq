import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalAdapterSet } from '../dist/index.js';

const fixture = async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ubeeq-current-principal-'));
  const adapters = createLocalAdapterSet({ databasePath: join(directory, 'state.sqlite'), dataDirectory: directory, publicBaseUrl: 'http://127.0.0.1', cellId: 'cell-a' });
  const credentials = { email: 'operator@example.test', password: 'current-principal-password' };
  const account = await adapters.identity.register(credentials);
  return { ...adapters, account, credentials, close: () => { adapters.database.close(); rmSync(directory, { recursive: true, force: true }); } };
};

test('SQLite current principal and existing sessions observe persisted scope, roles and account disablement', async () => {
  const f = await fixture();
  try {
    const login = await f.identity.authenticate(f.credentials);
    assert.equal(login.session.subject.accountScope, 'creator_operator');
    assert.deepEqual(login.session.subject.roles, ['creator']);
    f.database.database.prepare('UPDATE ubeeq_accounts SET account_scope = ?, roles_json = ?, scopes_json = ? WHERE id = ?').run('customer_account', '["customer_account"]', '["purchase.read"]', f.account.id);
    const expected = { id: f.account.id, email: f.credentials.email, accountScope: 'customer_account', roles: ['customer_account'], scopes: ['purchase.read'] };
    assert.deepEqual(await f.identity.getAuthorizationSubject(f.account.id), expected);
    assert.equal(await f.identity.verifySession({ credential: login.token }), undefined, 'an old issued token cannot acquire a different account scope');
    assert.deepEqual((await f.identity.authenticate(f.credentials)).session.subject, expected);
    f.database.database.prepare('UPDATE ubeeq_accounts SET status = ? WHERE id = ?').run('suspended', f.account.id);
    assert.equal(await f.identity.getAuthorizationSubject(f.account.id), undefined);
    assert.equal(await f.identity.verifySession({ credential: login.token }), undefined);
    await assert.rejects(f.identity.authenticate(f.credentials), /Invalid local credentials/);
    assert.equal(await f.identity.getAuthorizationSubject('missing'), undefined);
  } finally { f.close(); }
});

test('SQLite authorization joins the accepting transaction and never retains rolled-back authority', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.repositories.transaction(async () => {
      f.database.database.prepare('UPDATE ubeeq_accounts SET account_scope = ?, roles_json = ? WHERE id = ?').run('customer_account', '[]', f.account.id);
      assert.equal((await f.identity.getAuthorizationSubject(f.account.id)).accountScope, 'customer_account');
      throw new Error('abort actor change');
    }), /abort actor change/);
    const subject = await f.identity.getAuthorizationSubject(f.account.id);
    assert.equal(subject.accountScope, 'creator_operator');
    assert.deepEqual(subject.roles, ['creator']);
    for (const [field, value] of [['roles_json', 'not-json'], ['roles_json', '["creator",1]'], ['scopes_json', '{}'], ['account_scope', 'unknown']]) {
      const before = f.database.database.prepare(`SELECT ${field} AS value FROM ubeeq_accounts WHERE id = ?`).get(f.account.id).value;
      f.database.database.prepare(`UPDATE ubeeq_accounts SET ${field} = ? WHERE id = ?`).run(value, f.account.id);
      await assert.rejects(f.identity.getAuthorizationSubject(f.account.id), /authorization evidence is unavailable/);
      f.database.database.prepare(`UPDATE ubeeq_accounts SET ${field} = ? WHERE id = ?`).run(before, f.account.id);
    }
  } finally { f.close(); }
});
