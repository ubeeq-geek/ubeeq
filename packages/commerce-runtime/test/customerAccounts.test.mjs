import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { SqliteCommerceStore } from '../../../adapters/local/dist/index.js';
import { CommerceService, CommerceError } from '@ubeeq/commerce';
import { createCustomerAccounts, resolveStorefrontAccountConfig } from '../dist/index.js';

const key = 'test-encryption-key-for-customer-accounts-32b';

async function setupFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ubeeq-cust-acc-'));
  const dbPath = join(dir, 'test-commerce.sqlite');
  const store = new SqliteCommerceStore('test-tenant', dbPath, key);
  const service = new CommerceService({
    store,
    tokenKey: key,
    publicBaseUrl: 'https://shop.example.test',
    mail: { send: async () => {} },
    now: () => new Date(),
  });
  const runtime = { store, service };
  return { dir, store, service, runtime };
}

test('default open-core customer ID and username hashing', async (t) => {
  const { dir, store, runtime } = await setupFixture();
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const accounts = createCustomerAccounts(
    { tenantId: 'test-tenant' },
    runtime
  );

  const config = accounts.resolveConfig();
  assert.equal(config.idHashNamespace, 'ubeeq-customer:');
  assert.equal(config.idPrefix, 'cust-');
  assert.equal(config.ownerId, 'instance-customers');
  assert.equal(config.sessionCookieName, 'ubeeq.customer.session');

  const email = 'buyer@example.test';
  const provisioned = await accounts.provision({ email, commerceSubjectId: 'sub-123' });

  const expectedId = createHash('sha256').update('ubeeq-customer:' + email).digest('hex');
  const record = await store.transaction((tx) => tx.get('memberAccount', expectedId));
  assert.ok(record, 'MemberAccount record must be stored under deterministic sha256 id');
  assert.equal(record.email, email);
  assert.equal(record.ownerId, 'instance-customers');
  assert.ok(provisioned.username.startsWith('cust-'));
  assert.equal(provisioned.passwordSetupRequired, true);
});

test('legacy customer account config overrides hashing namespace and prefixes cleanly', async (t) => {
  const { dir, store, runtime } = await setupFixture();
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const legacyConfig = {
    idHashNamespace: 'legacy-member:',
    idPrefix: 'leg-',
    ownerId: 'legacy-members',
    sessionCookieName: 'legacy.member.session',
    accountLabel: 'Legacy member account',
  };

  const accounts = createCustomerAccounts(
    {
      tenantId: 'test-tenant',
      brand: {
        brandId: 'custom-brand',
        productName: 'CustomProduct',
        studioName: 'CustomProduct Studio',
        legacyCustomerAccountConfig: legacyConfig,
      },
    },
    runtime
  );

  const resolved = accounts.resolveConfig();
  assert.equal(resolved.idHashNamespace, 'legacy-member:');
  assert.equal(resolved.idPrefix, 'leg-');
  assert.equal(resolved.ownerId, 'legacy-members');
  assert.equal(resolved.sessionCookieName, 'legacy.member.session');

  const email = 'legacy-buyer@example.test';
  const provisioned = await accounts.provision({ email, commerceSubjectId: 'sub-legacy' });

  const expectedId = createHash('sha256').update('legacy-member:' + email).digest('hex');
  const record = await store.transaction((tx) => tx.get('memberAccount', expectedId));
  assert.ok(record);
  assert.equal(record.ownerId, 'legacy-members');
  assert.ok(provisioned.username.startsWith('leg-'));
});

test('local scrypt password setup and authentication with constant-time verification', async (t) => {
  const { dir, store, runtime } = await setupFixture();
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const accounts = createCustomerAccounts({ tenantId: 'test-tenant' }, runtime);
  const email = 'password-user@example.test';
  const provisioned = await accounts.provision({ email, commerceSubjectId: 'sub-pw' });

  // Issue verified session to set password
  const initialSession = await runtime.service.issueAccountSession(provisioned.commerceSubjectId, provisioned.userId);
  assert.ok(initialSession.token);

  // Set password
  const updatedDto = await accounts.setPassword(initialSession.token, 'SuperSecretPassword123!');
  assert.equal(updatedDto.passwordSetupRequired, false);

  // Authenticate with valid password
  const loginResult = await accounts.passwordSignIn(email, 'SuperSecretPassword123!');
  assert.ok(loginResult.token);
  assert.equal(loginResult.account.email, email);

  // Reject wrong password
  await assert.rejects(
    async () => accounts.passwordSignIn(email, 'WrongPassword999!'),
    (err) => err instanceof CommerceError && err.status === 401
  );
});

test('rate limit triggers after 5 failed password attempts', async (t) => {
  const { dir, store, runtime } = await setupFixture();
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const accounts = createCustomerAccounts({ tenantId: 'test-tenant' }, runtime);
  const email = 'rate-limit-user@example.test';
  const provisioned = await accounts.provision({ email, commerceSubjectId: 'sub-rl' });
  const initialSession = await runtime.service.issueAccountSession(provisioned.commerceSubjectId, provisioned.userId);
  await accounts.setPassword(initialSession.token, 'SuperSecretPassword123!');

  for (let i = 0; i < 5; i++) {
    await assert.rejects(
      async () => accounts.passwordSignIn(email, 'WrongPassword!'),
      (err) => err instanceof CommerceError && err.status === 401
    );
  }

  // 6th attempt hits rate limit
  await assert.rejects(
    async () => accounts.passwordSignIn(email, 'SuperSecretPassword123!'),
    (err) => err instanceof CommerceError && err.status === 429
  );
});

test('change password updates hash and revokes concurrent sessions', async (t) => {
  const { dir, store, runtime } = await setupFixture();
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const accounts = createCustomerAccounts({ tenantId: 'test-tenant' }, runtime);
  const email = 'change-pw-user@example.test';
  const provisioned = await accounts.provision({ email, commerceSubjectId: 'sub-cpw' });
  const initialSession = await runtime.service.issueAccountSession(provisioned.commerceSubjectId, provisioned.userId);
  await accounts.setPassword(initialSession.token, 'OldPassword123456!');

  const activeSession1 = await accounts.passwordSignIn(email, 'OldPassword123456!');
  const activeSession2 = await accounts.passwordSignIn(email, 'OldPassword123456!');

  // Change password using session 1
  const changeRes = await accounts.changePassword(
    activeSession1.token,
    'OldPassword123456!',
    'NewStrongPassword789!'
  );
  assert.equal(changeRes.changed, true);

  // New password authenticates
  const newLogin = await accounts.passwordSignIn(email, 'NewStrongPassword789!');
  assert.ok(newLogin.token);

  // Old password fails
  await assert.rejects(
    async () => accounts.passwordSignIn(email, 'OldPassword123456!'),
    (err) => err instanceof CommerceError && err.status === 401
  );
});
