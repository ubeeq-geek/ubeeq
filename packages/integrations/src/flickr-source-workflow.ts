import { randomUUID } from 'node:crypto';
import type { FlickrManifestPhoto } from './flickr-metadata.js';
import type { FlickrRepository, FlickrMigration, FlickrMigrationItem, FlickrConnection } from './flickr-migration-state.js';

export class FlickrSourceAdmissionError extends Error {}
// Port failures may contain signed URLs, credentials or private storage details.
// Only exact public codes may enter durable items or audit events.
const transferErrorCodes = new Set([
  'FLICKR_SOURCE_INVALID_BYTE_LIMIT', 'FLICKR_SOURCE_URL_REJECTED',
  'FLICKR_SOURCE_TEMPORARILY_UNAVAILABLE', 'FLICKR_SOURCE_UNAVAILABLE',
  'FLICKR_SOURCE_TOO_LARGE', 'FLICKR_SOURCE_MIME_INVALID', 'FLICKR_SOURCE_TRANSFER_FAILED'
]);
export const flickrSourceFailureCode = (error: unknown): string => {
  if (!(error instanceof Error)) return 'FLICKR_SOURCE_TRANSFER_FAILED';
  // Preserve the reference port's legacy transient signal without persisting free text.
  if (error.message === 'TEMPORARILY_UNAVAILABLE') return 'FLICKR_SOURCE_TEMPORARILY_UNAVAILABLE';
  return transferErrorCodes.has(error.message) ? error.message : 'FLICKR_SOURCE_TRANSFER_FAILED';
};
export interface FlickrQuarantinedSource {
  objectKey: string; checksumSha256: string; mimeType: string; sizeBytes: number;
  scanOutcome: 'pending' | 'clean' | 'blocked';
}
export interface FlickrSourceWorkflowPorts {
  canManageCreator(userId: string, creatorId: string): Promise<boolean>;
  transfer(input: { creatorId: string; migrationId: string; remoteId: string; sourceUrl: string }): Promise<FlickrQuarantinedSource>;
  scanQuarantine(objectKey: string): Promise<'pending' | 'clean' | 'blocked'>;
  /** Called only after a clean verdict and renewed admission. Return true for checksum reuse. */
  attachCleanSource(connection: FlickrConnection, photo: FlickrManifestPhoto, item: FlickrMigrationItem, source: FlickrQuarantinedSource): Promise<boolean>;
}

export class FlickrSourceWorkflow {
  constructor(private repository: FlickrRepository, private ports: FlickrSourceWorkflowPorts) {}
  async run(migration: FlickrMigration, maxItems = 10): Promise<FlickrMigration> {
    if (!Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > 100) throw new Error('Invalid Flickr source batch size');
    if (!migration.mode || migration.mode === 'REFERENCE_IMPORT') return migration;
    if (!migration.confirmedAt || !migration.storageConfirmed) throw new Error('Migration has not been confirmed');
    const connection = await this.repository.getConnection(migration.connectionId);
    if (!connection) throw new FlickrSourceAdmissionError('Flickr connection is no longer available');
    const admit = async () => {
      try {
        const current = await this.repository.getConnection(migration.connectionId);
        if (!current || current.state !== 'CONNECTED' || current.userId !== migration.userId || current.userId !== connection.userId
          || current.creatorId !== connection.creatorId || current.accountId !== connection.accountId
          || !await this.ports.canManageCreator(migration.userId, current.creatorId)) throw new FlickrSourceAdmissionError('Flickr source migration access revoked');
      } catch (error) {
        if (error instanceof FlickrSourceAdmissionError) throw error;
        throw new FlickrSourceAdmissionError('Flickr source migration admission unavailable');
      }
    };
    await admit();
    const start = migration.sourceCursor ?? 0;
    if (!Number.isSafeInteger(start) || start < 0 || start > migration.items.length) throw new Error('Invalid Flickr source cursor');
    const end = Math.min(start + maxItems, migration.items.length);
    const items: FlickrMigrationItem[] = migration.items.slice(0, start);
    for (let index = start; index < end; index++) {
      const item = migration.items[index];
      if (item.transferStatus === 'UNAVAILABLE' || item.transferStatus === 'VALIDATED') { items.push(item); continue; }
      if (item.transferStatus === 'FAILED' && (!item.nextRetryAt || item.retryCount >= 3 || item.nextRetryAt > new Date().toISOString())) { items.push(item); continue; }
      const photo = migration.photos.find((candidate) => candidate.remoteId === item.remoteId);
      if (!photo?.originalSourceUrl) { items.push({ ...item, transferStatus: 'UNAVAILABLE', errorCode: 'ORIGINAL_UNAVAILABLE' }); continue; }
      try {
        await admit();
        const stored: FlickrQuarantinedSource = item.quarantineObjectKey && item.checksumSha256 && item.quarantinedMimeType && item.quarantinedSizeBytes
          ? { objectKey: item.quarantineObjectKey, checksumSha256: item.checksumSha256, mimeType: item.quarantinedMimeType,
            sizeBytes: item.quarantinedSizeBytes, scanOutcome: await this.ports.scanQuarantine(item.quarantineObjectKey) }
          : await this.ports.transfer({ creatorId: connection.creatorId,
            migrationId: migration.migrationId, remoteId: photo.remoteId, sourceUrl: photo.originalSourceUrl });
        const scanOutcome = stored.scanOutcome === 'pending' ? await this.ports.scanQuarantine(stored.objectKey) : stored.scanOutcome;
        await admit();
        if (scanOutcome === 'blocked') {
          items.push({ ...item, transferStatus: 'FAILED', checksumSha256: stored.checksumSha256, quarantineObjectKey: stored.objectKey,
            quarantinedMimeType: stored.mimeType, quarantinedSizeBytes: stored.sizeBytes, scanOutcome, dedupeStatus: 'UNCHECKED',
            retryCount: item.retryCount, errorCode: 'QUARANTINE_SCAN_BLOCKED' });
          continue;
        }
        if (scanOutcome !== 'clean') {
          items.push({ ...item, transferStatus: 'QUARANTINED', checksumSha256: stored.checksumSha256, quarantineObjectKey: stored.objectKey,
            quarantinedMimeType: stored.mimeType, quarantinedSizeBytes: stored.sizeBytes, scanOutcome, dedupeStatus: 'UNCHECKED',
            retryCount: item.retryCount, errorCode: undefined });
          continue;
        }
        const existing = await this.ports.attachCleanSource(connection, photo, item, stored);
        items.push({ ...item, transferStatus: 'VALIDATED', checksumSha256: stored.checksumSha256, quarantineObjectKey: stored.objectKey,
          quarantinedMimeType: stored.mimeType, quarantinedSizeBytes: stored.sizeBytes, scanOutcome, retryCount: item.retryCount,
          dedupeStatus: existing ? 'CHECKSUM_MATCH' : 'UNIQUE', errorCode: undefined, nextRetryAt: undefined });
      } catch (error) {
        if (error instanceof FlickrSourceAdmissionError) throw error;
        const code = flickrSourceFailureCode(error);
        const transient = code === 'FLICKR_SOURCE_TEMPORARILY_UNAVAILABLE';
        const retryCount = item.retryCount + (transient ? 1 : 0);
        items.push({ ...item, transferStatus: code === 'FLICKR_SOURCE_UNAVAILABLE' ? 'UNAVAILABLE' : 'FAILED', retryCount,
          nextRetryAt: transient && retryCount < 3 ? new Date(Date.now() + Math.min(3600, 30 * 2 ** retryCount) * 1000).toISOString() : undefined,
          errorCode: code });
      }
    }
    for (let index = end; index < migration.items.length; index++) items.push(migration.items[index]);
    const complete = items.every((item) => item.transferStatus === 'VALIDATED' || item.transferStatus === 'UNAVAILABLE');
    const transferEvents: FlickrMigration['auditEvents'] = items.flatMap((item) => {
      const previous = migration.items.find((candidate) => candidate.remoteId === item.remoteId);
      if (previous?.transferStatus === item.transferStatus) return [];
      const action = item.transferStatus === 'VALIDATED' ? 'SOURCE_TRANSFERRED'
        : item.transferStatus === 'UNAVAILABLE' ? 'SOURCE_UNAVAILABLE'
          : item.transferStatus === 'FAILED' ? 'SOURCE_FAILED' : undefined;
      return action ? [{ eventId: randomUUID(), action, remoteId: item.remoteId, occurredAt: new Date().toISOString(),
        details: { transferStatus: item.transferStatus, retryCount: item.retryCount, ...(item.errorCode ? { errorCode: item.errorCode } : {}) } }] : [];
    });
    const updated: FlickrMigration = { ...migration, items, auditEvents: [...(migration.auditEvents || []), ...transferEvents],
      sourceCursor: complete || end === migration.items.length ? 0 : end,
      status: complete ? 'COMPLETE' : end < migration.items.length ? 'RUNNING' : 'REVIEW', updatedAt: new Date().toISOString() };
    await admit();
    await this.repository.putMigration(updated); return updated;
  }
}
