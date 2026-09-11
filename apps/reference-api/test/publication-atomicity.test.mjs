import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLocalAdapterSet } from '@ubeeq/adapter-local';
import { createReferenceApi } from '../dist/server.js';

test('reference publication rolls back intent, publication, Work and audit on any write failure', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ubeeq-publication-'));
  const local = createLocalAdapterSet({ databasePath: join(directory, 'state.sqlite'), dataDirectory: directory, publicBaseUrl: 'http://localhost', cellId: 'cell' });
  const identity = { verifySession: async () => ({ id: 'owner', subject: { id: 'owner', roles: [], scopes: [] } }) };
  const api = createReferenceApi({ publicBaseUrl: 'http://127.0.0.1:0', cellId: 'cell', adapters: { repositories: local.repositories, storage: local.storage, uploads: local.storage, delivery: local.storage, jobs: local.jobs, identity } });
  await new Promise(resolve => api.server.listen(0, '127.0.0.1', resolve));
  const request = async (path, body) => {
    const response = await fetch(`http://127.0.0.1:${api.server.address().port}${path}`, { method: 'POST', headers: { authorization: 'Bearer owner', 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  try {
    assert.equal((await request('/v1/creators', { handle: 'owner', displayName: 'Owner' })).status, 201);
    const created = await request('/v1/works', { title: 'Atomic Work' });
    assert.equal(created.status, 201);
    const work = created.body.work;
    await local.repositories.assets.create({ id: 'asset', instanceId: work.instanceId, homeCellId: work.homeCellId, dataHomeRegion: work.dataHomeRegion, dataHomeAssignedAt: work.dataHomeAssignedAt, routingRevision: work.routingRevision, creatorId: work.creatorId, workId: work.id, status: 'ready', mimeType: 'image/png', checksum: 'hash', objectVersion: 'v1' });
    const auditBefore = (await local.repositories.auditEvents.list({ limit: 100 })).items;
    for (const [repository, method] of [[local.repositories.publications, 'create'], [local.repositories.works, 'update'], [local.repositories.auditEvents, 'create']]) {
      const original = repository[method].bind(repository);
      repository[method] = async () => { throw new Error('injected publication failure'); };
      try { assert.equal((await request(`/v1/works/${work.id}/publications`, { destination: 'local' })).status, 500); }
      finally { repository[method] = original; }
      assert.deepEqual((await local.repositories.publicationIntents.list({ limit: 100 })).items, []);
      assert.deepEqual((await local.repositories.publications.list({ limit: 100 })).items, []);
      assert.deepEqual(await local.repositories.works.get(work.id), work);
      assert.deepEqual((await local.repositories.auditEvents.list({ limit: 100 })).items, auditBefore);
    }
    const published = await request(`/v1/works/${work.id}/publications`, { destination: 'local' });
    assert.equal(published.status, 201);
    assert.equal(published.body.work.status, 'published');
    assert.equal((await local.repositories.publicationIntents.list({ limit: 100 })).items.length, 1);
    assert.equal((await local.repositories.publications.list({ limit: 100 })).items.length, 1);
    assert.equal((await local.repositories.auditEvents.list({ limit: 100 })).items.filter(item => item.action === 'work.published').length, 1);
  } finally { await api.close(); local.database.database.close(); rmSync(directory, { recursive: true, force: true }); }
});
