import { assertPublicationConfigurationRevision, assertPublicationCopyIdentity, isPublicationIdentifier, validatePublicationImageDeliveryEvidence,
  validatePublicationImageSelection, type PublicationCopyIdentity, type PublicationImageDeliveryEvidence } from '@ubeeq/core';
import type { PublicationRecord } from '@ubeeq/persistence';

/** Only portable content and historical evidence; excludes execution authority and private file references. */
export function portablePublicationImageRecord(record: PublicationRecord): PublicationRecord {
  const { id, revision, createdAt, updatedAt, homeCellId, dataHomeRegion, dataHomeAssignedAt, routingRevision,
    instanceId, workId, destination, status, remoteId, imageSelection, configurationRevision, unresolvedImageContext, lastConfirmedImage, restoredPublicationHistory } = record;
  const evidence = (image: PublicationImageDeliveryEvidence | undefined): PublicationImageDeliveryEvidence | undefined => image && ({
    operationId: image.operationId, confirmedAt: image.confirmedAt, imageFingerprint: image.imageFingerprint, sourceAssetId: image.sourceAssetId,
    sourceChecksum: image.sourceChecksum, fileChecksum: image.fileChecksum, sizeBytes: image.sizeBytes, mimeType: image.mimeType,
    width: image.width, height: image.height, variant: image.variant, recipeFingerprint: image.recipeFingerprint,
    ...(image.watermarkFingerprint ? { watermarkFingerprint: image.watermarkFingerprint } : {})
  });
  const copy = (record as PublicationRecord & { copy?: PublicationCopyIdentity }).copy ?? restoredPublicationHistory?.copy;
  const history = restoredPublicationHistory || copy ? { sourcePublicationId: restoredPublicationHistory?.sourcePublicationId ?? id,
    ...(restoredPublicationHistory?.remoteId ? { remoteId: restoredPublicationHistory.remoteId } : {}),
    ...(restoredPublicationHistory?.image ? { image: evidence(restoredPublicationHistory.image) } : {}), ...(copy ? { copy } : {}) } : undefined;
  return structuredClone({ id, revision, createdAt, updatedAt, homeCellId, dataHomeRegion, dataHomeAssignedAt, routingRevision,
    instanceId, workId, destination, status, ...(remoteId !== undefined ? { remoteId } : {}),
    ...(imageSelection !== undefined ? { imageSelection } : {}), ...(configurationRevision !== undefined ? { configurationRevision } : {}),
    ...(unresolvedImageContext ? { unresolvedImageContext: { sourceCollectionId: unresolvedImageContext.sourceCollectionId } } : {}),
    ...(lastConfirmedImage ? { lastConfirmedImage: evidence(lastConfirmedImage) } : {}), ...(history ? { restoredPublicationHistory: history } : {}) });
}
/** Envelope validation only: the destination still applies its own watermark schema before execution. */
export function validatePortablePublicationImage(record: PublicationRecord): void {
  assertPublicationConfigurationRevision(record.configurationRevision);
  if (record.imageSelection !== undefined) validatePublicationImageSelection(record.imageSelection, value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid portable watermark settings.');
    return value as Record<string, unknown>;
  });
  if (record.unresolvedImageContext && !isPublicationIdentifier(record.unresolvedImageContext.sourceCollectionId)) throw new Error('Invalid unresolved image context.');
  if (record.lastConfirmedImage) validatePublicationImageDeliveryEvidence(record.lastConfirmedImage);
  if (record.restoredPublicationHistory?.image) validatePublicationImageDeliveryEvidence(record.restoredPublicationHistory.image);
  if (record.restoredPublicationHistory?.copy) assertPublicationCopyIdentity(record.restoredPublicationHistory.copy);
}
export function restorePublicationImageRecord(record: PublicationRecord, maps: {
  publications: Readonly<Record<string, string>>; works: Readonly<Record<string, string>>;
  assets: Readonly<Record<string, string>>; collections: Readonly<Record<string, string>>;
}): PublicationRecord {
  const source = portablePublicationImageRecord(record);
  if (!maps.publications[source.id] || !maps.works[source.workId]) throw new Error('Publication and Work restore mappings are required.');
  const imageSelection = source.imageSelection && structuredClone(source.imageSelection);
  let unresolvedImageContext = source.unresolvedImageContext;
  if (imageSelection?.context.mode === 'collection') {
    const original = imageSelection.context.collectionId, mapped = maps.collections[original];
    if (mapped && !unresolvedImageContext) imageSelection.context.collectionId = mapped;
    else unresolvedImageContext = { sourceCollectionId: unresolvedImageContext?.sourceCollectionId ?? original };
  }
  const remapEvidence = (evidence: PublicationImageDeliveryEvidence | undefined) => evidence && { ...evidence,
    sourceAssetId: maps.assets[evidence.sourceAssetId] ?? evidence.sourceAssetId };
  const { remoteId, lastConfirmedImage, restoredPublicationHistory, ...rest } = source;
  return { ...rest, id: maps.publications[source.id], workId: maps.works[source.workId], status: 'draft',
    ...(imageSelection ? { imageSelection } : {}), ...(unresolvedImageContext ? { unresolvedImageContext } : {}),
    restoredPublicationHistory: { sourcePublicationId: restoredPublicationHistory?.sourcePublicationId ?? source.id,
      ...(restoredPublicationHistory?.copy ? { copy: restoredPublicationHistory.copy } : {}),
      ...(remoteId || restoredPublicationHistory?.remoteId ? { remoteId: remoteId ?? restoredPublicationHistory?.remoteId } : {}),
      ...(lastConfirmedImage || restoredPublicationHistory?.image ? { image: remapEvidence(lastConfirmedImage ?? restoredPublicationHistory?.image) } : {}) } };
}
