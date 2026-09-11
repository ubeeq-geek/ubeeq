import test from 'node:test';
import assert from 'node:assert/strict';
import { projectFlickrMigrationForBrowser } from '../dist/index.js';

test('browser projection redacts historical errors, private source URLs and quarantine keys without rewriting history', () => {
  const input = { migrationId: 'migration', photos: [{ remoteId: 'p', title: 'Title', tags: ['tag'], remoteUrl: 'private-page', originalSourceUrl: 'private-source' }],
    provenance: [{ remotePhotoId: 'p', sourceUrl: 'private-provenance', licenceSnapshot: 'licence' }],
    items: [{ remoteId: 'p', transferStatus: 'FAILED', quarantineObjectKey: 'private-key', errorCode: 'raw-private-error', retryCount: 1 }],
    auditEvents: [{ eventId: 'event', action: 'SOURCE_FAILED', occurredAt: 'now', details: { errorCode: 'raw-private-error',
      retryCount: 1, transferStatus: 'FAILED', providerMessage: 'private-message', sourceUrl: 'private-audit-url' } }] };
  const before = structuredClone(input), result = projectFlickrMigrationForBrowser(input);
  assert.doesNotMatch(JSON.stringify(result), /private-|raw-private-error/);
  assert.equal(result.items[0].errorCode, 'FLICKR_SOURCE_TRANSFER_FAILED');
  assert.deepEqual(result.auditEvents[0].details, { errorCode: 'FLICKR_SOURCE_TRANSFER_FAILED', retryCount: 1, transferStatus: 'FAILED' });
  result.photos[0].tags.push('changed'); assert.deepEqual(input, before);
});

test('known failure codes and typed progress audit details survive projection', () => {
  for (const code of ['QUARANTINE_SCAN_BLOCKED', 'ORIGINAL_UNAVAILABLE', 'FLICKR_SOURCE_TOO_LARGE', 'FLICKR_SOURCE_TEMPORARILY_UNAVAILABLE']) {
    const result = projectFlickrMigrationForBrowser({ photos: [], provenance: [], items: [{ errorCode: code }], auditEvents: [{
      eventId: 'e', action: 'MIGRATION_CONFIRMED', occurredAt: 'now', details: { mode: 'REFERENCE_IMPORT', selectedCount: 2, storageConfirmed: false, errorCode: code, photoCount: 'private-string' }
    }] });
    assert.equal(result.items[0].errorCode, code); assert.equal(result.auditEvents[0].details.errorCode, code);
    assert.equal(result.auditEvents[0].details.mode, 'REFERENCE_IMPORT'); assert.equal(result.auditEvents[0].details.selectedCount, 2);
    assert.equal(result.auditEvents[0].details.photoCount, undefined);
  }
});
