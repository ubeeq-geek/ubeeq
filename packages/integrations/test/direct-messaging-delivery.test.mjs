import test from 'node:test';
import assert from 'node:assert/strict';
import { createDirectMessagingDeliveryWorker, prepareDirectMessagingReply, sendWhatsAppText, drainDirectMessagingOutbox, DirectMessagingDeliveryError } from '../dist/index.js';

const now = '2026-09-16T00:00:00.000Z';
const scope = { instanceId: 'instance', cellId: 'cell', actorId: 'actor', creatorId: 'creator' };
const sender = { accessToken: 'secret', phoneNumberId: '123', graphApiVersion: 'v99.0' };
const base = { outboxId: 'outbox', inboxKey: { instanceId: 'instance', receivingAccountId: '123', providerMessageId: 'message' },
  to: '15550001111', body: 'private activity', state: 'pending', attemptCount: 0,
  deliveryContext: { scope, expiresAt: '2026-09-16T00:15:00.000Z' } };
function fixture(patch = {}) {
  let record = { ...base, ...patch };
  return { record: () => record, store: {
    claimOutbox: async time => {
      if (!(record.state === 'pending' || (record.state === 'retry' && record.nextAttemptAt <= time))) return null;
      record = { ...record, state: 'sending', attemptCount: record.attemptCount + 1 }; return { ...record };
    },
    completeOutbox: async (_id, result) => { record = { ...record, ...result }; }
  } };
}
const ports = { resolveLink: async () => scope, authorize: async () => true, readActivity: async () => ({ asOf: now, comments: [], favoriteCount: 0 }) };

test('fresh verified creator reply sends once and marks sent', async () => {
  const f = fixture(); let sends = 0;
  const worker = createDirectMessagingDeliveryWorker({ instanceId: 'instance', store: f.store, ports, clock: () => now,
    sender: { ...sender, fetchImpl: async (_url, options) => {
      sends++; assert.equal(JSON.parse(options.body).to, base.to);
      return Response.json({ messages: [{ id: 'provider-id' }] });
    } } });
  await Promise.all([worker.tick(), worker.tick()]);
  assert.equal(f.record().state, 'sent'); assert.equal(sends, 1);
  await worker.tick(); assert.equal(sends, 1);
});

test('missing context, stale reply, foreign account, revoked access and relinking prevent provider calls', async () => {
  for (const [patch, override] of [
    [{ deliveryContext: undefined }, {}], [{ deliveryContext: { scope, expiresAt: now } }, {}],
    [{ inboxKey: { ...base.inboxKey, receivingAccountId: '999' } }, {}],
    [{}, { authorize: async () => false }], [{}, { resolveLink: async () => ({ ...scope, creatorId: 'other' }) }],
    [{}, { resolveLink: async () => null }]
  ]) {
    const f = fixture(patch); let sends = 0;
    await createDirectMessagingDeliveryWorker({ instanceId: 'instance', store: f.store, ports: { ...ports, ...override }, clock: () => now,
      sender: { ...sender, fetchImpl: async () => { sends++; throw Error('must not send'); } } }).tick();
    assert.equal(sends, 0); assert.equal(f.record().state, 'failed');
  }
});

test('429 has scheduled bounded retries; rejection and ambiguous failures never retry automatically', async () => {
  for (const [status, state] of [[429, 'retry'], [400, 'failed'], [401, 'failed'], [500, 'uncertain']]) {
    const f = fixture();
    await drainDirectMessagingOutbox(f.store, now, () => sendWhatsAppText({ ...sender, recipient: base.to, body: base.body,
      fetchImpl: async () => new Response('provider diagnostic with secrets', { status, headers: { 'retry-after': '90' } }) }), async () => true);
    assert.equal(f.record().state, state);
    if (state === 'retry') assert.equal(f.record().nextAttemptAt, '2026-09-16T00:01:30.000Z');
  }
  const exhausted = fixture({ attemptCount: 4 });
  await drainDirectMessagingOutbox(exhausted.store, now, async () => { throw new DirectMessagingDeliveryError('retry'); }, async () => true);
  assert.equal(exhausted.record().state, 'failed');
  for (const fetchImpl of [async () => { throw new TypeError('network failed'); }, async () => Response.json({})]) {
    await assert.rejects(sendWhatsAppText({ ...sender, recipient: base.to, body: base.body, fetchImpl }), error => error.outcome === 'uncertain' && !error.message.includes('network'));
  }
});

test('persisting a successful send failure does not schedule a duplicate', async () => {
  const f = fixture(); let completions = 0;
  f.store.completeOutbox = async () => { completions++; throw Error('disk failure'); };
  await assert.rejects(drainDirectMessagingOutbox(f.store, now, async () => ({ providerMessageId: 'sent' }), async () => true), /disk failure/);
  assert.equal(completions, 1); assert.equal(f.record().state, 'sending');
});

test('preparing replies uses provider event age and binds the authorized creator scope', async () => {
  const message = { channel: 'whatsapp', senderId: base.to, accountId: '123', messageId: 'message', text: 'activity', sentAt: now };
  const reply = await prepareDirectMessagingReply(message, 'instance', ports, undefined, now);
  assert.deepEqual(reply.deliveryContext, base.deliveryContext);
  const missing = await prepareDirectMessagingReply({ ...message, sentAt: undefined }, 'instance', ports, undefined, now);
  assert.equal(missing.deliveryContext.expiresAt, now);
  const stale = await prepareDirectMessagingReply({ ...message, sentAt: '2026-09-15T00:00:00.000Z' }, 'instance', ports, undefined, now);
  assert.ok(stale.deliveryContext.expiresAt < now);
  const publicReply = await prepareDirectMessagingReply(message, 'instance', { ...ports, resolveLink: async () => null }, undefined, now);
  assert.equal(publicReply.deliveryContext.publicReply, true); assert.equal(publicReply.deliveryContext.scope, undefined);
  assert.match(publicReply.body, /Link an authorized/);
});

test('sender rejects invalid configuration before network and cancels oversized responses', async () => {
  let calls = 0;
  await assert.rejects(sendWhatsAppText({ ...sender, recipient: base.to, body: base.body, graphApiVersion: '../other',
    fetchImpl: async () => { calls++; throw Error('not expected'); } }), error => error.outcome === 'failed');
  assert.equal(calls, 0);
  let cancelled = false;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(70_000)); }, cancel() { cancelled = true; } });
  await assert.rejects(sendWhatsAppText({ ...sender, recipient: base.to, body: base.body, fetchImpl: async () => new Response(stream) }), error => error.outcome === 'uncertain');
  assert.equal(cancelled, true);
});

test('a transport deadline leaves delivery uncertain', async () => {
  await assert.rejects(sendWhatsAppText({ ...sender, recipient: base.to, body: base.body, timeoutMs: 1000,
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }) }), error => error.outcome === 'uncertain');
});
