import test from 'node:test';
import assert from 'node:assert/strict';
import { FlickrInventoryService, InMemoryFlickrRepository, normalizeFlickrPhoto } from '../dist/index.js';

const connection = { connectionId: 'connection', userId: 'user', creatorId: 'creator', accountId: 'account',
  capabilities: { inventory: true, originals: true }, state: 'CONNECTED' };
const photo = (remoteId, title = remoteId) => normalizeFlickrPhoto({ remoteId, title, remoteUrl: 'https://example.invalid/photo',
  tags: [], albumIds: [], visibility: 'private', originalAvailable: true, originalSizeBytes: 42 });
const setup = async (materialize = async () => {}) => {
  const repository = new InMemoryFlickrRepository();
  await repository.putConnection(connection);
  return { repository, service: new FlickrInventoryService(repository, materialize) };
};

test('inventory appends pages without marking absent earlier photos missing and retains canonical mappings', async () => {
  const { repository, service } = await setup();
  const first = await service.inventory(connection, [photo('a')], '2');
  first.publications[0].workId = 'canonical-a';
  await repository.putMigration(first);
  const appended = await service.inventory(connection, [photo('b')], undefined, [], true);
  assert.deepEqual(appended.photos.map(p => p.remoteId), ['a', 'b']);
  assert.equal(appended.publications[0].workId, 'canonical-a');
  assert.equal(appended.estimatedBytes, 84);
  assert.equal(appended.discoveryEnabled, false);
  const refreshed = await service.inventory(connection, [photo('a', 'changed')]);
  assert.equal(refreshed.publications.find(p => p.remotePhotoId === 'a').state, 'REMOTE_CHANGED');
  assert.equal(refreshed.publications.find(p => p.remotePhotoId === 'b').state, 'MISSING');
  assert.equal(refreshed.provenance[0].importedAt, first.provenance[0].importedAt);
});

test('inventory trusts saved collection mapping and reconciliation, not incoming provider fields', async () => {
  const { repository, service } = await setup();
  const album = { remoteAlbumId: 'album', title: 'Album', orderedRemotePhotoIds: ['a'] };
  const first = await service.inventory(connection, [photo('a')], undefined, [album]);
  first.albums[0].mappedCollectionId = 'canonical-album';
  first.albums[0].reconciliation = { baseline: { title: 'Baseline' } };
  await repository.putMigration(first);
  const updated = await service.inventory(connection, [photo('a')], undefined,
    [{ ...album, mappedCollectionId: 'untrusted', reconciliation: { baseline: {} } }]);
  assert.equal(updated.albums[0].mappedCollectionId, 'canonical-album');
  assert.deepEqual(updated.albums[0].reconciliation, first.albums[0].reconciliation);
});

test('confirmation validates mode, state, selection, storage and original capability before content writes', async () => {
  let writes = 0;
  const { repository, service } = await setup(async () => { writes++; });
  const inventory = await service.inventory(connection, [photo('a')]);
  await assert.rejects(service.confirm(inventory, 'invalid', [], false), /valid migration mode/);
  await assert.rejects(service.confirm({ ...inventory, status: 'COMPLETE' }, 'REFERENCE_IMPORT', [], false), /current state/);
  await assert.rejects(service.confirm(inventory, 'FULL_CATALOGUE_MIGRATION', [], false), /Storage and cost/);
  await assert.rejects(service.confirm(inventory, 'SELECTED_SOURCE_MIGRATION', [], true), /Select at least one/);
  await repository.putConnection({ ...connection, capabilities: { originals: false } });
  await assert.rejects(service.confirm(inventory, 'FULL_CATALOGUE_MIGRATION', [], true), /eligible original/);
  assert.equal(writes, 0);
  assert.equal((await repository.getMigration(inventory.migrationId)).status, 'INVENTORY_READY');
  const confirmed = await service.confirm(inventory, 'REFERENCE_IMPORT', [], false);
  assert.equal(writes, 1);
  assert.equal(confirmed.items[0].transferStatus, 'NOT_REQUESTED');
});

test('confirmation materializes selected references before saving confirmation and propagates failures', async () => {
  let fail = true;
  const { repository, service } = await setup(async (migration, owner, photos) => {
    assert.equal(owner.creatorId, connection.creatorId);
    assert.deepEqual(photos.map(p => p.remoteId), ['b']);
    assert.equal((await repository.getMigration(migration.migrationId)).status, 'INVENTORY_READY');
    if (fail) throw new Error('content write failed');
    migration.publications.find(p => p.remotePhotoId === 'b').workId = 'canonical-b';
  });
  const inventory = await service.inventory(connection, [photo('a'), photo('b')]);
  await assert.rejects(service.confirm(inventory, 'SELECTED_SOURCE_MIGRATION', ['b'], true), /content write failed/);
  assert.equal((await repository.getMigration(inventory.migrationId)).status, 'INVENTORY_READY');
  fail = false;
  const confirmed = await service.confirm(inventory, 'SELECTED_SOURCE_MIGRATION', ['b'], true);
  assert.equal(confirmed.items.length, 1);
  assert.equal(confirmed.items[0].transferStatus, 'QUEUED');
  assert.equal((await repository.getMigration(inventory.migrationId)).publications[1].workId, 'canonical-b');
  assert.equal(confirmed.auditEvents.at(-1).action, 'MIGRATION_CONFIRMED');
});
