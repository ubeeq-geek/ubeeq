import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLocalAdapterSet } from '@ubeeq/adapter-local';
import { createCreatorExport } from '@ubeeq/portability';
import { createReferenceApi } from '../dist/server.js';

test('metadata-only HTTP import strips processing outputs and remote publication identity without starting jobs', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ubeeq-import-live-state-'));
  const local = createLocalAdapterSet({ databasePath: join(directory, 'state.sqlite'), dataDirectory: directory, publicBaseUrl: 'http://localhost', cellId: 'cell' });
  const identity = { verifySession: async () => ({ id: 'owner', subject: { id: 'owner', roles: [], scopes: [] } }) };
  const api = createReferenceApi({ publicBaseUrl: 'http://127.0.0.1:0', cellId: 'cell', adapters: {
    repositories: local.repositories, storage: local.storage, uploads: local.storage, delivery: local.storage, jobs: local.jobs, identity } });
  await new Promise(resolve => api.server.listen(0, '127.0.0.1', resolve));
  const request = async (path, body) => {
    const response = await fetch(`http://127.0.0.1:${api.server.address().port}${path}`, { method: 'POST',
      headers: { authorization: 'Bearer owner', 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  try {
    const creator = (await request('/v1/creators', { handle: 'owner', displayName: 'Owner' })).body.creator;
    const source = { ...creator, id: 'source', subjectId: 'source' };
    const checksum = 'a'.repeat(64), key = 'cells/cell/creators/source/asset';
    const asset = { ...source, id: 'asset', creatorId: 'source', workId: 'work', mimeType: 'image/png', checksum, objectVersion: 'v1', status: 'ready',
      storage: { key, versionId: 'v1', byteLength: 10 }, originalStorage: { key },
      processing: { state: 'completed', sourceVersionId: 'v1', renditions: [{ key: 'source-output' }] }, renditions: [{ key: 'source-output' }] };
    const manifest = createCreatorExport({ exportedAt: '2026-01-01T00:00:00Z', creator: source,
      works: [{ ...source, id: 'work', creatorId: 'source', title: 'Retained title', status: 'published' }], assets: [asset], collections: [],
      publications: [{ ...source, id: 'publication', workId: 'work', destination: 'local', status: 'live', remoteId: 'source-remote-id' }],
      publicationIntents: [], processing: [], moderationEvidence: [], moderationHolds: [], reviewCases: [], auditEvents: [], usageEvents: [],
      integrationAccounts: [], exportCheckpoints: [], importCheckpoints: [], objectInventory: [{ assetId: 'asset', key, versionId: 'v1', checksum, byteLength: 10, transferState: 'manifest_only' }] });
    const before = structuredClone(manifest);
    const jobsBefore = local.database.database.prepare('SELECT * FROM ubeeq_jobs ORDER BY id').all();
    const result = await request('/v1/imports', { manifest, importId: 'metadata', dryRun: false });
    assert.equal(result.status, 201); assert.equal(result.body.originalFilesTransferred, false);
    const imported = await local.repositories.assets.get('asset');
    assert.equal(imported.creatorId, creator.id); assert.equal(imported.status, 'pending');
    assert.equal(imported.checksum, checksum); assert.equal(imported.objectVersion, 'v1');
    for (const field of ['storage', 'originalStorage', 'processing', 'renditions']) assert.equal(field in imported, false);
    const publication = await local.repositories.publications.get('publication');
    assert.equal(publication.status, 'draft'); assert.equal('remoteId' in publication, false);
    assert.equal((await local.repositories.works.get('work')).title, 'Retained title');
    assert.deepEqual(local.database.database.prepare('SELECT * FROM ubeeq_jobs ORDER BY id').all(), jobsBefore);
    assert.deepEqual(manifest, before);
    assert.equal((await request('/v1/imports', { manifest, importId: 'metadata', dryRun: false })).body.idempotent, true);
  } finally { await api.close(); local.database.database.close(); rmSync(directory, { recursive: true, force: true }); }
});
