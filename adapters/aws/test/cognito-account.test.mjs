import test from 'node:test';
import assert from 'node:assert/strict';
import { CognitoIdentity } from '../dist/index.js';
const fixture = (response = { Username: 'operator', Enabled: true, UserStatus: 'CONFIRMED' }) => {
  const calls = [];
  const state = { response: response instanceof Error?response:{...response,UserAttributes:response.UserAttributes??[{Name:'sub',Value:response.Username}]} };
  const adapter = new CognitoIdentity({ send: async command => { calls.push(command); if (state.response instanceof Error) throw state.response; return state.response; } }, 'us-east-2_test', 'client');
  return { adapter, calls, state };
};
test('Cognito account lookup reads the configured pool every time and observes a disabled operator', async () => {
  const f = fixture({ Username: 'operator', Enabled: true, UserStatus: 'CONFIRMED', UserCreateDate: new Date('2026-01-01T00:00:00.000Z'), UserLastModifiedDate: new Date('2026-01-02T00:00:00.000Z') });
  assert.deepEqual(await f.adapter.getAccount('operator'), { id: 'operator', subjectId: 'operator', status: 'active', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' });
  f.state.response.Enabled = false;
  assert.equal((await f.adapter.getAccount('operator')).status, 'suspended');
  assert.equal(f.calls.length, 2);
  for (const command of f.calls) { assert.equal(command.constructor.name, 'AdminGetUserCommand'); assert.deepEqual(command.input, { UserPoolId: 'us-east-2_test', Username: 'operator' }); }
});
for (const [providerStatus, expected] of [['EXTERNAL_PROVIDER','active'],['UNCONFIRMED','pending_verification'],['RESET_REQUIRED','pending_verification'],['FORCE_CHANGE_PASSWORD','pending_verification'],['ARCHIVED','closed'],['COMPROMISED','suspended']]) {
  test(`Cognito ${providerStatus} account resolves to ${expected}`, async () => {
    const f = fixture({ Username: 'operator', Enabled: true, UserStatus: providerStatus });
    assert.equal((await f.adapter.getAccount('operator')).status, expected);
  });
}
test('unknown accounts and invalid identities do not become synthetic active accounts', async () => {
  const f = fixture(); f.state.response = Object.assign(new Error('not found'), { name: 'UserNotFoundException' });
  assert.equal(await f.adapter.getAccount('missing'), undefined);
  for (const value of ['', ' operator', 'a\nb', 'a'.repeat(129)]) assert.equal(await f.adapter.getAccount(value), undefined);
  assert.equal(f.calls.length, 1);
});
test('provider denial and malformed account responses fail closed without exposing provider details', async () => {
  const f = fixture(); f.state.response = Object.assign(new Error('private provider diagnostic'), { name: 'AccessDeniedException' });
  await assert.rejects(f.adapter.getAccount('operator'), error => error.message === 'Cognito account status is unavailable.');
  for (const response of [{}, { Username: 'different', Enabled: true, UserStatus: 'CONFIRMED' }, { Username: 'operator', UserStatus: 'CONFIRMED' }, { Username: 'operator', Enabled: true, UserStatus: 'UNKNOWN' }, { Username: 'operator', Enabled: true, UserStatus: 'CONFIRMED', UserCreateDate: new Date(NaN) }]) {
    f.state.response = response;
    await assert.rejects(f.adapter.getAccount('operator'));
  }
});

const authorizationFixture = () => {
  const calls = [];
  const state = {
    user: { Username: 'operator', Enabled: true, UserStatus: 'CONFIRMED', UserAttributes: [{ Name: 'sub', Value: 'operator' }, { Name: 'email', Value: 'operator@example.test' }, { Name: 'email_verified', Value: 'true' }] },
    pages: [{ Groups: [{ GroupName: 'Creators' }], NextToken: 'page-2' }, { Groups: [{ GroupName: 'SafetyReviewers' }, { GroupName: 'Creators' }] }]
  };
  const adapter = new CognitoIdentity({ send: async command => {
    calls.push(command);
    const name = command.constructor.name;
    if (name === 'AdminGetUserCommand') { if (state.user instanceof Error) throw state.user; return structuredClone(state.user); }
    if (name === 'AdminListGroupsForUserCommand') {
      const page = state.pages[command.input.NextToken ? 1 : 0];
      if (page instanceof Error) throw page;
      return structuredClone(page);
    }
    if (name === 'GetUserCommand') return { Username: 'operator', UserAttributes: state.user.UserAttributes };
    throw new Error(`Unexpected command ${name}`);
  } }, 'us-east-2_test', 'client', { verifier: { verify: async () => ({ sub: 'operator', username: 'operator', iat: 1, exp: 4_000_000_000, 'cognito:groups': ['Admins'] }) } });
  return { adapter, state, calls };
};

test('current Cognito authorization reads every group page and current scope without reusing token groups', async () => {
  const f = authorizationFixture();
  assert.deepEqual((await f.adapter.verifySession({ credential: 'old-token' })).subject.roles, ['Admins']);
  assert.deepEqual(await f.adapter.getAuthorizationSubject('operator'), { id: 'operator', email: 'operator@example.test', emailVerified: true, accountScope: 'creator_operator', roles: ['Creators', 'SafetyReviewers'] });
  const pages = f.calls.filter(command => command.constructor.name === 'AdminListGroupsForUserCommand');
  assert.deepEqual(pages.map(command => command.input), [
    { UserPoolId: 'us-east-2_test', Username: 'operator', Limit: 60 },
    { UserPoolId: 'us-east-2_test', Username: 'operator', Limit: 60, NextToken: 'page-2' }
  ]);
  f.state.user.UserAttributes.push({ Name: 'custom:account_scope', Value: 'customer_account' });
  f.state.pages = [{ Groups: [] }];
  assert.deepEqual(await f.adapter.getAuthorizationSubject('operator'), { id: 'operator', email: 'operator@example.test', emailVerified: true, accountScope: 'customer_account', roles: [] });
  assert.equal(f.calls.filter(command => command.constructor.name === 'AdminGetUserCommand').length, 2);
});

test('disabled, unverified and missing Cognito accounts supply no current authorization', async () => {
  const f = authorizationFixture();
  for (const changes of [{ Enabled: false }, { UserStatus: 'UNCONFIRMED' }, { UserStatus: 'RESET_REQUIRED' }, { UserStatus: 'ARCHIVED' }, { UserStatus: 'COMPROMISED' }]) {
    const baseline = structuredClone(f.state.user);
    Object.assign(f.state.user, changes);
    assert.equal(await f.adapter.getAuthorizationSubject('operator'), undefined);
    f.state.user = baseline;
  }
  f.state.user = Object.assign(new Error('not found'), { name: 'UserNotFoundException' });
  assert.equal(await f.adapter.getAuthorizationSubject('missing'), undefined);
  for (const id of ['', ' operator', 'other\noperator', 'a'.repeat(129)]) assert.equal(await f.adapter.getAuthorizationSubject(id), undefined);
  assert.ok(f.calls.every(command => command.constructor.name === 'AdminGetUserCommand'));
});

test('Cognito current authorization rejects provider outages, malformed scope/identity, and incomplete group pagination', async () => {
  const f = authorizationFixture(), baseline = structuredClone(f.state.user);
  f.state.user = Object.assign(new Error('private provider diagnostic'), { name: 'AccessDeniedException' });
  await assert.rejects(f.adapter.getAuthorizationSubject('operator'), { message: 'Cognito account status is unavailable.' });
  for (const user of [
    { ...baseline, Username:'different' },
    { ...baseline, UserAttributes: undefined },
    { ...baseline, UserAttributes: [...baseline.UserAttributes, { Name: 'custom:account_scope', Value: 'unknown_scope' }] },
    { ...baseline, UserAttributes: [...baseline.UserAttributes, { Name: 'custom:account_scope', Value: 'creator_operator' }, { Name: 'custom:account_scope', Value: 'customer_account' }] }
  ]) {
    f.state.user = user;
    await assert.rejects(f.adapter.getAuthorizationSubject('operator'), /evidence is unavailable/);
  }
  f.state.user = baseline;
  for (const pages of [
    [new Error('private group provider diagnostic')],
    [{ Groups: [{ GroupName: 'Admins' }], NextToken: 'page-2' }, new Error('later page unavailable')],
    [{ Groups: [{ GroupName: 'Admins' }], NextToken: 'page-2' }, { Groups: [], NextToken: 'page-2' }],
    [{ Groups: [{ GroupName: undefined }] }],
    [{ Groups: 'Admins' }]
  ]) {
    f.state.pages = pages;
    await assert.rejects(f.adapter.getAuthorizationSubject('operator'), { message: 'Cognito authorization evidence is unavailable.' });
  }
});
