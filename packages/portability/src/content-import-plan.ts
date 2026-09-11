import { parseCreatorContentExport } from './content-export-validation.js';

export interface CreatorContentImportInventory {
  targetTenantId: string;
  targetCreatorId: string;
  /** Include collisions across all owners in the target identifier namespace. */
  existingWorkIds: readonly string[];
  existingAssetIds: readonly string[];
  existingCollectionIds: readonly string[];
  existingSourceFileIds?: readonly string[];
  existingPublicationIds?: readonly string[];
  existingPublicationIntentIds?: readonly string[];
  existingIntegrationAccountIds?: readonly string[];
}

/** Read-only ID preflight. Neither this plan nor source storage references grant
 * target authorization, imply complete inventory, or permit restore execution. */
export const planCreatorContentImport = (json: string, inventory: CreatorContentImportInventory) => {
  const validId = (value: unknown): value is string => typeof value === 'string' && Boolean(value.trim()) && value.length <= 500;
  if (![inventory.targetTenantId, inventory.targetCreatorId].every(validId) ||
    [inventory.existingWorkIds, inventory.existingAssetIds, inventory.existingCollectionIds, inventory.existingSourceFileIds ?? [],
      inventory.existingPublicationIds ?? [], inventory.existingPublicationIntentIds ?? [], inventory.existingIntegrationAccountIds ?? []].some(values =>
      !Array.isArray(values) || values.length > 100_000 || values.some(value => !validId(value)))) throw new Error('Invalid target import inventory.');
  const parsed = parseCreatorContentExport(json);
  const manifest = parsed.manifest;
  const workIds: string[] = manifest.works.map((entry: any) => entry.work.workId);
  const assetIds: string[] = [...new Set<string>([...manifest.works.flatMap((entry: any) => entry.assets.map((asset: any) => asset.assetId)),
    ...(manifest.retainedAssets || []).map((asset: any) => asset.assetId)])];
  const collectionIds: string[] = manifest.collections.map((entry: any) => entry.collection.collectionId);
  const sourceFileIds: string[] = (manifest.sourceFiles ?? []).map((file: any) => file.fileId);
  if (sourceFileIds.length && inventory.existingSourceFileIds === undefined) throw new Error('Source-file collision inventory is required.');
  for (const [ids, existing] of [[parsed.relatedIds.publications, inventory.existingPublicationIds],
    [parsed.relatedIds.publicationIntents, inventory.existingPublicationIntentIds], [parsed.relatedIds.integrationAccounts, inventory.existingIntegrationAccountIds]]) {
    if (ids!.length && existing === undefined) throw new Error('Related-record collision inventory is required.');
  }
  const conflicts: Array<{ resource: 'work' | 'asset' | 'collection' | 'sourceFile' | 'publication' | 'publicationIntent' | 'integrationAccount'; id: string; reason: 'id_exists' }> = [];
  for (const [resource, incoming, existing] of [
    ['work', workIds, inventory.existingWorkIds], ['asset', assetIds, inventory.existingAssetIds], ['collection', collectionIds, inventory.existingCollectionIds],
    ['sourceFile', sourceFileIds, inventory.existingSourceFileIds ?? []],
    ['publication', parsed.relatedIds.publications, inventory.existingPublicationIds ?? []],
    ['publicationIntent', parsed.relatedIds.publicationIntents, inventory.existingPublicationIntentIds ?? []],
    ['integrationAccount', parsed.relatedIds.integrationAccounts, inventory.existingIntegrationAccountIds ?? []]
  ] as const) {
    const existingIds = new Set(existing);
    for (const id of incoming) if (existingIds.has(id)) conflicts.push({ resource, id, reason: 'id_exists' });
  }
  return {
    source: { tenantId: parsed.tenantId, creatorId: parsed.creatorId },
    target: { tenantId: inventory.targetTenantId, creatorId: inventory.targetCreatorId },
    counts: parsed.counts,
    conflicts,
    assetsRequiringVerification: assetIds,
    executionAuthorized: false as const,
    remainingChecks: ['target_authorization', 'product_fields_and_policy', 'slug_and_related_record_conflicts',
      'object_access_and_integrity', 'live_state_exclusion', 'transactional_commit'] as const
  };
};
