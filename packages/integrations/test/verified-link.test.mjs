import test from 'node:test';
import assert from 'node:assert/strict';
import { issueDirectMessagingLinkChallenge, handleVerifiedDirectMessagingLinkCommand, canCommitVerifiedDirectMessagingLink } from '../dist/index.js';

const scope = { instanceId: 'instance', receivingAccountId: '123', actorId: 'actor', creatorId: 'creator', cellId: 'cell' };
async function fixture() {
  let record, link;
  const store = {
    save: async value => { record = value; },
    findChallenge: async id => record?.challengeId === id ? { ...record } : null,
    commitVerifiedLink: async (expected, candidate, now) => {
      if (!canCommitVerifiedDirectMessagingLink(record, expected, candidate, now)) return false;
      record = { ...record, usedAt: now }; link = candidate; return true;
    }
  };
  const issued = await issueDirectMessagingLinkChallenge(store, scope);
  const message = { channel: 'whatsapp', accountId: '123', senderId: '15550001111', messageId: 'message', text: `/link ${issued.challengeId} ${issued.token}` };
  return { store, issued, message, link: () => link, record: () => record };
}

test('wrong token, account, instance, expired and revoked access cannot consume or link', async () => {
  const f = await fixture();
  for (const [message, instance, authorize, now] of [
    [{ ...f.message, text: `/link ${f.issued.challengeId} ${'x'.repeat(43)}` }, 'instance', async () => true],
    [{ ...f.message, accountId: '999' }, 'instance', async () => true],
    [f.message, 'foreign', async () => true],
    [f.message, 'instance', async () => false],
    [f.message, 'instance', async () => true, f.issued.expiresAt]
  ]) {
    assert.match(await handleVerifiedDirectMessagingLinkCommand(message, instance, f.store, authorize, now), /not completed/);
    assert.equal(f.record().usedAt, undefined);
    assert.equal(f.link(), undefined);
  }
});

test('one verified sender wins concurrent redemption; the link contains no token or digest', async () => {
  const f = await fixture();
  const replies = await Promise.all(['15550001111', '15550002222'].map(senderId => handleVerifiedDirectMessagingLinkCommand(
    { ...f.message, senderId }, 'instance', f.store, async scope => scope.actorId === 'actor')));
  assert.equal(replies.filter(value => value.startsWith('Creator linked.')).length, 1);
  assert.ok(f.link().verifiedAt);
  assert.equal(f.link().digest, undefined);
  assert.equal(f.link().token, undefined);
  assert.match(await handleVerifiedDirectMessagingLinkCommand(f.message, 'instance', f.store, async () => true), /not completed/);
});

test('atomic adapter predicate rejects altered challenge scope and invalid timestamps', async () => {
  const f = await fixture();
  const now = new Date().toISOString();
  const link = { ...scope, senderId: '15550001111', createdAt: now, verifiedAt: now };
  assert.equal(canCommitVerifiedDirectMessagingLink(f.record(), f.record(), link, now), true);
  for (const patch of [{ usedAt: now }, { creatorId: 'other' }, { digest: '00' }, { expiresAt: 'invalid' }]) {
    assert.equal(canCommitVerifiedDirectMessagingLink({ ...f.record(), ...patch }, f.record(), link, now), false);
  }
});
