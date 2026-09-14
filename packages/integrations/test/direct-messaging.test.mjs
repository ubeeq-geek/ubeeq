import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { parseActivityCommand, handleDirectMessage, decodeWhatsAppWebhook, verifyWhatsAppChallenge, whatsAppTextReply } from '../dist/index.js';
const message = { channel: 'whatsapp', accountId: '123', senderId: '15551234567', messageId: 'wamid.1', text: 'activity' };
const scope = { instanceId: 'instance', cellId: 'cell', actorId: 'actor', creatorId: 'creator' };
const snapshot = { asOf: '2026-09-14T12:00:00Z', comments: [{ source: 'native', workTitle: 'Example', body: 'Nice work!' }], favoriteCount: 12 };
test('explicit commands and unknown text require no inference', () => {
  assert.equal(parseActivityCommand(' /Favourites '), 'favorites');
  assert.equal(parseActivityCommand('please delete everything'), 'help');
});
test('unlinked and revoked senders cannot read activity', async () => {
  for (const linked of [false, true]) {
    let reads = 0;
    const result = await handleDirectMessage(message, { resolveLink: async () => linked ? scope : null, authorize: async () => false, readActivity: async () => { reads++; return snapshot; } });
    assert.match(result, /Link an authorized/);
    assert.equal(reads, 0);
  }
});
test('account-scoped links, bounded queries, freshness and aggregate counts', async () => {
  const result = await handleDirectMessage(message, {
    resolveLink: async identity => { assert.deepEqual(identity, { channel: 'whatsapp', accountId: '123', senderId: '15551234567' }); return scope; },
    authorize: async supplied => { assert.equal(supplied, scope); return true; },
    readActivity: async (supplied, query) => { assert.equal(supplied, scope); assert.deepEqual(query, { command: 'activity', limit: 5 }); return snapshot; }
  });
  assert.match(result, /2026-09-14T12:00:00.000Z/);
  assert.match(result, /Favourites \(aggregate\): 12/);
  assert.match(result, /Nice work!/);
});
test('unavailable counts are not zero and output remains bounded', async () => {
  const ports = { resolveLink: async () => scope, authorize: async () => true, readActivity: async () => ({ ...snapshot, favoriteCount: null, comments: Array(100).fill({ source: 'x'.repeat(200), workTitle: 'y'.repeat(200), body: 'z'.repeat(5000) }) }) };
  const result = await handleDirectMessage(message, ports);
  assert.match(result, /count unavailable/);
  assert.ok(result.length < 4096);
  assert.doesNotMatch(await handleDirectMessage({ ...message, text: 'favourites' }, ports), /Recent comments/);
});
function webhook(messages, phone = '123') {
  const rawBody = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: phone }, messages } }] }] }));
  return { rawBody, signature: 'sha256=' + createHmac('sha256', 'secret').update(rawBody).digest('hex'), appSecret: 'secret', phoneNumberId: '123' };
}
const inbound = { id: 'wamid.1', from: message.senderId, type: 'text', text: { body: 'activity' } };
test('signed webhook decodes text and menu commands, ignores duplicate and foreign events', () => {
  assert.deepEqual(decodeWhatsAppWebhook(webhook([inbound, inbound])), [message]);
  assert.deepEqual(decodeWhatsAppWebhook(webhook([inbound], '999')), []);
  assert.deepEqual(decodeWhatsAppWebhook(webhook([{ ...inbound, type: 'image' }])), []);
  const interactive = { ...inbound, type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'comments', title: 'Comments' } } };
  assert.equal(decodeWhatsAppWebhook(webhook([interactive]))[0].text, 'comments');
});
test('tampered, unsigned, oversized and malformed payloads fail closed', () => {
  const valid = webhook([inbound]);
  for (const patch of [{ signature: undefined }, { appSecret: '' }, { rawBody: Buffer.from('{}') }, { rawBody: Buffer.alloc(262145) }]) {
    assert.throws(() => decodeWhatsAppWebhook({ ...valid, ...patch }), /signature/);
  }
});
test('challenge requires the configured token; outbound text is bounded', () => {
  const query = new URLSearchParams({ 'hub.mode': 'subscribe', 'hub.verify_token': 'token', 'hub.challenge': '1234' });
  assert.equal(verifyWhatsAppChallenge(query, 'token'), '1234');
  assert.equal(verifyWhatsAppChallenge(query, 'wrong'), null);
  assert.equal(verifyWhatsAppChallenge(query, ''), null);
  assert.equal(whatsAppTextReply(message.senderId, 'Hello').text.preview_url, false);
  assert.throws(() => whatsAppTextReply(message.senderId, 'x'.repeat(4097)));
});
