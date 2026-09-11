import { randomUUID } from 'node:crypto';
import type { FlickrManifestPhoto } from './flickr-metadata.js';
import type { FlickrRepository, FlickrConnection, FlickrMigration, FlickrMigrationMode, FlickrExternalCollection, FlickrPublication } from './flickr-migration-state.js';

/** Application-owned content writes. No provider mutation or source transfer. */
export type FlickrReferenceMaterializer = (migration: FlickrMigration, connection: FlickrConnection, photos: FlickrManifestPhoto[]) => Promise<void>;

/** Inventory and confirmation mechanics; applications must admit the caller first. */
export class FlickrInventoryService {
  constructor(private repository: FlickrRepository, private materializeReferences: FlickrReferenceMaterializer) {}

  async inventory(connection: FlickrConnection, photos: FlickrManifestPhoto[], cursor?: string, albums?: FlickrExternalCollection[], append = false): Promise<FlickrMigration> {
    const now = new Date().toISOString();
    const previous = await this.repository.getMigrationByConnection(connection.connectionId);
    const previousPhotos = new Map(previous?.photos.map((photo) => [photo.remoteId, photo]));
    const mergedPhotos = append && previous ? [...previous.photos.filter((photo) => !photos.some((next) => next.remoteId === photo.remoteId)), ...photos] : photos;
    const publications = mergedPhotos.map((photo): FlickrPublication => {
      const oldPhoto = previousPhotos.get(photo.remoteId);
      return {
        remotePhotoId: photo.remoteId,
        workId: previous?.publications.find((item) => item.remotePhotoId === photo.remoteId)?.workId
          || `flickr-${connection.accountId}-${photo.remoteId}`,
        visibilitySnapshot: photo.visibility,
        licenceSnapshot: photo.licence,
        metadataHash: photo.metadataHash,
        state: oldPhoto && oldPhoto.metadataHash !== photo.metadataHash ? 'REMOTE_CHANGED' : 'ACTIVE',
        lastSyncAt: now
      };
    });
    if (!append && !cursor && previous) {
      publications.push(...previous.publications.filter((item) => !photos.some((photo) => photo.remoteId === item.remotePhotoId)).map((item) => ({ ...item, state: 'MISSING' as const, lastSyncAt: now })));
    }
    const migration: FlickrMigration = {
      migrationId: previous?.migrationId || randomUUID(), connectionId: connection.connectionId, userId: connection.userId,
      status: 'INVENTORY_READY', cursor, storageConfirmed: false, discoveryEnabled: false,
      photos: mergedPhotos, albums: albums !== undefined ? albums.map(album => {
        const prior = previous?.albums.find(item => item.remoteAlbumId === album.remoteAlbumId);
        return { remoteAlbumId: album.remoteAlbumId, title: album.title, description: album.description,
          orderedRemotePhotoIds: [...album.orderedRemotePhotoIds], mappedCollectionId: prior?.mappedCollectionId,
          reconciliation: prior?.reconciliation };
      }) : (previous?.albums || []), publications,
      provenance: mergedPhotos.map((photo) => ({ remotePhotoId: photo.remoteId, sourceUrl: photo.remoteUrl,
        accountId: connection.accountId, originalFilename: photo.originalFilename, licenceSnapshot: photo.licence,
        importedAt: previous?.provenance.find((item) => item.remotePhotoId === photo.remoteId)?.importedAt || now,
        creatorAttestedOwnership: true })),
      items: previous?.items || [], estimatedBytes: mergedPhotos.some((p) => p.originalSizeBytes !== undefined)
        ? mergedPhotos.reduce((total, photo) => total + (photo.originalSizeBytes || 0), 0) : undefined,
      auditEvents: [...(previous?.auditEvents || []), { eventId: randomUUID(), action: 'INVENTORY_CAPTURED', occurredAt: now,
        details: { photoCount: mergedPhotos.length, albumCount: albums?.length ?? previous?.albums.length ?? 0, complete: !cursor } }],
      createdAt: previous?.createdAt || now, updatedAt: now
    };
    await this.repository.putMigration(migration);
    await this.repository.putConnection({ ...connection, lastInventoryAt: now,
      capabilities: { ...connection.capabilities,
        originals: connection.capabilities.originals || mergedPhotos.some(photo => photo.originalAvailable) } });
    return migration;
  }

  async confirm(migration: FlickrMigration, mode: FlickrMigrationMode, selectedIds: string[], storageConfirmed: boolean): Promise<FlickrMigration> {
    if (!['REFERENCE_IMPORT', 'SELECTED_SOURCE_MIGRATION', 'FULL_CATALOGUE_MIGRATION'].includes(mode)) throw new Error('A valid migration mode is required');
    if (migration.status !== 'INVENTORY_READY' && migration.status !== 'REVIEW') throw new Error('Migration cannot be confirmed in its current state');
    const selected = mode === 'FULL_CATALOGUE_MIGRATION' || mode === 'REFERENCE_IMPORT'
      ? migration.photos
      : migration.photos.filter((p) => selectedIds.includes(p.remoteId));
    if (mode !== 'REFERENCE_IMPORT' && !storageConfirmed) throw new Error('Storage and cost confirmation is required for source migration');
    if (mode === 'SELECTED_SOURCE_MIGRATION' && selected.length === 0) throw new Error('Select at least one Flickr photo');
    const now = new Date().toISOString();
    const updated: FlickrMigration = { ...migration, mode, status: 'CONFIRMED', confirmedAt: now, storageConfirmed, updatedAt: now,
      items: selected.map((photo) => ({ remoteId: photo.remoteId, mode,
        sourceQuality: mode === 'REFERENCE_IMPORT' ? undefined : (photo.originalAvailable ? 'original' : 'highest_available'),
        transferStatus: mode === 'REFERENCE_IMPORT' ? 'NOT_REQUESTED' : (photo.originalAvailable ? 'QUEUED' : 'UNAVAILABLE'),
        dedupeStatus: 'UNCHECKED', retryCount: 0, errorCode: mode !== 'REFERENCE_IMPORT' && !photo.originalAvailable ? 'ORIGINAL_UNAVAILABLE' : undefined })) };
    const connection = await this.repository.getConnection(migration.connectionId);
    if (!connection) throw new Error('Flickr connection is no longer available');
    if (mode !== 'REFERENCE_IMPORT' && !connection.capabilities.originals) throw new Error('Flickr did not provide any eligible original source files; use reference import instead');
    await this.materializeReferences(updated, connection, selected);
    updated.auditEvents = [...(updated.auditEvents || []), { eventId: randomUUID(), action: 'MIGRATION_CONFIRMED', occurredAt: now,
      details: { mode, selectedCount: selected.length, storageConfirmed } }];
    await this.repository.putMigration(updated);
    return updated;
  }
}
