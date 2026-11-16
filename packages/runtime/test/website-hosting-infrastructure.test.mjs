import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createLocalAdapterSet, NativeWebsiteHostingAdapter, SqliteWebsiteStore} from '@ubeeq/adapter-local';
import {WebsiteError} from '@ubeeq/core';
import {WebsiteHostingConnections, CloudflarePagesWebsiteHostingAdapter} from '@ubeeq/integrations';
import {createReferenceApi} from '../dist/index.js';

test('host infrastructure shares concrete connections, vault, authorization and adapters with real HTTP dispatch', async t => {
  const root = await mkdtemp(join(tmpdir(), 'hosting-infrastructure-'));
  const store = new SqliteWebsiteStore(join(root, 'websites.sqlite'));
  let local, connections, pages, native;
  const authorized = [];
  const noProvider = async () => { throw Error('This local composition control must not call a provider.'); };
  const configuration = {
    databasePath: join(root, 'core.sqlite'), dataDirectory: join(root, 'data'),
    publicBaseUrl: 'http://127.0.0.1:0', cellId: 'local',
    credentialEncryptionKey: 'unit-test-only-credential-key-0123456789',
    createLocalAdapters: config => {
      local = createLocalAdapterSet(config);
      connections = new WebsiteHostingConnections({
        cellId: 'local', vault: local.credentials, states: store.hostingOAuthStates,
        authorize: async actor => {
          const creator = await local.repositories.creators.get(actor.workspaceId);
          if (!creator || creator.subjectId !== actor.actorId) throw new WebsiteError('authorization_denied', 'Current owner required.');
          authorized.push({...actor});
        },
        get: (workspace, id) => store.getConnection(workspace, id),
        list: workspace => store.listConnections(workspace),
        save: (connection, expected) => store.saveConnection(connection, expected),
        fetch: noProvider,
      });
      pages = new CloudflarePagesWebsiteHostingAdapter({credential: c => connections.credential(c), probe: noProvider, fetch: noProvider});
      native = new NativeWebsiteHostingAdapter({id: 'host-native', root: join(root, 'hosting'), publicUrlTemplate: 'https://unit.test/sites/{site}/', persistent: true, writerMode: 'single'}, noProvider);
      configuration.websiteHostingInfrastructure = Object.freeze({connections, adapters: Object.freeze([native, pages]), nativeAdapters: Object.freeze([native])});
      return local;
    },
    websitePersistence: () => store,
  };
  const runtime = createReferenceApi(configuration);
  t.after(async () => { await runtime.close(); store.close(); await rm(root, {recursive: true, force: true}); });
  assert.equal(runtime.website.hostingConnections, connections);
  assert.deepEqual(runtime.website.hostingAdapters, [native, pages]);
  assert.equal(runtime.website.hostingAdapters[0], native);
  assert.equal(runtime.website.hostingAdapters[1], pages);
  assert.equal(Object.isFrozen(runtime.website.hostingAdapters), true);
  await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + runtime.server.address().port;
  const request = async (path, {method = 'GET', body, token} = {}) => {
    const response = await fetch(base + path, {method, headers: {'content-type': 'application/json', ...(token ? {authorization: 'Bearer ' + token} : {})}, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
    return {status: response.status, body: await response.json()};
  };
  const credentials = {email: 'hosting-owner@unit.test', password: 'Actual unit hosting password123!'};
  assert.equal((await request('/v1/auth/sign-up', {method: 'POST', body: credentials})).status, 201);
  const signed = await request('/v1/auth/sign-in', {method: 'POST', body: credentials});
  assert.equal(signed.status, 200);
  const token = signed.body.token;
  const created = await request('/v1/creators', {method: 'POST', token, body: {handle: 'hosting-owner', displayName: 'Hosting owner'}});
  assert.equal(created.status, 201);
  const creator = created.body.creator;
  const secret = await local.credentials.write({cellId: 'local', ownerId: creator.id, value: Buffer.from('explicit-offline-unit-secret')});
  const connection = {id: 'pages-unit', workspaceId: creator.id, revision: 1, family: 'cloudflare-pages', accountId: 'a'.repeat(32), authorization: 'api_token', credentialReference: secret.reference, permissions: ['website.deploy'], state: 'connected'};
  await store.saveConnection(connection, 0);
  const listed = await request('/v1/websites/hosting-connections', {token});
  assert.equal(listed.status, 200);
  const {credentialReference, ...safe} = connection;
  assert.deepEqual(listed.body.connections, [safe]);
  assert.deepEqual(authorized, [{workspaceId: creator.id, actorId: creator.subjectId}]);
  assert.equal(await connections.credential(connection), 'explicit-offline-unit-secret');
  const choices = await request('/v1/websites/unit-site/hosting/choices', {token});
  assert.equal(choices.status, 200);
  assert.deepEqual(choices.body.choices.map(c => c.id), [native.id, pages.id]);
  assert.equal((await request('/v1/websites/hosting-connections')).status, 401);
  assert.equal(authorized.length, 1);
});
