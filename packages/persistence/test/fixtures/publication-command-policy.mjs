import { createHash } from 'node:crypto';
import { resolvePublicationImageSelection, publicationImageFingerprint, inheritedPublicationImageSelection, PublicationImageError } from '@ubeeq/core';
export const sha = value => createHash('sha256').update(value).digest('hex');
export const scope = { instanceId: 'instance', creatorId: 'creator', workId: 'work' };
export const account = { providerNamespace: 'deviantart.com', remoteAccountId: 'principal' };
export const dataHome = { homeCellId: 'cell', dataHomeRegion: 'region', dataHomeAssignedAt: '2026-01-01T00:00:00.000Z', routingRevision: 1 };
export const selection = (variant, text) => ({ ...inheritedPublicationImageSelection(), variant: { mode: 'override', value: variant },
  ...(text ? { watermark: { mode: 'override', value: { text } } } : {}) });
export const preparation = id => ({ ...scope, publicationId: id, requestId: id, expectedWorkRevision: 1,
  destination: 'deviantart', connectionId: 'connection', account, targetKey: id, intent: { access: 'premium', full: true } });
export const binding = remoteId => ({ providerNamespace: 'deviantart.com', objectType: 'deviation', ownershipBoundary: 'global', remoteId });
export const makePolicy = repositories => {
  const state = { metadata: {}, principal: 'principal', failPreparation: false, authorize: true, sourceChecksum: sha('source'), collections: [], defaultVariant: 'reduced', desiredStatus: 'live' };
  const validateWatermark = value => {
    if (!value || typeof value.text !== 'string' || value.text.length > 100) throw new PublicationImageError('invalid_request', 'Invalid watermark.');
    return { text: value.text };
  };
  const resolve = async (work, p) => resolvePublicationImageSelection({
    work: { tenantId: work.instanceId, creatorId: work.creatorId, workId: work.id, preferences: { default: state.defaultVariant } },
    publication: { ...p, tenantId: p.instanceId, creatorId: work.creatorId, publicationId: p.id },
    creator: { tenantId: work.instanceId, creatorId: work.creatorId, preferences: { watermark: { text: 'Creator' } } },
    connection: { tenantId: work.instanceId, creatorId: work.creatorId, connectionId: 'connection', destination: 'deviantart' },
    collections: state.collections, platform: { variant: 'original' }, validateWatermark,
    variants: Object.fromEntries(['original', 'thumbnail', 'reduced', 'share', 'share-alternate', 'watermarked-original'].map(v => [v, { enabled: true, available: true, width: 1000, height: 800, recipeFingerprint: sha(v) }]))
  });
  const policy = {
    async authorize() { if (!state.authorize) throw new PublicationImageError('publication_not_found', 'Publication not found.'); },
    validateWatermark,
    async validateSelection(work, p, imageSelection) {
      if (p.account?.remoteAccountId !== state.principal) throw new PublicationImageError('publication_identity_conflict', 'Principal changed.');
      const r = await resolve(work, { ...p, imageSelection });
      if (r.blockers.length) throw new PublicationImageError(r.blockers[0], 'Image unavailable.');
    },
    async review(work, p) {
      await this.validateSelection(work, p, p.imageSelection ?? inheritedPublicationImageSelection());
      const r = await resolve(work, p), metadata = { title: state.metadata[p.id] ?? p.id };
      return { schemaVersion: 1, publicationId: p.id, workId: work.id, configurationRevision: p.configurationRevision ?? 0,
        workRevision: work.revision, connectionId: p.connectionId, account: p.account, ...(p.remoteId ? { remoteBinding: p.remoteBinding ?? binding(p.remoteId) } : {}), metadata,
        metadataFingerprint: await publicationImageFingerprint(metadata), dependencyFingerprint: r.dependencyFingerprint, imageFingerprint: r.imageFingerprint,
        source: { assetId: 'asset', checksum: state.sourceChecksum },
        file: { fileReference: `private-file-${r.variant}`, checksum: sha(r.imageFingerprint + state.sourceChecksum), sizeBytes: 1000, mimeType: 'image/jpeg', width: 1000, height: 800 },
        variant: r.variant, imageChoice: 'saved', recipeFingerprint: sha(r.variant),
        ...(!r.watermarkDormant ? { watermark: r.watermark, watermarkFingerprint: await publicationImageFingerprint(r.watermark) } : {}),
        targets: [{ id: p.currentTargetKey, access: 'premium' }], desiredStatus: state.desiredStatus };
    },
    async verifyRemoteResult(op, b) {
      if (op.snapshot.account.remoteAccountId !== state.principal) throw new PublicationImageError('publication_identity_conflict', 'Principal changed.');
      return b;
    },
    async commitPreparation(work, p, intent, transaction) {
      if (repositories.publicationIntents) await repositories.publicationIntents.create({ id: `intent-${p.id}`, ...dataHome,
        instanceId: work.instanceId, workId: work.id, destination: p.destination, idempotencyKey: `intent-${p.id}` }, { transaction });
      if (state.failPreparation) throw Error('simulated interruption');
    }
  };
  return { policy, state };
};
