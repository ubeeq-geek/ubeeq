import test from 'node:test';
import assert from 'node:assert/strict';
import { createCreatorExport, validateCreatorExport, remapCreatorExportForImport, restorePublicationImageRecord } from '../dist/index.js';
import { inheritedPublicationImageSelection, resolvePublicationImageSelection } from '@ubeeq/core';
const cell = { homeCellId: 'cell', dataHomeRegion: 'region', dataHomeAssignedAt: '2026-01-01T00:00:00.000Z', routingRevision: 1 };
const base = { ...cell, revision: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', instanceId: 'instance' };
const evidence = { operationId: 'operation', confirmedAt: base.createdAt, imageFingerprint: 'a'.repeat(64), sourceAssetId: 'asset', sourceChecksum: 'b'.repeat(64),
  fileChecksum: 'c'.repeat(64), sizeBytes: 1000, mimeType: 'image/jpeg', width: 1000, height: 800, variant: 'share', recipeFingerprint: 'd'.repeat(64) };
const publication = (id, imageSelection) => ({ ...base, id, workId: 'work', destination: 'deviantart', status: 'live', remoteId: `remote-${id}`,
  ...(imageSelection ? { imageSelection, configurationRevision: 7 } : {}), lastConfirmedImage: { ...evidence, fileReference: 'private-storage-reference' },
  activeOperationId: 'operation', executionPolicy: { schemaVersion: 1 }, preparationVersion: 1, account: { remoteAccountId: 'principal' },
  lease: 'active-lease', previewToken: 'private-preview-token', outbox: ['queued'], approvedSnapshot: { fileReference: 'private-storage-reference' } });
const manifest = () => createCreatorExport({ exportedAt: base.createdAt,
  creator: { ...base, id: 'creator', handle: 'creator', displayName: 'Creator' },
  works: [{ ...base, id: 'work', creatorId: 'creator', title: 'Image', status: 'ready' }],
  assets: [{ ...base, id: 'asset', creatorId: 'creator', workId: 'work', mimeType: 'image/jpeg', checksum: 'b'.repeat(64), objectVersion: 'v1', status: 'ready' }],
  collections: [{ ...base, id: 'collection', creatorId: 'creator', title: 'Collection', visibility: 'private' }],
  publications: [publication('preview', { ...inheritedPublicationImageSelection(), variant: { mode: 'override', value: 'share' }, context: { mode: 'collection', collectionId: 'collection' } }),
    publication('original', { ...inheritedPublicationImageSelection(), variant: { mode: 'override', value: 'original' } }),
    publication('volume', { ...inheritedPublicationImageSelection(), variant: { mode: 'override', value: 'watermarked-original' }, watermark: { mode: 'override', value: { text: 'Volume' } }, context: { mode: 'collection', collectionId: 'missing' } }), publication('legacy')],
  publicationIntents: [], processing: [], moderationEvidence: [], moderationHolds: [], reviewCases: [], auditEvents: [], usageEvents: [], integrationAccounts: [], exportCheckpoints: [], importCheckpoints: [],
  objectInventory: [{ assetId: 'asset', versionId: 'v1', checksum: 'b'.repeat(64), transferState: 'manifest_only' }] });

test('export preserves explicit presence, revisions and history while excluding private files and execution authority', () => {
  const exported = manifest(); validateCreatorExport(exported);
  const text = JSON.stringify(exported);
  for (const forbidden of ['private-storage-reference', 'active-lease', 'private-preview-token', 'approvedSnapshot', 'activeOperationId', 'preparationVersion', 'remoteAccountId']) assert.equal(text.includes(forbidden), false);
  assert.equal(exported.publications[0].imageSelection.variant.value, 'share');
  assert.equal(exported.publications[1].imageSelection.variant.value, 'original');
  assert.equal(exported.publications[2].imageSelection.watermark.value.text, 'Volume');
  assert.equal(exported.publications[3].imageSelection, undefined); assert.equal(exported.publications[3].configurationRevision, undefined);
});

test('restore remaps explicit contexts and source evidence, preserves missing contexts as blocked, and disconnects every remote binding', async () => {
  let next = 0; const { manifest: restored, idMap } = remapCreatorExportForImport(manifest(), { targetCreatorId: 'new-creator', uuid: () => `new-${++next}` });
  validateCreatorExport(restored);
  const [preview, original, volume] = restored.publications;
  assert.equal(preview.imageSelection.context.collectionId, idMap.collections.collection);
  assert.equal(preview.restoredPublicationHistory.image.sourceAssetId, idMap.assets.asset);
  assert.equal(preview.restoredPublicationHistory.remoteId, 'remote-preview');
  assert.equal(original.imageSelection.variant.value, 'original');
  assert.equal(volume.configurationRevision, 7); assert.equal(volume.unresolvedImageContext.sourceCollectionId, 'missing');
  for (const p of restored.publications) { assert.equal(p.status, 'draft'); assert.equal(p.remoteId, undefined); assert.equal(p.lastConfirmedImage, undefined); assert.equal(p.activeOperationId, undefined); }
  // Even a destination collection coincidentally using the old ID cannot resolve an unmapped context.
  const resolved = await resolvePublicationImageSelection({
    work: { tenantId: 'target', creatorId: 'creator', workId: 'work', preferences: {} },
    publication: { ...volume, tenantId: 'target', creatorId: 'creator', workId: 'work', publicationId: volume.id, connectionId: 'connection' },
    creator: { tenantId: 'target', creatorId: 'creator', preferences: {} }, connection: { tenantId: 'target', creatorId: 'creator', connectionId: 'connection', destination: 'deviantart' },
    collections: [{ tenantId: 'target', creatorId: 'creator', collectionId: 'missing', workIds: ['work'], preferences: {} }],
    platform: { variant: 'original' }, variants: { 'watermarked-original': { enabled: true, available: true, recipeFingerprint: 'recipe' } }, validateWatermark: v => v
  });
  assert.deepEqual(resolved.blockers, ['publication_context_unavailable']);
});

test('restore cannot invent a Publication or Work mapping and ignores injected execution fields', () => {
  assert.throws(() => restorePublicationImageRecord(publication('p'), { publications: {}, works: {}, assets: {}, collections: {} }), /mappings/);
  const restored = restorePublicationImageRecord(publication('p'), { publications: { p: 'target-p' }, works: { work: 'target-work' }, assets: {}, collections: {} });
  assert.equal(restored.preparationVersion, undefined); assert.equal(restored.executionPolicy, undefined); assert.equal(restored.remoteId, undefined);
});
