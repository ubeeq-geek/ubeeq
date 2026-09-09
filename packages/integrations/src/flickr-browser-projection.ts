import type { FlickrMigration } from './flickr-migration-state.js';
import { flickrSourceFailureCode } from './flickr-source-workflow.js';

const safeCode = (value: string | undefined) => value === undefined ? undefined
  : ['ORIGINAL_UNAVAILABLE', 'QUARANTINE_SCAN_BLOCKED'].includes(value) ? value : flickrSourceFailureCode(new Error(value));

/** Authenticated control-plane projection only; admission is the caller's responsibility. */
export const projectFlickrMigrationForBrowser = (migration: FlickrMigration) => {
  const copy = structuredClone(migration);
  return {
    ...copy,
    photos: copy.photos.map(({ remoteUrl, originalSourceUrl, ...photo }) => photo),
    provenance: copy.provenance.map(({ sourceUrl, ...item }) => item),
    items: copy.items.map(({ quarantineObjectKey, errorCode, ...item }) => ({ ...item, errorCode: safeCode(errorCode) })),
    auditEvents: copy.auditEvents.map(event => {
      const details: Record<string, string | number | boolean> = {};
      for (const key of ['photoCount', 'albumCount', 'selectedCount', 'retryCount']) {
        const value = event.details?.[key];
        if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) details[key] = value;
      }
      for (const key of ['complete', 'storageConfirmed']) {
        const value = event.details?.[key]; if (typeof value === 'boolean') details[key] = value;
      }
      const mode = event.details?.mode;
      if (typeof mode === 'string' && ['REFERENCE_IMPORT', 'SELECTED_SOURCE_MIGRATION', 'FULL_CATALOGUE_MIGRATION'].includes(mode)) details.mode = mode;
      const status = event.details?.transferStatus;
      if (typeof status === 'string' && ['NOT_REQUESTED', 'QUEUED', 'QUARANTINED', 'VALIDATED', 'FAILED', 'UNAVAILABLE'].includes(status)) details.transferStatus = status;
      if (event.details?.errorCode !== undefined) details.errorCode = safeCode(String(event.details.errorCode))!;
      return { eventId: event.eventId, action: event.action, remoteId: event.remoteId, occurredAt: event.occurredAt, details };
    })
  };
};
