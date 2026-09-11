import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLocalAdapterSet } from '@ubeeq/adapter-local';
import { createCreatorExport } from '@ubeeq/portability';
import { createReferenceApi } from '../dist/server.js';

test('default imports remap relationships, roll back atomically and replay without duplicate UUIDs', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ubeeq-import-uuid-'));
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
  const records = async name => (await local.repositories[name].list({ limit: 100 })).items;
  try {
    const owner = (await request('/v1/creators', { handle: 'owner', displayName: 'Owner' })).body.creator;
    const source = { ...owner, id: 'source', subjectId: 'source' };
    const checksum = 'a'.repeat(64);
    const manifest = createCreatorExport({ exportedAt: '2026-01-01T00:00:00Z', creator: source,
      works: [{ ...source, id: 'work', creatorId: source.id, title: 'Imported', status: 'published' }],
      assets: [{ ...source, id: 'asset', creatorId: source.id, workId: 'work', status: 'ready', mimeType: 'image/png', checksum, objectVersion: 'v1' }],
      collections: [{ ...source, id: 'collection', creatorId: source.id, title: 'Collection', visibility: 'private', workIds: ['work'] }],
      publications: [{ ...source, id: 'publication', workId: 'work', destination: 'local', status: 'live', remoteId: 'remote' }],
      publicationIntents: [], processing: [], moderationEvidence: [],
      moderationHolds: [{ ...source, id: 'hold', subjectType: 'work', subjectId: 'work', state: 'active' }],
      reviewCases: [], auditEvents: [], usageEvents: [], integrationAccounts: [], exportCheckpoints: [], importCheckpoints: [],
      objectInventory: [{ assetId: 'asset', versionId: 'v1', checksum, transferState: 'manifest_only' }] });
    const before = structuredClone(manifest);
    await local.repositories.works.create({ ...owner, id: 'work', creatorId: owner.id, title: 'Existing', status: 'draft' });
    assert.equal((await request('/v1/imports/validate', { manifest })).body.plan.valid, true);
    assert.equal((await request('/v1/imports/validate', { manifest, preserveIds: true })).body.plan.valid, false);
    local.database.database.exec("CREATE TRIGGER fail_import BEFORE UPDATE ON ubeeq_records WHEN NEW.repository = 'importCheckpoints' AND json_extract(NEW.payload, '$.state') = 'completed' BEGIN SELECT RAISE(ABORT, 'completion failure'); END");
    assert.equal((await request('/v1/imports', { manifest, importId: 'uuid', dryRun: false })).status, 500);
    local.database.database.exec('DROP TRIGGER fail_import');
    assert.equal((await records('works')).length, 1);
    for (const name of ['assets', 'collections', 'publications', 'moderationHolds']) assert.equal((await records(name)).length, 0);
    assert.equal((await request('/v1/imports', { manifest, importId: 'uuid', dryRun: false })).status, 201);
    const work = (await records('works')).find(record => record.title === 'Imported');
    const [asset] = await records('assets'), [collection] = await records('collections');
    const [publication] = await records('publications'), [hold] = await records('moderationHolds');
    for (const record of [work, asset, collection, publication, hold]) assert.match(record.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(new Set([work.id, asset.id, collection.id, publication.id, hold.id]).size, 5);
    assert.equal(work.creatorId, owner.id); assert.equal(work.status, 'ready');
    assert.equal(asset.workId, work.id); assert.equal(asset.creatorId, owner.id); assert.equal(asset.status, 'pending');
    assert.deepEqual(collection.workIds, [work.id]);
    assert.equal(publication.workId, work.id); assert.equal(publication.status, 'draft'); assert.equal(publication.remoteId, undefined);
    assert.equal(hold.subjectId, work.id);
    const replay = await request('/v1/imports', { manifest, importId: 'uuid', dryRun: false });
    assert.equal(replay.status, 200); assert.equal(replay.body.idempotent, true);
    assert.equal((await records('works')).length, 2);
    assert.deepEqual(await local.repositories.works.get(work.id), work);
    assert.equal((await local.repositories.works.get('work')).title, 'Existing');
    assert.deepEqual(manifest, before);
  } finally { await api.close(); local.database.database.close(); rmSync(directory, { recursive: true, force: true }); }
});
