import type { PublicationAccountIdentity, PublicationOperation } from './publication-copy.js';
import { isPublicationIdentifier, PUBLICATION_IMAGE_VARIANTS, PublicationImageError, publicationImageCanonicalJson, type PublicationImageDeliveryEvidence, type PublicationImageVariant, type PublicationWatermarkSettings } from './publication-image.js';

/** Server-created approval. fileReference is private and must never enter a general read model or export. */
export interface PublicationImageReviewSnapshot {
  schemaVersion: 1;
  publicationId: string;
  workId: string;
  configurationRevision: number;
  workRevision: number;
  connectionId: string;
  account: PublicationAccountIdentity;
  metadata: Readonly<Record<string, unknown>>;
  metadataFingerprint: string;
  dependencyFingerprint: string;
  imageFingerprint: string;
  source: { assetId: string; checksum: string };
  file: { fileReference: string; checksum: string; sizeBytes: number; mimeType: string; width: number; height: number };
  variant: PublicationImageVariant;
  imageChoice: 'saved' | 'operation';
  recipeFingerprint: string;
  watermark?: PublicationWatermarkSettings;
  watermarkFingerprint?: string;
  collectionId?: string;
  targets: readonly { id: string; access: string }[];
  desiredStatus: 'draft' | 'live' | 'scheduled';
}
export interface PublicationDeliveryOperation {
  operationId: string;
  publicationId: string;
  /** Older workers must reject this version, never re-resolve it as a legacy job. */
  schemaVersion: 1;
  kind: 'CREATE' | 'UPDATE';
  state: PublicationOperation['state'];
  snapshot: PublicationImageReviewSnapshot;
  reviewFingerprint: string;
  fencingGeneration: number;
  lease?: { owner: string; expiresAt: string };
  dispatchedAt?: string;
  blockedCode?: 'publication_review_stale' | 'publication_reconciliation_required' | 'publication_identity_conflict';
  remoteId?: string;
  confirmedImage?: PublicationImageDeliveryEvidence;
}
export function validatePublicationImageReviewSnapshot(value: PublicationImageReviewSnapshot): void {
  const digest = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
  const positive = (v: unknown) => Number.isSafeInteger(v) && (v as number) > 0;
  if (!value || value.schemaVersion !== 1 || ![value.publicationId, value.workId, value.connectionId, value.account?.providerNamespace,
    value.account?.remoteAccountId, value.source?.assetId, value.file?.fileReference].every(isPublicationIdentifier)
    || !Number.isSafeInteger(value.configurationRevision) || value.configurationRevision < 0 || !positive(value.workRevision)
    || ![value.source?.checksum, value.file?.checksum, value.metadataFingerprint, value.dependencyFingerprint, value.imageFingerprint, value.recipeFingerprint].every(digest)
    || value.watermarkFingerprint !== undefined && !digest(value.watermarkFingerprint)
    || ![value.file?.sizeBytes, value.file?.width, value.file?.height].every(positive)
    || typeof value.file?.mimeType !== 'string' || !/^image\/[a-z0-9.+-]+$/.test(value.file.mimeType)
    || !PUBLICATION_IMAGE_VARIANTS.includes(value.variant) || !['saved', 'operation'].includes(value.imageChoice)
    || value.collectionId !== undefined && !isPublicationIdentifier(value.collectionId)
    || !Array.isArray(value.targets) || value.targets.length > 100 || value.targets.some(t => !isPublicationIdentifier(t.id) || !isPublicationIdentifier(t.access))
    || new Set(value.targets.map(t => t.id)).size !== value.targets.length
    || !['draft', 'live', 'scheduled'].includes(value.desiredStatus)
    || !value.metadata || typeof value.metadata !== 'object' || Array.isArray(value.metadata)) {
    throw new PublicationImageError('publication_image_unavailable', 'A complete server-verified image review is required.');
  }
  publicationImageCanonicalJson(value);
}
