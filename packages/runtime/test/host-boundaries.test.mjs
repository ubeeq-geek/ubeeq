import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createDefaultOpenCorePorts, createSingleOperatorTenancyPort } from '@ubeeq/extension-sdk';
import { createCoreRuntime } from '../dist/index.js';
import { createLocalAdapterSet } from '@ubeeq/adapter-local';

async function fixture(configuration, run) {
  const directory = await mkdtemp(join(tmpdir(), 'core-runtime-'));
  const runtime = createCoreRuntime({ databasePath: join(directory, 'state.sqlite'), dataDirectory: directory, publicBaseUrl: 'http://localhost', ...(typeof configuration === 'function' ? configuration(directory) : configuration) });
  await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${runtime.server.address().port}`;
  const request = async (path, token, body, method = body ? 'POST' : 'GET') => {
    const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: response.status === 204 ? null : await response.json() };
  };
  const signIn = async email => {
    await request('/v1/auth/sign-up', null, { email, password: 'Strong test password 143!' });
    return (await request('/v1/auth/sign-in', null, { email, password: 'Strong test password 143!' })).body.token;
  };
  try { await run({ runtime, request, signIn }); }
  finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); }
}

test('operational HTTP and worker paths invoke configured admission, quota, transform, credentials and UI slots', async () => {
  const calls = []; let deny = true;
  await fixture({ hostPorts: adapters => {
    const creators = async () => (await adapters.repositories.creators.list({ limit: 100 })).items;
    return createDefaultOpenCorePorts({
      tenancyAndAccess: createSingleOperatorTenancyPort({ getOperatorUserId: async () => (await creators())[0]?.subjectId ?? null, listOperatorCreatorIds: async actor => (await creators()).filter(c => c.subjectId === actor).map(c => c.id) }),
      publicationAdmission: { async evaluatePublication(input) { calls.push(['admission', input]); return { allowed: !deny, state: deny ? 'restricted' : 'eligible', reasonCodes: deny ? ['HOST_POLICY_DENIED'] : [] }; } },
      usageQuota: { async checkAndReserveQuota(input) { calls.push(['reserve', input]); return { allowed: true }; }, async recordUsageSettlement(input) { calls.push(['settle', input]); } },
      watermarkAndTransform: { supportsGraphicWatermark: false, supportsImageAdjustments: false, async applyDerivativeTransform(input) { calls.push(['transform', input.creatorId]); return { bytes: new TextEncoder().encode('derived bytes'), mimeType: 'image/png' }; } },
      connectorAppCredentials: { mode: 'byo_credentials', async resolveOAuthClient(provider, creatorId) { calls.push(['credentials', provider, creatorId]); return null; } },
      studioUiSlots: { supportDrawerSlot: 'support' },
    });
  } }, async ({ runtime, request, signIn }) => {
    assert.equal((await request('/v1/works')).status, 401);
    const token = await signIn('operator@example.test');
    const creator = (await request('/v1/creators', token, { handle: 'operator', displayName: 'Operator' })).body.creator;
    const work = (await request('/v1/works', token, { title: 'Persisted work' })).body.work;
    const bytes = Buffer.from('source bytes'); const checksum = createHash('sha256').update(bytes).digest('hex');
    const upload = (await request('/v1/uploads', token, { workId: work.id, mimeType: 'image/png', byteLength: bytes.length, checksum })).body.upload;
    await request(`/v1/uploads/${upload.uploadId}/content`, token, { base64: bytes.toString('base64') }, 'PUT');
    assert.equal((await request(`/v1/uploads/${upload.uploadId}/complete`, token, { workId: work.id, byteLength: bytes.length, checksum })).status, 202);
    await runtime.runNextJob('worker');
    assert.equal((await request(`/v1/works/${work.id}/publications`, token, { destination: 'native' })).status, 403);
    deny = false;
    assert.equal((await request(`/v1/works/${work.id}/publications`, token, { destination: 'native' })).status, 201);
    const visible = await request(`/v1/public/works/${work.id}`);
    assert.equal(visible.body.assets[0].storage.checksum, createHash('sha256').update('derived bytes').digest('hex'));
    assert.equal((await request('/v1/host-capabilities', token)).body.slots.supportDrawerSlot, 'support');
    await runtime.resolveConnectorAppCredentials({ actorUserId: creator.subjectId, creatorId: creator.id, provider: 'example' });
    await assert.rejects(() => runtime.resolveConnectorAppCredentials({ actorUserId: 'stranger', creatorId: creator.id, provider: 'example' }), /access is required/);
    for (const kind of ['reserve', 'settle', 'transform', 'admission', 'credentials']) assert.ok(calls.some(call => call[0] === kind), kind);
    assert.equal(calls.filter(call => call[0] === 'credentials').length, 1);
  });
});

test('concurrent first-creator claims cannot create two operator users', async () => {
  await fixture({}, async ({ request, signIn }) => {
    const first = await signIn('one@example.test'); const second = await signIn('two@example.test');
    const results = await Promise.all([request('/v1/creators', first, { handle: 'one', displayName: 'One' }), request('/v1/creators', second, { handle: 'two', displayName: 'Two' })]);
    assert.deepEqual(results.map(result => result.status).sort(), [201, 403]);
  });
});

test('registration admission runs before account creation and does not consume a refused email', async () => {
  let allowed = false;
  await fixture({ registrationAdmission: async () => ({ allowed, reasonCode: 'INVITATION_REQUIRED' }) }, async ({ request }) => {
    const body = { email: 'invite@example.test', password: 'Strong password 123!' };
    assert.equal((await request('/v1/auth/sign-up', null, body)).status, 403);
    allowed = true;
    assert.equal((await request('/v1/auth/sign-up', null, body)).status, 201);
  });
});
test('failed initial creator validation does not pin the instance to the refused actor', async () => {
  await fixture({}, async ({ request, signIn }) => {
    const first = await signIn('invalid@example.test'); const second = await signIn('valid@example.test');
    assert.equal((await request('/v1/creators', first, { handle: '', displayName: 'Invalid' })).status, 400);
    assert.equal((await request('/v1/creators', second, { handle: 'valid', displayName: 'Valid' })).status, 201);
  });
});

test('customer principals cannot claim the first operator or read creator content', async () => {
  let owned;
  try {
    await fixture(directory => {
      owned = createLocalAdapterSet({ databasePath: join(directory, 'state.sqlite'), dataDirectory: directory, publicBaseUrl: 'http://localhost', cellId: 'local-single-cell' });
      const identity = new Proxy(owned.identity, { get(target, key) {
        if (key === 'verifySession') return async input => { const session = await target.verifySession(input); if (session) session.subject.accountScope = 'customer_account'; return session; };
        const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
      } });
      return { adapters: { repositories: owned.repositories, storage: owned.storage, uploads: owned.storage, delivery: owned.storage, jobs: owned.jobs, identity, localIdentity: owned.identity } };
    }, async ({ request, signIn }) => {
      const first = await signIn('buyer-one@example.test'); const second = await signIn('buyer-two@example.test');
      for (const token of [first, second]) {
        assert.equal((await request('/v1/creators', token, { handle: 'buyer', displayName: 'Buyer' })).status, 403);
        assert.equal((await request('/v1/works', token)).status, 403);
      }
    });
  } finally { owned?.database.close(); }
});
