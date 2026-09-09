import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemorySmugMugRepository, SmugMugIntegrationService } from '../dist/index.js';

const image = remoteId => ({ remoteId, galleryId: 'album', title: remoteId, url: 'https://provider.test/image', keywords: [], position: 0, originalAvailable: true, privacy: {}, licence: {} });
const fixture = async (inventory, admission = async () => true) => {
  const calls = { inventory: [], imported: [], downloaded: 0, published: 0 };
  const gateway = {
    startAuthorization: async () => ({ authorizationUrl: 'https://provider.test/auth', credentialRef: 'opaque-request' }),
    completeAuthorization: async () => ({ accountId: 'account', credentialRef: 'opaque-access', capabilities: { inventory: true, originalDownloads: true, exif: false, passwordProtectedGalleries: false } }),
    inventory: async (...args) => { calls.inventory.push(args); return inventory(...args); },
    download: async () => { calls.downloaded++; return { body: Buffer.from('original'), mimeType: 'image/jpeg' }; },
    publish: async () => { calls.published++; throw new Error('Unexpected provider mutation'); }
  };
  const sink = { importReference: async input => { calls.imported.push(input.image.remoteId); },
    findAssetByChecksum: async () => undefined, quarantine: async () => ({ assetId: 'stored', scanPassed: true }) };
  const repository = new InMemorySmugMugRepository();
  const compose = repo => new SmugMugIntegrationService(gateway, sink, repo, undefined, admission);
  const service = compose(repository);
  const { connection } = await service.start('actor', 'creator');
  await service.callback(connection.oauthState, 'verifier');
  return { service, repository, gateway, sink, compose, calls, connectionId: connection.id };
};

test('shared workflow defaults to deny and observes ownership and revoked admission before metadata commits', async () => {
  const denied = new SmugMugIntegrationService({}, {});
  await assert.rejects(denied.start('actor', 'creator'), { code: 'CREATOR_FORBIDDEN' });
  let allowed = true;
  const value = await fixture(async () => { allowed = false; return { images: [image('never-committed')], collections: [] }; }, async () => allowed);
  await assert.rejects(value.service.inventory(value.connectionId, 'other', 'request'), { code: 'CONNECTION_FORBIDDEN' });
  assert.equal(value.calls.inventory.length, 0);
  await assert.rejects(value.service.inventory(value.connectionId, 'actor', 'request'), { code: 'CREATOR_FORBIDDEN' });
  assert.equal(value.repository.images.size, 0); assert.equal(value.repository.migrations.size, 0);
});

test('shared request receipts survive checkpoint restore and newer inventories without provider replay', async () => {
  const value = await fixture(async () => ({ images: [image('one')], collections: [] }));
  const complete = value.repository.completeInventory.bind(value.repository);
  value.repository.completeInventory = async (...args) => { await complete(...args); throw new Error('lost completion reply'); };
  await assert.rejects(value.service.inventory(value.connectionId, 'actor', 'first'), /lost completion reply/);
  const restored = new InMemorySmugMugRepository(); restored.restoreState(value.repository.captureState());
  const service = value.compose(restored);
  const receipt = await service.inventory(value.connectionId, 'actor', 'first');
  assert.equal(receipt.complete, true); assert.equal(receipt.imageCount, 1);
  assert.equal(value.calls.inventory.length, 1); assert.equal(restored.migrations.size, 1);
  const newer = await service.inventory(value.connectionId, 'actor', 'second');
  assert.notEqual(newer.migration.id, receipt.migration.id);
  assert.equal((await service.inventory(value.connectionId, 'actor', 'first')).migration.id, receipt.migration.id);
  assert.equal(value.calls.inventory.length, 2); assert.equal(restored.migrations.size, 2);
});

test('provider continuations remain request-bound and one invocation reads one gateway page', async () => {
  const value = await fixture(async (_ref, cursor) => cursor ? { images: [image('two')], collections: [] } : { images: [image('one')], collections: [], nextCursor: 'next' });
  const first = await value.service.inventory(value.connectionId, 'actor', 'same');
  assert.equal(first.complete, false); assert.equal(value.calls.inventory.length, 1);
  await assert.rejects(value.service.inventory(value.connectionId, 'actor', 'other'), { code: 'INVENTORY_RUN_CONFLICT' });
  const last = await value.service.inventory(value.connectionId, 'actor', 'same');
  assert.equal(last.complete, true); assert.equal(last.imageCount, 2);
  assert.deepEqual(value.calls.inventory, [['opaque-access', undefined], ['opaque-access', 'next']]);
});

test('reference migration checkpoints bounded initialization and processing without downloading or publishing', async () => {
  const value = await fixture(async () => ({ images: Array.from({ length: 101 }, (_, index) => image(`image-${String(index).padStart(3, '0')}`)), collections: [] }));
  assert.equal((await value.service.inventory(value.connectionId, 'actor', 'reference')).complete, false);
  const inventory = await value.service.inventory(value.connectionId, 'actor', 'reference');
  assert.equal(inventory.complete, true); assert.equal(value.calls.inventory.length, 1);
  const initialized = await value.service.confirm(inventory.migration.id, 'actor', 'REFERENCE_ONLY');
  assert.equal(initialized.hasMore, true); assert.deepEqual(initialized.items, []); assert.equal(value.calls.imported.length, 0);
  const restored = new InMemorySmugMugRepository(); restored.restoreState(value.repository.captureState());
  const service = value.compose(restored);
  for (let page = 0; page < 11; page++) {
    const result = await service.resume(inventory.migration.id, 'actor');
    assert.ok(result.items.length <= 10); assert.equal(result.hasMore, page < 10);
    if (page === 10) assert.equal(result.migration.status, 'COMPLETED');
  }
  assert.equal(new Set(value.calls.imported).size, 101); assert.equal(value.calls.imported.length, 101);
  await service.resume(inventory.migration.id, 'actor');
  assert.equal(value.calls.imported.length, 101); assert.equal(value.calls.downloaded, 0); assert.equal(value.calls.published, 0);
});

test('source transfer verifies bytes and preserves quarantine decisions without claiming a hosted asset', async () => {
  const value = await fixture(async () => ({ images: [{ ...image('source'), mimeType: 'image/jpeg' }], collections: [] }));
  value.sink.quarantine = async () => ({ assetId: 'held', scanPassed: false });
  const inventory = await value.service.inventory(value.connectionId, 'actor', 'source');
  const result = await value.service.confirm(inventory.migration.id, 'actor', 'FULL_CATALOGUE_MIGRATION');
  assert.equal(result.migration.status, 'PARTIAL'); assert.equal(result.items[0].state, 'QUARANTINED');
  assert.equal(result.items[0].canonicalAssetId, undefined); assert.equal(value.calls.downloaded, 1); assert.equal(value.calls.published, 0);
});
