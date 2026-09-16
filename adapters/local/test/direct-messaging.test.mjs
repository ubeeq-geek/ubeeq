import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { SqliteDirectMessagingStore } from '../dist/index.js';
import { issueDirectMessagingLinkChallenge, handleVerifiedDirectMessagingLinkCommand } from '@ubeeq/integrations';

test('shared SQLite messaging preserves transactional linking and isolates instances', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const store = new SqliteDirectMessagingStore(db, 'product', 'cell');
    const foreign = new SqliteDirectMessagingStore(db, 'other', 'other-cell');
    const scope = { instanceId: 'product', cellId: 'cell', receivingAccountId: '123', actorId: 'actor', creatorId: 'creator' };
    const challenge = await issueDirectMessagingLinkChallenge(store, scope);
    assert.equal(await foreign.findChallenge(challenge.challengeId), null);
    assert.equal(await foreign.consume(challenge.challengeId, new Date().toISOString()), null);
    const message = { channel: 'whatsapp', accountId: '123', senderId: '15550001111', messageId: 'link', text: `/link ${challenge.challengeId} ${challenge.token}` };
    assert.match(await handleVerifiedDirectMessagingLinkCommand(message, 'product', store, async () => true), /Creator linked/);
    const identity = { instanceId: 'product', receivingAccountId: '123', senderId: message.senderId };
    assert.ok((await store.resolve(identity)).verifiedAt);
    assert.equal(await foreign.resolve(identity), null);
    assert.deepEqual(await foreign.listVerified(scope), []);
    assert.equal(await foreign.revoke({ ...identity, actorId: 'actor' }), false);
    assert.equal(await store.revoke({ ...identity, actorId: 'actor' }), true);
  } finally { db.close(); }
});

test('reply insertion and inbox completion roll back together and stale claims cannot win', async t => {
  const db = new DatabaseSync(':memory:');
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  try {
    const store = new SqliteDirectMessagingStore(db, 'product', 'cell');
    const key = { instanceId: 'product', receivingAccountId: '123', providerMessageId: 'message' };
    const input = { ...key, senderId: '15550001111', state: 'admitted', receivedAt: new Date(now).toISOString() };
    const old = (await store.admitInbox(input)).record;
    assert.equal((await store.admitInbox(input)).admitted, false);
    now += 120_001;
    const current = (await store.admitInbox(input)).record;
    const reply = { outboxId: 'reply', inboxKey: key, to: input.senderId, body: 'Activity', state: 'pending', attemptCount: 0 };
    await assert.rejects(store.commitInboxReply(old, reply), /no longer valid/);
    db.exec("CREATE TRIGGER reject_completion BEFORE UPDATE ON direct_messaging_inbox BEGIN SELECT RAISE(ABORT, 'write failure'); END");
    await assert.rejects(store.commitInboxReply(current, reply), /write failure/);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM direct_messaging_outbox').get().n, 0);
    db.exec('DROP TRIGGER reject_completion');
    await store.commitInboxReply(current, reply);
    assert.equal((await store.admitInbox(input)).record.state, 'completed');
    assert.equal((await store.claimOutbox(new Date(now).toISOString())).outboxId, 'reply');
    assert.equal(await store.claimOutbox(new Date(now).toISOString()), null);
  } finally { db.close(); }
});
