import { createHash } from 'node:crypto';

/** Editable provider metadata. Canonical policy names are owned by the caller. */
export interface GhostEditablePublication {
  title: string;
  slug?: string;
  excerpt?: string;
  lexical: string;
  visibility: 'public' | 'members' | 'paid';
  tags: readonly string[];
  scheduledAt?: string;
  featureImageAssetId?: string;
  canonicalUrlPolicy?: string;
  canonicalUrl?: string;
}

/**
 * Preserve the established field order and empty-value defaults used by stored
 * publication hashes and reconciliation baselines. This does not validate
 * content, authorize publication, or include volatile provider status fields.
 */
export const ghostReconciliationSnapshot = (publication: GhostEditablePublication) => ({
  title: publication.title,
  slug: publication.slug || '',
  excerpt: publication.excerpt || '',
  lexical: publication.lexical,
  visibility: publication.visibility,
  tags: [...publication.tags],
  scheduledAt: publication.scheduledAt || '',
  featureImageAssetId: publication.featureImageAssetId || '',
  canonicalUrlPolicy: publication.canonicalUrlPolicy || 'ghost',
  canonicalUrl: publication.canonicalUrl || ''
});

export const ghostPublicationHash = (publication: GhostEditablePublication): string =>
  createHash('sha256').update(JSON.stringify(ghostReconciliationSnapshot(publication))).digest('hex');
