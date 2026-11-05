import { assertPublicationConfigurationRevision, assertPublicationCopyIdentity, PublicationImageError, validatePublicationImageSelection,
  validatePublicationImageReviewSnapshot } from '@ubeeq/core';
import { publicationIdentityHash } from './publication-copies.js';
import type { ManagedPublicationRecord, PublicationDeliveryRecord } from './publication-commands.js';

/** Shared adapter boundary: generic status writers cannot erase desired settings or immutable identities. */
export function assertManagedPublicationWrite(previous: ManagedPublicationRecord | undefined, next: ManagedPublicationRecord) {
  assertPublicationConfigurationRevision(next.configurationRevision);
  if (next.imageSelection !== undefined) validatePublicationImageSelection(next.imageSelection, value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PublicationImageError('invalid_request', 'Invalid watermark settings.');
    return value as Record<string, unknown>;
  });
  if (!previous) return;
  const before = publicationIdentityHash([previous.imageSelection, previous.unresolvedImageContext]);
  const after = publicationIdentityHash([next.imageSelection, next.unresolvedImageContext]);
  if (before !== after ? next.configurationRevision !== (previous.configurationRevision ?? 0) + 1
    : (next.configurationRevision ?? 0) !== (previous.configurationRevision ?? 0)) throw new PublicationImageError('publication_revision_conflict', 'Image configuration must advance its independent revision exactly once.');
  if (previous.copy && publicationIdentityHash(previous.copy) !== publicationIdentityHash(next.copy)) throw new PublicationImageError('publication_identity_conflict', 'Legacy copy identity is immutable.');
  if (next.copy) assertPublicationCopyIdentity(next.copy);
  if (previous.preparationVersion === 1 && publicationIdentityHash([previous.instanceId, previous.creatorId, previous.workId, previous.destination,
    previous.account, previous.connectionId, previous.preparationVersion, previous.executionPolicy]) !== publicationIdentityHash([next.instanceId,
      next.creatorId, next.workId, next.destination, next.account, next.connectionId, next.preparationVersion, next.executionPolicy])) {
    throw new PublicationImageError('publication_identity_conflict', 'Prepared Publication identity requires an explicit verified rebinding command.');
  }
}

/** The operation's approved inputs are immutable even through a generic repository update. */
export function assertPublicationDeliveryWrite(previous: PublicationDeliveryRecord | undefined, next: PublicationDeliveryRecord) {
  const op = next.operation;
  validatePublicationImageReviewSnapshot(op?.snapshot);
  if (op.schemaVersion !== 1 || op.operationId !== next.id || op.publicationId !== op.snapshot.publicationId
    || op.snapshot.workId !== next.workId || !Number.isSafeInteger(op.fencingGeneration) || op.fencingGeneration < 0
    || publicationIdentityHash(op.snapshot) !== op.reviewFingerprint) throw new PublicationImageError('publication_review_stale', 'Invalid immutable operation snapshot.');
  if (!previous) {
    if (op.state !== 'PREPARED' || op.fencingGeneration !== 0 || op.dispatchedAt || op.lease || op.remoteId) throw new PublicationImageError('publication_review_stale', 'New operations require undispatched approval.');
    return;
  }
  const before = previous.operation;
  const immutable = (record: PublicationDeliveryRecord) => [record.instanceId, record.creatorId, record.workId, record.operation.operationId,
    record.operation.publicationId, record.operation.schemaVersion, record.operation.kind, record.operation.snapshot, record.operation.reviewFingerprint];
  if (publicationIdentityHash(immutable(previous)) !== publicationIdentityHash(immutable(next))) throw new PublicationImageError('publication_review_stale', 'Approved operation inputs are immutable.');
  const transitions: Record<string, readonly string[]> = { PREPARED: ['IN_FLIGHT', 'CANCELLED'], IN_FLIGHT: ['CONFIRMED', 'FAILED', 'AMBIGUOUS'], AMBIGUOUS: ['CONFIRMED', 'AMBIGUOUS'] };
  if (!transitions[before.state]?.includes(op.state) || op.fencingGeneration < before.fencingGeneration || op.fencingGeneration > before.fencingGeneration + 1
    || before.dispatchedAt && before.dispatchedAt !== op.dispatchedAt
    || (op.fencingGeneration !== before.fencingGeneration ? !['IN_FLIGHT', 'AMBIGUOUS'].includes(op.state)
      : publicationIdentityHash(op.lease) !== publicationIdentityHash(before.lease))) {
    throw new PublicationImageError('publication_reconciliation_required', 'Invalid operation transition or fencing generation.');
  }
}
