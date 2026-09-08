import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLocalAdapterSet } from '@ubeeq/adapter-local';
import { createCreatorExport } from '@ubeeq/portability';
import { createReferenceApi } from '../dist/server.js';

test('import checkpoints bind creator and manifest and commit atomically with imported records and audit', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ubeeq-import-checkpoint-'));
  const local = createLocalAdapterSet({ databasePath: join(directory, 'state.sqlite'), dataDirectory: directory, publicBaseUrl: 'http://localhost', cellId: 'cell' });
  const identity = { verifySession: async ({ credential }) => ({ id: credential, subject: { id: credential, roles: [], scopes: [] } }) };
  const api = createReferenceApi({ publicBaseUrl: 'http://127.0.0.1:0', cellId: 'cell', adapters: {
    repositories: local.repositories, storage: local.storage, uploads: local.storage, delivery: local.storage, jobs: local.jobs, identity } });
  await new Promise(resolve => api.server.listen(0, '127.0.0.1', resolve));
  const request = async (path, body, actor = 'owner') => {
    const response = await fetch(`http://127.0.0.1:${api.server.address().port}${path}`, { method: 'POST',
      headers: { authorization: `Bearer ${actor}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  try {
    const owner = (await request('/v1/creators', { handle: 'owner', displayName: 'Owner' })).body.creator;
    const other = (await request('/v1/creators', { handle: 'other', displayName: 'Other' }, 'other')).body.creator;
    const source = { ...owner, id: 'source', subjectId: 'source' };
    const makeManifest = (title = 'Original', id = 'import-work') => createCreatorExport({ exportedAt: '2026-01-01T00:00:00Z', creator: source,
      works: [{ ...owner, id, creatorId: 'source', title, status: 'published' }], assets: [], collections: [], publications: [], publicationIntents: [], processing: [],
      moderationEvidence: [], moderationHolds: [], reviewCases: [], auditEvents: [], usageEvents: [], integrationAccounts: [], exportCheckpoints: [], importCheckpoints: [], objectInventory: [] });
    const manifest = makeManifest();
    const home = { instanceId: other.instanceId, homeCellId: other.homeCellId, dataHomeRegion: other.dataHomeRegion, dataHomeAssignedAt: other.dataHomeAssignedAt, routingRevision: other.routingRevision };
    for (const state of ['planned', 'running', 'failed', 'completed']) {
      const id = `foreign-${state}`;
      const checkpoint = await local.repositories.importCheckpoints.create({ ...home, id, creatorId: other.id, importId: id, state, cursor: manifest.checksum });
      const response = await request('/v1/imports', { manifest, importId: id, dryRun: false });
      assert.equal(response.status, 409); assert.equal(response.body.error.code, 'import_id_conflict');
      assert.equal(response.body.checkpoint, undefined);
      assert.deepEqual(await local.repositories.importCheckpoints.get(id), checkpoint);
    }
    for (const importId of ['', 12, 'x'.repeat(201)]) assert.equal((await request('/v1/imports', { manifest, importId })).status, 400);
    for (const trigger of [
      "CREATE TRIGGER fail_import BEFORE UPDATE ON ubeeq_records WHEN NEW.repository = 'importCheckpoints' AND json_extract(NEW.payload, '$.state') = 'completed' BEGIN SELECT RAISE(ABORT, 'completion failure'); END",
      "CREATE TRIGGER fail_import BEFORE INSERT ON ubeeq_records WHEN NEW.repository = 'auditEvents' AND json_extract(NEW.payload, '$.action') = 'creator.import_completed' BEGIN SELECT RAISE(ABORT, 'audit failure'); END"
    ]) {
      local.database.database.exec(trigger);
      assert.equal((await request('/v1/imports', { manifest, importId: 'owned', dryRun: false })).status, 500);
      local.database.database.exec('DROP TRIGGER fail_import');
      assert.equal(await local.repositories.works.get('import-work'), undefined);
      assert.equal((await local.repositories.importCheckpoints.get('owned')).state, 'failed');
    }
    assert.equal((await request('/v1/imports', { manifest, importId: 'owned', dryRun: false })).status, 201);
    assert.equal((await local.repositories.works.get('import-work')).status, 'ready');
    const replay = await request('/v1/imports', { manifest, importId: 'owned', dryRun: false });
    assert.equal(replay.status, 200); assert.equal(replay.body.idempotent, true);
    const changed = await request('/v1/imports', { manifest: makeManifest('Changed'), importId: 'owned', dryRun: false });
    assert.equal(changed.status, 409); assert.equal(changed.body.error.code, 'import_manifest_conflict');
    assert.equal((await request('/v1/imports', { manifest, importId: 'owned', dryRun: false }, 'other')).body.error.code, 'import_id_conflict');
    const transaction = local.repositories.transaction.bind(local.repositories);
    local.repositories.transaction = async operation => { await transaction(operation); throw new Error('reply lost after commit'); };
    try {
      const recovered = await request('/v1/imports', { manifest: makeManifest('Second', 'second-work'), importId: 'ambiguous', dryRun: false });
      assert.equal(recovered.status, 200); assert.equal(recovered.body.idempotent, true);
      assert.equal(recovered.body.checkpoint.state, 'completed');
      assert.equal((await local.repositories.works.get('second-work')).creatorId, owner.id);
    } finally { local.repositories.transaction = transaction; }
    const events = (await local.repositories.auditEvents.list({ limit: 100 })).items.filter(item => item.action === 'creator.import_completed');
    assert.equal(events.length, 2);
  } finally { await api.close(); local.database.database.close(); rmSync(directory, { recursive: true, force: true }); }
});
