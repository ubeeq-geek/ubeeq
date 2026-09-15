import test from 'node:test';
import assert from 'node:assert/strict';
import { ActivityWorkflows, ActivityCommandInterface, inDigestQuietHours, integrationHealthActivity, formatActivityEvent, handleActivityWorkflowMessage } from '../dist/index.js';
const p = { actorId: 'owner', profileId: 'whatsapp:account:sender' };
const event = (id, extra = {}) => ({ id, creatorId: 'a', platform: 'native', sourceAt: '2026-09-15T12:00:00Z', kind: 'comment', commentId: id, ...extra });
function fixture() {
  const documents = new Map(), events = [], posted = [], delivered = [];
  let now = Date.parse('2026-09-15T12:00:00Z'), authorized = true, visible = true, replyOutcome = 'sent', notifyAllowed = true;
  const store = {
    get: async k => structuredClone(documents.get(k) ?? null),
    commit: async writes => {
      if (writes.some(w => (documents.get(w.key)?.revision ?? null) !== w.revision)) return false;
      for (const w of writes) documents.set(w.key, { revision: (w.revision ?? -1) + 1, value: structuredClone(w.value) });
      return true;
    },
    scan: async (prefix, after, limit) => [...documents].filter(([k]) => k.startsWith(prefix) && k > after).sort(([a], [b]) => a.localeCompare(b)).slice(0, limit).map(([key, document]) => ({ key, document: structuredClone(document) })),
    append: async e => { if (!events.some(old => old.id === e.id && old.creatorId === e.creatorId && old.platform === e.platform)) events.push({ ...e, sequence: events.length + 1 }); },
    page: async (s, after, limit, kind) => events.filter(e => e.sequence > after && s.creators.includes(e.creatorId) && s.platforms.includes(e.platform) && (!kind || e.kind === kind)).slice(0, limit)
  };
  const ports = {
    choices: async () => ({ creators: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], platforms: ['native', 'remote'] }),
    authorize: async actor => actor === 'owner' && authorized,
    visible: async () => visible,
    comment: async (_actor, e) => visible ? ({ id: e.commentId, creatorId: e.creatorId, platform: e.platform, body: 'A comment', workTitle: 'Work', answered: posted.some(x => x.event.commentId === e.commentId), replyAllowed: true, thread: posted.filter(x => x.event.commentId === e.commentId).map(x => ({ author: 'owner', body: x.body })) }) : null,
    reply: async input => { posted.push(input); if (replyOutcome === 'throw') throw new Error('secret'); return replyOutcome; },
    canNotify: async () => notifyAllowed,
    notify: async input => { delivered.push(input); return 'sent'; }
  };
  const service = new ActivityWorkflows(store, ports, () => now), commands = new ActivityCommandInterface(service, () => now);
  return { service, commands, store, documents, posted, delivered, ports, advance: ms => { now += ms; }, revoke: () => { authorized = false; }, hide: () => { visible = false; }, outcome: v => { replyOutcome = v; }, notifyAllowed: v => { notifyAllowed = v; } };
}
test('checkpoint acknowledgement never skips a later ingested event or another selection', async () => {
  const f = fixture(); await f.store.append(event('one'));
  const page = await f.service.activity(p); await f.store.append(event('late', { sourceAt: '2026-09-01T00:00:00Z' }));
  await f.service.acknowledge(p, page.acknowledge);
  assert.deepEqual((await f.service.activity(p)).items.map(e => e.id), ['late']);
  await f.service.select(p, { creators: ['b'], platforms: [] });
  await assert.rejects(f.service.acknowledge(p, page.acknowledge), { code: 'invalid' });
  await f.store.append(event('b', { creatorId: 'b' })); assert.equal((await f.service.activity(p)).items[0].creatorId, 'b');
});
test('pagination checkpoints advance only through the returned page', async () => {
  const f = fixture(); for (let i = 0; i < 25; i++) await f.store.append(event(String(i)));
  const page = await f.service.activity(p); assert.equal(page.items.length, 20); assert.equal(page.more, true);
  await f.service.acknowledge(p, page.acknowledge); assert.equal((await f.service.activity(p)).items.length, 5);
});
test('choices and filters deny unauthorized sources and revoke reads', async () => {
  const f = fixture(); await f.store.append(event('a')); await f.store.append(event('b', { creatorId: 'b', platform: 'remote' }));
  await f.service.select(p, { creators: ['b'], platforms: ['remote'] }); assert.equal((await f.service.activity(p)).items.length, 1);
  await assert.rejects(f.service.select(p, { creators: ['foreign'], platforms: [] }), { code: 'denied' });
  f.revoke(); await assert.rejects(f.service.activity(p), { code: 'denied' });
});
test('read and resolution are separate; threads use current provider state', async () => {
  const f = fixture(); const e = event('comment'); await f.store.append(e);
  assert.equal((await f.service.inbox(p, 'unread')).items.length, 1);
  await f.service.openComment(p, e); assert.equal((await f.service.inbox(p, 'unread')).items.length, 0);
  assert.equal((await f.service.inbox(p, 'unanswered')).items.length, 1);
  await f.service.mark(p, e, 'resolve'); assert.equal((await f.service.inbox(p, 'unanswered')).items.length, 0);
  await f.service.mark(p, e, 'reopen'); assert.equal((await f.service.inbox(p, 'unanswered')).items.length, 1);
  f.hide(); assert.equal((await f.service.inbox(p)).items.length, 0);
});
test('reply preview, explicit confirmation, concurrent duplicate protection and answered thread', async () => {
  const f = fixture(); const e = event('c'); await f.store.append(e);
  const preview = await f.service.previewReply(p, e, 'Thank you!'); assert.equal(f.posted.length, 0);
  await Promise.all([f.service.confirmReply(p, preview.token), f.service.confirmReply(p, preview.token)]);
  assert.equal(f.posted.length, 1); assert.equal(f.posted[0].body, 'Thank you!');
  assert.equal(await f.service.confirmReply(p, preview.token), 'sent');
  assert.equal((await f.service.openComment(p, e)).thread[0].body, 'Thank you!');
  assert.equal((await f.service.inbox(p, 'unanswered')).items.length, 0);
});
test('reply failures are uncertain and never automatically reposted; tokens are profile scoped', async () => {
  const f = fixture(); const preview = await f.service.previewReply(p, event('c'), 'Hi');
  await assert.rejects(f.service.confirmReply({ ...p, profileId: 'other' }, preview.token));
  f.outcome('throw'); assert.equal(await f.service.confirmReply(p, preview.token), 'unknown');
  assert.equal(await f.service.confirmReply(p, preview.token), 'unknown'); assert.equal(f.posted.length, 1);
});
test('reply authorization is rechecked after preview and previews expire', async () => {
  const f = fixture(); const preview = await f.service.previewReply(p, event('c'), 'Hi'); f.revoke();
  await assert.rejects(f.service.confirmReply(p, preview.token), { code: 'denied' }); assert.equal(f.posted.length, 0);
  const g = fixture(); const old = await g.service.previewReply(p, event('c'), 'Hi'); g.advance(900001);
  await assert.rejects(g.service.confirmReply(p, old.token), { code: 'invalid' });
});
const prefs = { frequency: 'hourly', timeZone: 'UTC', quietStart: 22, quietEnd: 8, minEvents: 2, healthAlerts: true };
test('digest frequency, thresholds, durable outbox and concurrent delivery', async () => {
  const f = fixture(); await f.service.preferences(p, prefs); await f.store.append(event('a'));
  assert.equal(await f.service.prepareNotification(p, 'digest'), null); f.advance(3600000);
  assert.equal(await f.service.prepareNotification(p, 'digest'), null); await f.store.append(event('b'));
  const token = await f.service.prepareNotification(p, 'digest'); assert.ok(token);
  await Promise.all([f.service.deliverNotification(p, token), f.service.deliverNotification(p, token)]);
  assert.equal(f.delivered.length, 1); assert.match(f.delivered[0].text, /Activity digest/);
  assert.equal(await f.service.prepareNotification(p, 'digest'), null);
});
test('health transitions are alerts independent of digest threshold, with delivery policy and revocation', async () => {
  const f = fixture(); await f.service.preferences(p, prefs);
  const observed = integrationHealthActivity({ creatorId: 'a', platform: 'native', accountId: 'account', observationId: 'v1', account: { connectionStatus: 'connected', tokenExpiresAt: '2026-09-14T00:00:00Z' }, nowMs: Date.parse('2026-09-15T12:00:00Z'), expiryWarningMs: 1000, syncStaleMs: 3600000 });
  assert.equal(observed.events[0].health, 'authorization_expired');
  for (const event of observed.events) await f.store.append(event);
  const token = await f.service.prepareNotification(p, 'health'); assert.ok(token);
  f.notifyAllowed(false); assert.equal(await f.service.deliverNotification(p, token), 'deferred'); assert.equal(f.delivered.length, 0);
  f.notifyAllowed(true); f.revoke(); await assert.rejects(f.service.deliverNotification(p, token), { code: 'denied' });
});
test('quiet hours cross midnight and respect IANA timezone; malformed preferences fail', async () => {
  assert.equal(inDigestQuietHours(prefs, Date.parse('2026-09-15T23:00:00Z')), true);
  assert.equal(inDigestQuietHours(prefs, Date.parse('2026-09-15T07:59:00Z')), true);
  assert.equal(inDigestQuietHours(prefs, Date.parse('2026-09-15T08:00:00Z')), false);
  assert.equal(inDigestQuietHours({ ...prefs, timeZone: 'America/Winnipeg' }, Date.parse('2026-09-15T04:00:00Z')), true);
  const f = fixture(); await assert.rejects(f.service.preferences(p, { ...prefs, timeZone: 'fake' }));
  await assert.rejects(f.service.preferences(p, { ...prefs, minEvents: 0 }));
});
test('unknown counts and negative aggregate changes remain explicit', () => {
  assert.match(formatActivityEvent(event('x', { kind: 'favorite_count', count: null })), /unavailable/);
  assert.match(formatActivityEvent(event('x', { kind: 'favorite_count', count: 7, previousCount: 10 })), /change -3/);
  assert.match(formatActivityEvent(event('x', { kind: 'favorite_count', count: 7 })), /baseline unavailable/);
});
test('direct commands complete inbox, preview, confirmation and settings without AI', async () => {
  const f = fixture(); await f.store.append(event('c'));
  assert.match(await f.commands.execute(p, 'creators'), /a: A/);
  assert.equal(await f.commands.execute(p, 'select creators a'), 'Selection saved.');
  const inbox = await f.commands.execute(p, 'inbox unanswered'); const ref = inbox.split(' ')[0];
  assert.match(await f.commands.execute(p, `thread ${ref}`), /A comment/);
  const preview = await f.commands.execute(p, `reply ${ref} Thank you!`); const token = preview.match(/confirm (\S+)/)[1];
  assert.match(await f.commands.execute(p, `confirm ${token}`), /sent/);
  for (const command of ['digest daily', 'zone America/Winnipeg', 'quiet 23-7', 'minimum 3', 'alerts on']) assert.equal(await f.commands.execute(p, command), 'Notification preferences saved.');
  assert.equal((await f.service.preferences(p)).minEvents, 3);
  assert.match(await f.commands.execute(p, 'invent a reply'), /Commands:/);
});
test('WhatsApp wrapper resolves the full account identity, never treats a phone number as authorization', async () => {
  const f = fixture(); const message = { channel: 'whatsapp', accountId: 'business', senderId: 'phone', messageId: 'id', text: 'creators' };
  assert.match(await handleActivityWorkflowMessage(message, f.commands, async identity => { assert.deepEqual(identity, { channel: 'whatsapp', accountId: 'business', senderId: 'phone' }); return null; }), /Link/);
});
test('queued notifications are discoverable after restart and uncertain sends cannot be retried', async () => {
  const f = fixture(); await f.service.preferences(p, { ...prefs, minEvents: 1 }); await f.store.append(event('c')); f.advance(3600000);
  const token = await f.service.prepareNotification(p, 'digest');
  const restarted = new ActivityWorkflows(f.store, f.ports, () => Date.parse('2026-09-15T13:00:00Z'));
  assert.deepEqual((await restarted.notifications(p)).items, [{ token, status: 'pending' }]);
  f.ports.notify = async () => { throw new Error('timeout'); };
  assert.equal(await restarted.deliverNotification(p, token), 'unknown');
  assert.equal(await restarted.retryNotification(p, token), false);
});
test('hidden events do not lower digest thresholds or leak notification text', async () => {
  const f = fixture(); await f.service.preferences(p, { ...prefs, minEvents: 2 });
  for (let i = 0; i < 25; i++) await f.store.append(event(`hidden${i}`));
  await f.store.append(event('visible')); f.ports.visible = async (_actor, event) => !event.id.startsWith('hidden');
  f.advance(3600000); assert.equal(await f.service.prepareNotification(p, 'digest'), null);
  await f.store.append(event('visible2')); const token = await f.service.prepareNotification(p, 'digest');
  await f.service.deliverNotification(p, token); assert.doesNotMatch(f.delivered[0].text, /hidden/);
});
