import assert from 'node:assert/strict';
import test from 'node:test';
import { PayPalClient, PayPalConnections, PAYPAL_EVENT_TYPES } from '../dist/index.js';

const actor = { deploymentId: 'deployment', ownerId: 'creator', actorId: 'admin' };
const input = { environment: 'sandbox', clientId: 'client-app', clientSecret: 'PRIVATE-secret' };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const headers = () => new Headers({ 'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-123',
  'paypal-auth-algo': 'SHA256withRSA', 'paypal-transmission-id': 'transmission', 'paypal-transmission-sig': 'signature',
  'paypal-transmission-time': '2026-11-01T12:00:00Z' });
const body = (id = 'EVENT-1', event_type = 'PAYMENT.CAPTURE.COMPLETED') => Buffer.from(JSON.stringify({ id, event_type, resource: { id: 'CAPTURE-1' } }));

function fixture() {
  const state = { records: new Map(), vault: new Map(), hooks: [], audits: [], inbox: new Map(), jobs: [], calls: [],
    sequences: 0, creates: 0, deletes: 0, pendingOrders: 0, signature: 'SUCCESS', storageDown: false, deny: false, enabled: true,
    dropCreateResponse: false, deleteFailure: false, revokeFailure: false, tokenFailure: false, locks: new Map() };
  const scopeKey = s => JSON.stringify([s.deploymentId, s.ownerId, s.environment]);
  const fetch = async (url, init) => {
    const path = new URL(url).pathname;
    state.calls.push({ url, method: init.method, body: init.body });
    assert.equal(init.redirect, 'error');
    if (path.endsWith('/oauth2/token')) return state.tokenFailure ? json({ secret: 'DO NOT LEAK' }, 401)
      : json({ access_token: 'PRIVATE-token', token_type: 'Bearer', expires_in: 300 });
    assert.equal(init.headers.authorization, 'Bearer PRIVATE-token');
    if (path.endsWith('/verify-webhook-signature')) return json({ verification_status: state.signature });
    if (path === '/v1/notifications/webhooks' && init.method === 'GET') return json({ webhooks: state.hooks });
    if (path === '/v1/notifications/webhooks' && init.method === 'POST') {
      state.creates++;
      const data = JSON.parse(init.body), hook = { ...data, id: 'HOOK-' + state.creates };
      state.hooks.push(hook);
      if (state.dropCreateResponse) { state.dropCreateResponse = false; throw Error('PRIVATE transport details'); }
      return json(hook, 201);
    }
    const id = path.split('/').at(-1), hook = state.hooks.find(h => h.id === id);
    if (init.method === 'PATCH' && hook) { hook.event_types = JSON.parse(init.body)[0].value; return json(hook); }
    if (init.method === 'DELETE') {
      if (state.deleteFailure) return json({ secret: 'PRIVATE' }, 503);
      state.deletes++; state.hooks = state.hooks.filter(h => h.id !== id);
      return new Response(null, { status: 204 });
    }
    throw Error('Unexpected request ' + url);
  };
  const ports = { callbackBaseUrl: 'https://payments.example.test/backend', fetch,
    authorize: async a => { if (state.deny || a.actorId !== 'admin' || a.deploymentId !== 'deployment' || a.ownerId !== 'creator') throw Error('forbidden'); },
    assertEnabled: async () => { if (!state.enabled) throw Error('payments_disabled'); },
    now: () => new Date('2026-11-01T12:00:00Z'),
    vault: {
      write: async ({ cellId, ownerId, value }) => { assert.equal(cellId, actor.deploymentId); assert.equal(ownerId, actor.ownerId); const reference = 'ref-' + ++state.sequences; state.vault.set(reference, value); return { reference }; },
      read: async ({ reference, cellId }) => { assert.equal(cellId, actor.deploymentId); return state.vault.get(reference); },
      revoke: async ({ reference }) => { if (state.revokeFailure) throw Error('vault unavailable'); state.vault.delete(reference); }
    },
    store: {
      withLock: async (scope, operation) => {
        const key = scopeKey(scope), previous = state.locks.get(key) ?? Promise.resolve();
        let release; const next = new Promise(resolve => { release = resolve; }); state.locks.set(key, next);
        await previous; try { return await operation(); } finally { release(); }
      },
      find: async scope => structuredClone(state.records.get(scopeKey(scope))),
      get: async (deployment, id) => structuredClone([...state.records.values()].find(c => c.deploymentId === deployment && c.id === id)),
      save: async (record, expected, audit) => {
        const key = scopeKey(record), old = state.records.get(key);
        assert.equal(old?.revision ?? 0, expected, 'compare-and-swap');
        state.records.set(key, structuredClone(record)); state.audits.push(structuredClone(audit));
      },
      countUnconfirmedOrders: async () => state.pendingOrders,
      acceptEvent: async event => {
        if (state.storageDown) throw Error('storage unavailable');
        const key = JSON.stringify([event.connection.deploymentId, event.connection.id, event.connection.environment, event.eventId]);
        if (state.inbox.has(key)) return 'duplicate';
        state.inbox.set(key, structuredClone(event)); state.jobs.push({ key }); return 'accepted';
      }
    }
  };
  return { state, ports, service: new PayPalConnections(ports), fetch };
}

test('registers required subscriptions automatically and exposes only sanitized configured status', async () => {
  const { service, state } = fixture();
  const c = await service.connect(actor, input);
  assert.equal(c.state, 'configured'); assert.equal(c.lastVerifiedPaymentAt, undefined); assert.equal(c.acceptsCheckouts, false);
  assert.equal(c.maskedClientId, '••••-app');
  assert.equal(c.webhookUrl, 'https://payments.example.test/backend/api/webhooks/paypal/' + c.id);
  assert.deepEqual(state.hooks[0].event_types.map(e => e.name), PAYPAL_EVENT_TYPES);
  assert.equal(c.webhookId, 'HOOK-1'); assert.equal(state.vault.size, 1);
  for (const secret of ['PRIVATE-secret', 'PRIVATE-token', 'ref-', 'client-app']) assert.equal(JSON.stringify(c).includes(secret), false);
  assert.equal(JSON.stringify(state.records.values().next().value).includes('PRIVATE-secret'), false);
  assert.equal(JSON.stringify(state.audits).includes('PRIVATE'), false);
});

test('concurrent retries, process restart and same-app rotation reuse the opaque callback and webhook', async () => {
  const { service, ports, state } = fixture();
  const [a, b] = await Promise.all([service.connect(actor, input), service.connect(actor, input)]);
  assert.equal(a.id, b.id); assert.equal(state.creates, 1); assert.equal(state.vault.size, 1);
  const restarted = new PayPalConnections(ports);
  const rotated = await restarted.connect(actor, { ...input, clientSecret: 'ROTATED-secret' });
  assert.equal(rotated.id, a.id); assert.equal(rotated.webhookId, a.webhookId); assert.equal(state.creates, 1);
  assert.equal(state.vault.size, 1); assert.equal(Buffer.from([...state.vault.values()][0]).toString(), 'ROTATED-secret');
});

test('lost registration response recovers by exact persisted URL without touching unrelated integrations', async () => {
  const { service, state, ports } = fixture();
  state.hooks.push({ id: 'OTHER', url: 'https://other.example.test/hook', event_types: [{ name: '*' }] });
  state.dropCreateResponse = true;
  await assert.rejects(service.connect(actor, input), { code: 'provider_outcome_unknown' });
  const failed = await service.get(actor, 'sandbox'); assert.equal(failed.state, 'action_required');
  const recovered = await new PayPalConnections(ports).connect(actor, input);
  assert.equal(recovered.id, failed.id); assert.equal(state.creates, 1); assert.equal(state.hooks[0].id, 'OTHER');
  assert.equal(state.vault.size, 1);
});

test('repairs missing subscriptions only on its exact managed callback', async () => {
  const { service, state } = fixture();
  await service.connect(actor, input);
  state.hooks[0].event_types = [{ name: 'PAYMENT.CAPTURE.COMPLETED' }];
  state.hooks.push({ id: 'OTHER', url: 'https://other.test/hook', event_types: [] });
  await service.connect(actor, input);
  assert.deepEqual(state.hooks[0].event_types.map(e => e.name), PAYPAL_EVENT_TYPES);
  assert.deepEqual(state.hooks[1].event_types, []);
});

test('authorization, eligibility and app replacement fail before credentials or remote webhooks change', async () => {
  const { service, state } = fixture();
  state.deny = true; await assert.rejects(service.connect(actor, input), /forbidden/);
  state.deny = false; state.enabled = false; await assert.rejects(service.connect(actor, input), /payments_disabled/);
  assert.equal(state.calls.length, 0); assert.equal(state.vault.size, 0);
  state.enabled = true; const c = await service.connect(actor, input); const calls = state.calls.length;
  await assert.rejects(service.connect(actor, { ...input, clientId: 'different-app' }), { code: 'app_replacement_requires_migration' });
  assert.equal(state.calls.length, calls); assert.equal((await service.get(actor, 'sandbox')).id, c.id);
  await assert.rejects(service.get({ ...actor, ownerId: 'other' }, 'sandbox'), /forbidden/);
});

test('sandbox and live have separate connection IDs, vault records and provider origins', async () => {
  const { service, state } = fixture();
  const sandbox = await service.connect(actor, input), live = await service.connect(actor, { ...input, environment: 'live' });
  assert.notEqual(sandbox.id, live.id); assert.equal(state.records.size, 2); assert.equal(state.vault.size, 2);
  assert.ok(state.calls.some(call => call.url.startsWith('https://api-m.sandbox.paypal.com/')));
  assert.ok(state.calls.some(call => call.url.startsWith('https://api-m.paypal.com/')));
});

test('signature verification persists original bytes and one durable job, but establishes no payment or access', async () => {
  const { service, ports, state } = fixture(); const c = await service.connect(actor, input);
  const raw = Buffer.from('{ "id": "EVENT-1", "event_type": "PAYMENT.CAPTURE.COMPLETED", "resource": {} }');
  assert.equal(await service.receive(actor.deploymentId, c.id, headers(), raw), 'accepted');
  assert.equal(await new PayPalConnections(ports).receive(actor.deploymentId, c.id, headers(), raw), 'duplicate');
  assert.equal(state.inbox.size, 1); assert.equal(state.jobs.length, 1);
  assert.deepEqual(Buffer.from([...state.inbox.values()][0].rawBody), raw);
  assert.equal(JSON.stringify([...state.inbox.values()][0].connection).includes('ref-'), false);
  assert.equal((await service.get(actor, 'sandbox')).state, 'configured');
  await assert.rejects(service.receive('other-deployment', c.id, headers(), raw), { code: 'connection_not_found' });
});

test('forged signatures, missing headers, invalid UTF8 and oversized bodies never reach the durable inbox', async () => {
  const { service, state } = fixture(); const c = await service.connect(actor, input);
  state.signature = 'FAILURE'; await assert.rejects(service.receive(actor.deploymentId, c.id, headers(), body()), { code: 'invalid_webhook_signature' });
  state.signature = 'SUCCESS';
  await assert.rejects(service.receive(actor.deploymentId, c.id, new Headers(), body()), { code: 'invalid_webhook_headers' });
  await assert.rejects(service.receive(actor.deploymentId, c.id, headers(), new Uint8Array(1024 * 1024 + 1)), { code: 'invalid_webhook_body' });
  await assert.rejects(service.receive(actor.deploymentId, c.id, headers(), Buffer.from([0xff])), { code: 'invalid_webhook_body' });
  await assert.rejects(service.receive(actor.deploymentId, c.id, headers(), Buffer.from('{"event_type":"PAYMENT.CAPTURE.COMPLETED"}')), { code: 'invalid_webhook_body' });
  assert.equal(state.inbox.size, 0);
});

test('certificate URLs reject arbitrary hosts, credentials, redirects and querystrings before provider calls', async () => {
  const { service, state } = fixture(); const c = await service.connect(actor, input); const calls = state.calls.length;
  for (const url of ['http://api.sandbox.paypal.com/v1/notifications/certs/CERT', 'https://evil.test/cert',
    'https://api.sandbox.paypal.com.evil.test/v1/notifications/certs/CERT',
    'https://user:pass@api.sandbox.paypal.com/v1/notifications/certs/CERT',
    'https://api.sandbox.paypal.com:8443/v1/notifications/certs/CERT',
    'https://api.sandbox.paypal.com/v1/notifications/certs/CERT?redirect=evil', 'https://api.sandbox.paypal.com/elsewhere']) {
    const h = headers(); h.set('paypal-cert-url', url);
    await assert.rejects(service.receive(actor.deploymentId, c.id, h, body()), { code: 'invalid_certificate_url' });
  }
  assert.equal(state.calls.length, calls); assert.equal(state.inbox.size, 0);
});

test('durable storage failure propagates, and retry after recovery is accepted', async () => {
  const { service, state } = fixture(); const c = await service.connect(actor, input);
  state.storageDown = true; await assert.rejects(service.receive(actor.deploymentId, c.id, headers(), body()), /storage unavailable/);
  assert.equal(state.inbox.size, 0);
  state.storageDown = false; assert.equal(await service.receive(actor.deploymentId, c.id, headers(), body()), 'accepted');
});

test('disconnect blocks unconfirmed orders and retries cleanup failure without losing credentials', async () => {
  const { service, state } = fixture(); const c = await service.connect(actor, input);
  state.hooks.push({ id: 'OTHER', url: 'https://other.test/hook', event_types: [] });
  state.pendingOrders = 1; await assert.rejects(service.disconnect(actor, 'sandbox'), { code: 'unconfirmed_orders_require_reconciliation' });
  assert.equal(state.deletes, 0);
  state.pendingOrders = 0; state.deleteFailure = true;
  const failed = await service.disconnect(actor, 'sandbox'); assert.equal(failed.state, 'action_required'); assert.equal(failed.lastError, 'provider_outcome_unknown');
  assert.equal(state.vault.size, 1);
  state.deleteFailure = false;
  const disconnected = await service.disconnect(actor, 'sandbox'); assert.equal(disconnected.state, 'disconnected'); assert.equal(state.vault.size, 0);
  assert.deepEqual(state.hooks.map(h => h.id), ['OTHER']);
  await assert.rejects(service.receive(actor.deploymentId, c.id, headers(), body()), { code: 'connection_not_found' });
  const reconnected = await service.connect(actor, input); assert.equal(reconnected.id, c.id); assert.equal(reconnected.state, 'configured');
});

test('disconnect recovers an unknown registration outcome and vault cleanup remains visible/retryable', async () => {
  const { service, state } = fixture(); state.dropCreateResponse = true;
  await assert.rejects(service.connect(actor, input));
  state.revokeFailure = true;
  const disconnected = await service.disconnect(actor, 'sandbox');
  assert.equal(disconnected.state, 'disconnected'); assert.equal(disconnected.credentialCleanupPending, true); assert.equal(state.hooks.length, 0);
  state.revokeFailure = false;
  assert.equal((await service.disconnect(actor, 'sandbox')).credentialCleanupPending, false); assert.equal(state.vault.size, 0);
});

test('provider errors redact raw bodies and transport errors, with rate limit cooldown preserved', async () => {
  for (const [status, code] of [[401, 'invalid_credentials'], [403, 'missing_permissions'], [422, 'provider_rejected'], [429, 'rate_limited'], [503, 'provider_outcome_unknown']]) {
    const client = new PayPalClient('sandbox', input, async () => new Response('PRIVATE credential details', { status, headers: { 'retry-after': '45' } }));
    await assert.rejects(client.listWebhooks(), error => error.code === code && error.retryAfterSeconds === 45 && !error.message.includes('PRIVATE'));
  }
  const { service, state } = fixture(); state.tokenFailure = true;
  await assert.rejects(service.connect(actor, input), { code: 'invalid_credentials' });
  assert.equal((await service.get(actor, 'sandbox')).lastError, 'invalid_credentials'); assert.equal(state.creates, 0);
});

test('token cache respects expiry; all requests use fixed provider origins and refuse redirects', async () => {
  let time = 0, tokens = 0;
  const client = new PayPalClient('sandbox', input, async (url, init) => {
    assert.ok(url.startsWith('https://api-m.sandbox.paypal.com/')); assert.equal(init.redirect, 'error');
    if (url.endsWith('/token')) { tokens++; return json({ access_token: 'token', token_type: 'Bearer', expires_in: 120 }); }
    return json({ webhooks: [] });
  }, () => time);
  await client.listWebhooks(); await client.listWebhooks(); assert.equal(tokens, 1);
  time = 61000; await client.listWebhooks(); assert.equal(tokens, 2);
  assert.throws(() => new PayPalClient('wrong', input), { code: 'invalid_environment' });
  assert.throws(() => new PayPalConnections({ ...fixture().ports, callbackBaseUrl: 'http://localhost' }), { code: 'invalid_callback_base' });
});

test('a permanently rejected registration can adopt a repaired callback without changing identity',async()=>{const {service,state,ports}=fixture();state.tokenFailure=true;await assert.rejects(service.connect(actor,input));const prior=await ports.store.find({...actor,environment:'sandbox'});state.tokenFailure=false;const repaired=new PayPalConnections({...ports,callbackBaseUrl:'https://receiver.example.test'});const result=await repaired.connect(actor,input);assert.equal(result.id,prior.id);assert.equal(result.webhookUrl,'https://receiver.example.test/api/webhooks/paypal/'+prior.id);assert.equal(state.creates,1);});
test('a callback change never silently migrates an existing hook or ambiguous registration',async()=>{for(const ambiguous of [false,true]){const {service,state,ports}=fixture();if(ambiguous){state.dropCreateResponse=true;await assert.rejects(service.connect(actor,input));}else await service.connect(actor,input);const repaired=new PayPalConnections({...ports,callbackBaseUrl:'https://receiver.example.test'});await assert.rejects(repaired.connect(actor,input),{code:'callback_change_requires_review'});assert.equal(state.creates,1);assert.equal(state.deletes,0);}});

test('an ambiguous create stays fenced across a later credential failure',async()=>{const {service,state,ports}=fixture();state.dropCreateResponse=true;await assert.rejects(service.connect(actor,input));state.tokenFailure=true;await assert.rejects(service.connect(actor,input),{code:'invalid_credentials'});state.tokenFailure=false;await assert.rejects(new PayPalConnections({...ports,callbackBaseUrl:'https://receiver.example.test'}).connect(actor,input),{code:'callback_change_requires_review'});assert.equal(state.creates,1);assert.equal(state.deletes,0);});
