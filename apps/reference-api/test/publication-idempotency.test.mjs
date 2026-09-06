import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLocalAdapterSet } from '@ubeeq/adapter-local';
import { createReferenceApi } from '../dist/server.js';

test('publication keys survive restart, reject changed requests and never republish a removed receipt', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ubeeq-publication-retry-'));
  const configuration = { databasePath: join(directory, 'state.sqlite'), dataDirectory: directory, publicBaseUrl: 'http://localhost', cellId: 'cell' };
  let local, api;
  const start = async () => {
    local = createLocalAdapterSet(configuration);
    const identity = { verifySession: async ({ credential }) => ({ id: credential, subject: { id: credential, roles: [], scopes: [] } }) };
    api = createReferenceApi({ publicBaseUrl: 'http://127.0.0.1:0', cellId: 'cell', adapters: { repositories: local.repositories, storage: local.storage, uploads: local.storage, delivery: local.storage, jobs: local.jobs, identity } });
    await new Promise(resolve => api.server.listen(0, '127.0.0.1', resolve));
  };
  const request = async (path, body, key, actor = 'owner') => {
    const response = await fetch(`http://127.0.0.1:${api.server.address().port}${path}`, { method: 'POST', headers: { authorization: `Bearer ${actor}`, 'content-type': 'application/json', ...(key === undefined ? {} : { 'idempotency-key': key }) }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  await start();
  try {
    assert.equal((await request('/v1/creators', { handle: 'owner', displayName: 'Owner' })).status, 201);
    const work = (await request('/v1/works', { title: 'Retry Work' })).body.work;
    await local.repositories.assets.create({ id: 'asset', instanceId: work.instanceId, homeCellId: work.homeCellId, dataHomeRegion: work.dataHomeRegion, dataHomeAssignedAt: work.dataHomeAssignedAt, routingRevision: work.routingRevision, creatorId: work.creatorId, workId: work.id, status: 'ready', mimeType: 'image/png', checksum: 'hash', objectVersion: 'v1' });
    const path = `/v1/works/${work.id}/publications`;
    const writeAudit = local.repositories.auditEvents.create.bind(local.repositories.auditEvents);
    local.repositories.auditEvents.create = async () => { throw new Error('injected final write failure'); };
    try { assert.equal((await request(path, { destination: 'local' }, 'durable-request')).status, 500); }
    finally { local.repositories.auditEvents.create = writeAudit; }
    assert.deepEqual((await local.repositories.publicationIntents.list({ limit: 100 })).items, []);
    const concurrent = await Promise.all([
      request(path, { destination: 'local' }, 'durable-request'),
      request(path, { destination: 'local' }, 'durable-request')
    ]);
    assert.deepEqual(concurrent.map(result => result.status).sort(), [200, 201]);
    const first = concurrent.find(result => result.status === 201);
    assert.equal(first.status, 201); assert.equal(first.body.idempotent, false);
    await api.close(); local.database.database.close(); await start();
    const retry = await request(path, { destination: 'local' }, 'durable-request');
    assert.equal(retry.status, 200); assert.equal(retry.body.idempotent, true);
    assert.deepEqual(retry.body.intent, first.body.intent);
    assert.deepEqual(retry.body.publication, first.body.publication);
    assert.equal(retry.body.work.revision, first.body.work.revision);
    const conflict = await request(path, { destination: 'elsewhere' }, 'durable-request');
    assert.equal(conflict.status, 409); assert.equal(conflict.body.error.code, 'idempotency_conflict');
    assert.equal((await request('/v1/creators', { handle: 'stranger', displayName: 'Stranger' }, undefined, 'stranger')).status, 201);
    assert.equal((await request(path, { destination: 'local' }, 'durable-request', 'stranger')).status, 403);
    assert.equal((await request(path, { destination: 'local' }, 'x'.repeat(201))).status, 400);
    await local.repositories.publications.update(first.body.publication.id, first.body.publication.revision, { status: 'removed' });
    const removed = await request(path, { destination: 'local' }, 'durable-request');
    assert.equal(removed.status, 200); assert.equal(removed.body.publication.status, 'removed');
    assert.equal((await local.repositories.publicationIntents.list({ limit: 100 })).items.length, 1);
    assert.equal((await local.repositories.publications.list({ limit: 100 })).items.length, 1);
    assert.equal((await local.repositories.auditEvents.list({ limit: 100 })).items.filter(item => item.action === 'work.published').length, 1);
  } finally { await api.close(); local.database.database.close(); rmSync(directory, { recursive: true, force: true }); }
});
