import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createCreatorExport } from '@ubeeq/portability';
import { createMigrationCellEndpoint } from '../dist/migration-cell.js';

const make = (patch = {}) => createCreatorExport({ exportedAt: '2026-01-01T00:00:00Z', creator: {
  id: 'creator', instanceId: 'source', homeCellId: 'source-cell', dataHomeRegion: 'source-region', routingRevision: 1,
  dataHomeAssignedAt: '2026-01-01T00:00:00Z', ...patch
}, works: [], assets: [], collections: [], publications: [], publicationIntents: [], processing: [], moderationEvidence: [],
  moderationHolds: [], reviewCases: [], auditEvents: [], usageEvents: [], integrationAccounts: [], exportCheckpoints: [], importCheckpoints: [], objectInventory: [] });
const digest = body => createHash('sha256').update(body).digest('hex');
test('regional import checks actual manifest bytes and checkpoint binding before repository access', async () => {
  const manifest = make(), body = Buffer.from(JSON.stringify(manifest));
  const checkpoint = { id: 'migration', creatorId: 'creator', createdAt: '2026-01-01T00:00:00Z', manifestChecksum: manifest.checksum,
    source: { homeCellId: 'source-cell', homeRegion: 'source-region', routingRevision: 1 }, destination: { cellId: 'target-cell' },
    objectInventory: [{ id: 'migration-manifest', destination: { bucket: 'target', key: 'manifest' }, checksum: digest(body), byteLength: body.length }] };
  let bytes = body, reads = 0;
  const repositories = new Proxy({}, { get() { assert.fail('Invalid manifest must not touch repositories'); } });
  const endpoint = createMigrationCellEndpoint({ cellId: 'target-cell', region: 'target-region', instanceId: 'target', repositories,
    storage: { async get(location) { reads++; assert.deepEqual(location, { bucket: 'target', key: 'manifest' }); return { body: bytes }; } } });
  bytes = Buffer.from(body); bytes[0] = 0;
  await assert.rejects(endpoint.execute({ operation: 'import', checkpoint }), /manifest bytes/);
  bytes = Buffer.concat([body, Buffer.from(' ')]);
  await assert.rejects(endpoint.execute({ operation: 'import', checkpoint }), /manifest bytes/);
  bytes = body;
  await assert.rejects(endpoint.execute({ operation: 'import', checkpoint: { ...checkpoint, manifestChecksum: 'b'.repeat(64) } }), /manifest checksum/);
  for (const patch of [{ id: 'foreign' }, { homeCellId: 'foreign' }, { dataHomeRegion: 'foreign' }]) {
    const changed = make(patch); bytes = Buffer.from(JSON.stringify(changed));
    const changedCheckpoint = { ...checkpoint, manifestChecksum: changed.checksum, objectInventory: [{ ...checkpoint.objectInventory[0], checksum: digest(bytes), byteLength: bytes.length }] };
    await assert.rejects(endpoint.execute({ operation: 'import', checkpoint: changedCheckpoint }), /creator does not match|source home/);
  }
  assert.equal(reads, 6);
});
