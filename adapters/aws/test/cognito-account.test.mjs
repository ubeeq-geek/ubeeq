import test from 'node:test';
import assert from 'node:assert/strict';
import { AdminGetUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import { CognitoIdentity } from '../dist/index.js';

const confirmed = () => ({ Username: 'subject', Enabled: true, UserStatus: 'CONFIRMED',
  UserCreateDate: new Date('2026-01-01T01:02:03Z'), UserLastModifiedDate: new Date('2026-01-02T04:05:06Z') });

test('Cognito account state is read from the configured pool on each check, without retaining private attributes', async () => {
  const calls = []; let account = confirmed();
  const identity = new CognitoIdentity({ send: async command => {
    assert.ok(command instanceof AdminGetUserCommand); calls.push(command.input);
    return { ...account, UserAttributes: [{ Name: 'email', Value: 'private@example.test' }], PreferredMfaSetting: 'private-mfa' };
  } }, 'configured-pool', 'client');
  assert.deepEqual(await identity.getAccount('subject'), { id: 'subject', subjectId: 'subject', status: 'active',
    createdAt: '2026-01-01T01:02:03.000Z', updatedAt: '2026-01-02T04:05:06.000Z' });
  account = { ...account, Enabled: false };
  assert.equal((await identity.getAccount('subject')).status, 'suspended');
  account = { ...account, Enabled: true };
  assert.equal((await identity.getAccount('subject')).status, 'active');
  assert.deepEqual(calls, Array(3).fill({ UserPoolId: 'configured-pool', Username: 'subject' }));
});

test('only enabled confirmed/provider accounts are active; all unknown or sign-in-blocked states fail closed', async () => {
  for (const [UserStatus, status] of [['CONFIRMED', 'active'], ['EXTERNAL_PROVIDER', 'active'], ['UNCONFIRMED', 'pending_verification'],
    ['RESET_REQUIRED', 'suspended'], ['FORCE_CHANGE_PASSWORD', 'suspended'], ['ARCHIVED', 'suspended'], ['COMPROMISED', 'suspended'],
    ['UNKNOWN', 'suspended'], ['future-state', 'suspended']]) {
    for (const Enabled of [true, false]) {
      const identity = new CognitoIdentity({ send: async () => ({ ...confirmed(), UserStatus, Enabled }) }, 'pool', 'client');
      assert.equal((await identity.getAccount('subject')).status, Enabled ? status : 'suspended', `${UserStatus}/${Enabled}`);
    }
  }
});

test('missing users are absent but account lookup service/permission failures propagate without fabricated state', async () => {
  for (const name of ['UserNotFoundException', 'ResourceNotFoundException', 'NotAuthorizedException', 'TooManyRequestsException', 'InternalErrorException', 'TimeoutError']) {
    const error = Object.assign(new Error('provider failure'), { name });
    let calls = 0;
    const identity = new CognitoIdentity({ send: async () => { calls++; throw error; } }, 'pool', 'client');
    if (name === 'UserNotFoundException') assert.equal(await identity.getAccount('subject'), undefined);
    else await assert.rejects(identity.getAccount('subject'), failure => failure === error);
    assert.equal(calls, 1);
  }
});

test('mismatched subjects, absent state metadata and invalid dates never become active accounts', async () => {
  for (const changes of [{ Username: 'different' }, { Username: undefined }, { Enabled: undefined }, { Enabled: 'true' },
    { UserStatus: undefined }, { UserCreateDate: undefined }, { UserCreateDate: new Date(NaN) },
    { UserLastModifiedDate: '2026-01-02' }, { UserLastModifiedDate: new Date(NaN) }]) {
    const identity = new CognitoIdentity({ send: async () => ({ ...confirmed(), ...changes }) }, 'pool', 'client');
    await assert.rejects(identity.getAccount('subject'), /invalid account identity or state metadata/);
  }
  let calls = 0;
  const identity = new CognitoIdentity({ send: async () => { calls++; return confirmed(); } }, 'pool', 'client');
  for (const value of ['', '   ', undefined, null]) await assert.rejects(identity.getAccount(value), /canonical Cognito subject/);
  assert.equal(calls, 0);
});
