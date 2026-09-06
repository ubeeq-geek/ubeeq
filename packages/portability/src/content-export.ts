/** Compatibility envelope for creator-content exports, distinct from repository
 * export schema v2. Callers must authorize the creator and apply export policy
 * to every supplied resource before assembly. This function does not read stores.
 */
export const assembleCreatorContentExport = <
  C, W extends { work: { workId: string } }, L,
  M extends { workId: string }, A, S
>(input: {
  generatedAt: string;
  source: { product: string; tenantId: string };
  creator: C;
  works: readonly W[];
  collections: readonly { collection: L; works: readonly M[] }[];
  integrationAccounts: readonly A[];
  /** Required product adapter: output must exclude credentials and secrets. */
  sanitizeIntegrationAccount: (account: A) => S;
}) => {
  const workIds = new Set(input.works.map(record => record.work.workId));
  if (workIds.size !== input.works.length || [...workIds].some(id => !id)) throw new Error('Export Work IDs must be non-empty and unique.');
  return structuredClone({
    schema: 'https://ubeeq.site/schemas/creator-export/v1',
    schemaVersion: 1 as const,
    generatedAt: input.generatedAt,
    source: input.source,
    creator: input.creator,
    works: input.works,
    collections: input.collections.map(({ collection, works }) => ({ collection,
      works: works.filter(membership => workIds.has(membership.workId)) })),
    integrationAccounts: input.integrationAccounts.map(account => input.sanitizeIntegrationAccount(structuredClone(account)))
  });
};
