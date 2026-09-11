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
    const scope = { instanceId: work.instanceId, homeCellId: work.homeCellId, dataHomeRegion: work.dataHomeRegion, dataHomeAssignedAt: work.dataHomeAssignedAt, routingRevision: work.routingRevision };
    for (let index = 0; index < 101; index++) {
      await local.repositories.assets.create({ ...scope, id: `b-${String(index).padStart(3, '0')}`, creatorId: work.creatorId, workId: work.id, status: 'ready', mimeType: 'image/png', checksum: 'hash', objectVersion: 'v1' });
      await local.repositories.moderationHolds.create({ ...scope, id: `h-${String(index).padStart(3, '0')}`, subjectId: `unrelated-${index}`, state: 'active', reason: 'unrelated' });
    }
    const pending = await local.repositories.assets.create({ ...scope, id: 'zz-pending', creatorId: work.creatorId, workId: work.id, status: 'pending', mimeType: 'image/png', checksum: 'hash', objectVersion: 'v1' });
    const pendingResponse = await request(`/v1/works/${work.id}/publications`, { destination: 'local' });
    assert.equal(pendingResponse.status, 409); assert.equal(pendingResponse.body.error.code, 'processing_incomplete');
    await local.repositories.assets.update(pending.id, pending.revision, { status: 'ready' });
    const hold = await local.repositories.moderationHolds.create({ ...scope, id: 'zz-held', subjectId: pending.id, state: 'active', reason: 'review' });
    const heldResponse = await request(`/v1/works/${work.id}/publications`, { destination: 'local' });
    assert.equal(heldResponse.status, 409); assert.equal(heldResponse.body.error.code, 'admission_blocked');
    assert.deepEqual((await local.repositories.publicationIntents.list({ limit: 100 })).items, []);
    await local.repositories.moderationHolds.update(hold.id, hold.revision, { state: 'released' });
    const listAssets = local.repositories.assets.list.bind(local.repositories.assets);
    local.repositories.assets.list = async page => {
      if (page.cursor) throw new Error('later asset page unavailable');
      return listAssets(page);
    };
    try { assert.equal((await request(`/v1/works/${work.id}/publications`, { destination: 'local' })).status, 500); }
    finally { local.repositories.assets.list = listAssets; }
    assert.deepEqual((await local.repositories.publicationIntents.list({ limit: 100 })).items, []);
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
    const object = { bucket: 'cell', key: 'cells/cell/creators/owner/renditions/asset', versionId: 'v1', contentType: 'application/octet-stream', byteLength: 1, scope: 'private' };
    await local.storage.put({ object, body: new Uint8Array([7]) });
    const original = await local.repositories.assets.get('asset');
    let stored = await local.repositories.assets.update(original.id, original.revision, { storage: object });
    const issued = await local.storage.issue({ object: { ...object, scope: 'public' }, expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const deliveryUrl = `http://127.0.0.1:${api.server.address().port}${new URL(issued.url).pathname}`;
    assert.equal((await fetch(deliveryUrl)).status, 200);
    const withdrawn = await local.repositories.publications.update(published.body.publication.id, published.body.publication.revision, { status: 'withdrawn' });
    assert.equal((await fetch(deliveryUrl)).status, 404);
    await local.repositories.publications.update(withdrawn.id, withdrawn.revision, { status: 'live' });
    stored = await local.repositories.assets.update(stored.id, stored.revision, { storage: { ...object, versionId: 'v2' } });
    assert.equal((await fetch(deliveryUrl)).status, 404);
    stored = await local.repositories.assets.update(stored.id, stored.revision, { storage: object, status: 'pending' });
    assert.equal((await fetch(deliveryUrl)).status, 404);
    await local.repositories.assets.update(stored.id, stored.revision, { status: 'ready' });
    assert.equal((await fetch(deliveryUrl)).status, 200);
  } finally { await api.close(); local.database.database.close(); rmSync(directory, { recursive: true, force: true }); }
});
