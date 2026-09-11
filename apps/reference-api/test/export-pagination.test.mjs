import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLocalAdapterSet } from '@ubeeq/adapter-local';
import { validateCreatorExport } from '@ubeeq/portability';
import { createReferenceApi } from '../dist/server.js';

test('export and import preflight visit every repository page and reject broken pagination', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ubeeq-export-pages-'));
  const local = createLocalAdapterSet({ databasePath: join(directory, 'state.sqlite'), dataDirectory: directory, publicBaseUrl: 'http://localhost', cellId: 'cell' });
  const identity = { verifySession: async () => ({ id: 'owner', subject: { id: 'owner', roles: [], scopes: [] } }) };
  const api = createReferenceApi({ publicBaseUrl: 'http://127.0.0.1:0', cellId: 'cell', adapters: {
    repositories: local.repositories, storage: local.storage, uploads: local.storage, delivery: local.storage, jobs: local.jobs, identity } });
  await new Promise(resolve => api.server.listen(0, '127.0.0.1', resolve));
  const request = async (path, body) => {
    const response = await fetch(`http://127.0.0.1:${api.server.address().port}${path}`, { method: body ? 'POST' : 'GET',
      headers: { authorization: 'Bearer owner', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  try {
    const created = await request('/v1/creators', { handle: 'owner', displayName: 'Owner' });
    assert.equal(created.status, 201);
    const creator = created.body.creator;
    const home = { instanceId: creator.instanceId, homeCellId: creator.homeCellId, dataHomeRegion: creator.dataHomeRegion,
      dataHomeAssignedAt: creator.dataHomeAssignedAt, routingRevision: creator.routingRevision };
    const recipes = {
      works: { creatorId: creator.id, title: 'Work', status: 'draft' },
      assets: { creatorId: creator.id, workId: 'works-100', status: 'pending', mimeType: 'image/png', checksum: 'a'.repeat(64), objectVersion: 'v1' },
      collections: { creatorId: creator.id, title: 'Collection', visibility: 'private', workIds: ['works-100'] },
      publications: { workId: 'works-100', destination: 'local', status: 'draft' },
      publicationIntents: { workId: 'works-100', destination: 'local', idempotencyKey: 'request' },
      moderationEvidence: { subjectId: 'works-100', kind: 'test' },
      moderationHolds: { subjectId: 'works-100', state: 'released', reason: 'test' },
      reviewCases: { subjectId: 'works-100', state: 'decided' },
      auditEvents: { subjectId: 'works-100', action: 'test' },
      usageEvents: { accountId: creator.id, meter: 'storage_bytes', quantity: 1 },
      integrationAccounts: { creatorId: creator.id, provider: 'test', credentialReference: 'private-reference' },
      exportManifests: { creatorId: creator.id, schemaVersion: '2', checksum: 'a'.repeat(64), objectReference: 'inline:test' },
      importCheckpoints: { creatorId: creator.id, importId: 'test', state: 'completed' }
    };
    for (const [name, fields] of Object.entries(recipes)) {
      for (let index = 0; index < 101; index++) await local.repositories[name].create({ ...home, ...fields, id: `${name}-${String(index).padStart(3, '0')}` });
      await local.repositories[name].create({ ...home, ...fields, id: `${name}-foreign`, creatorId: 'foreign', workId: 'foreign', subjectId: 'foreign', accountId: 'foreign' });
    }
    const exported = await request('/v1/exports/me');
    assert.equal(exported.status, 200);
    validateCreatorExport(exported.body);
    for (const name of Object.keys(recipes)) {
      const field = name === 'exportManifests' ? 'exportCheckpoints' : name;
      assert.ok(exported.body[field].some(item => item.id === `${name}-100`), field);
      assert.ok(!exported.body[field].some(item => item.id === `${name}-foreign`), field);
    }
    assert.equal(exported.body.objectInventory.length, 101);
    assert.equal(exported.body.processing.length, 101);
    assert.equal(JSON.stringify(exported.body).includes('private-reference'), false);
    for (const endpoint of ['/v1/imports/validate', '/v1/imports']) {
      const response = await request(endpoint, { manifest: exported.body });
      assert.equal(response.status, 200);
      for (const [resource, repository] of [['work', 'works'], ['asset', 'assets'], ['collection', 'collections'],
        ['publication', 'publications'], ['publicationIntent', 'publicationIntents'], ['moderationEvidence', 'moderationEvidence'],
        ['moderationHold', 'moderationHolds'], ['reviewCase', 'reviewCases'], ['auditEvent', 'auditEvents'],
        ['usageEvent', 'usageEvents'], ['integrationAccount', 'integrationAccounts']]) {
        assert.ok(response.body.plan.conflicts.some(item => item.resource === resource && item.id === `${repository}-100`), resource);
      }
    }
    const originalList = local.repositories.works.list;
    local.repositories.works.list = async () => ({ items: [], nextCursor: 'repeated' });
    try { assert.equal((await request('/v1/exports/me')).status, 500); }
    finally { local.repositories.works.list = originalList; }
  } finally { await api.close(); local.database.database.close(); rmSync(directory, { recursive: true, force: true }); }
});
