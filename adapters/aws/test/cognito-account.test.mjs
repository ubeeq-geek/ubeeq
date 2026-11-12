import test from 'node:test';
import assert from 'node:assert/strict';
import { CognitoIdentity } from '../dist/index.js';
const fixture = (response = { Username: 'operator', Enabled: true, UserStatus: 'CONFIRMED' }) => {
  const calls = [];
  const state = { response };
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
