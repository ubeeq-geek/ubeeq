export interface ImportSlugConflict {
  resource: 'work' | 'collection'; id: string; slug: string; reason: 'slug_exists' | 'duplicate_import_slug';
}
export class ImportSlugPreflightError extends Error {
  constructor(readonly code: 'invalid_import_slugs' | 'import_preflight_budget_exceeded') { super(code); }
}
type SlugRecord = { slug?: unknown; slugHistory?: unknown; status?: unknown; workId?: string; collectionId?: string };

/** Supplement a validated content graph with URL collisions. Lookup is caller-scoped;
 * observations are not reservations and never authorize restore execution. */
export async function findCreatorContentSlugConflicts(manifest: {
  works: readonly { work: SlugRecord }[]; collections: readonly { collection: SlugRecord }[];
}, lookup: (kind: 'work' | 'collection', slug: string) => Promise<boolean>, maxCandidates: number): Promise<ImportSlugConflict[]> {
  if (!Number.isSafeInteger(maxCandidates) || maxCandidates < 1) throw new ImportSlugPreflightError('import_preflight_budget_exceeded');
  const candidates: { resource: 'work' | 'collection'; id: string; slug: string }[] = [];
  const capture = (resource: 'work' | 'collection', record: SlugRecord, id: string | undefined) => {
    if (record.status === 'deleted') return;
    if (!id || typeof id !== 'string' || !id.trim() || (record.slugHistory !== undefined && !Array.isArray(record.slugHistory))) throw new ImportSlugPreflightError('invalid_import_slugs');
    const values = [record.slug, ...(record.slugHistory as unknown[] ?? [])].filter(value => value !== undefined);
    if (values.some(value => typeof value !== 'string' || !value.trim() || value.length > 500)) throw new ImportSlugPreflightError('invalid_import_slugs');
    for (const slug of new Set(values as string[])) {
      if (candidates.length >= maxCandidates) throw new ImportSlugPreflightError('import_preflight_budget_exceeded');
      candidates.push({ resource, id, slug });
    }
  };
  for (const { work } of manifest.works) capture('work', work, work.workId);
  for (const { collection } of manifest.collections) capture('collection', collection, collection.collectionId);
  // Capture and validate all supplied aliases before asynchronous target reads.
  const conflicts: ImportSlugConflict[] = [], seen = new Set<string>();
  for (const candidate of candidates) {
    const key = JSON.stringify([candidate.resource, candidate.slug]);
    if (seen.has(key)) conflicts.push({ ...candidate, reason: 'duplicate_import_slug' });
    else seen.add(key);
    if (await lookup(candidate.resource, candidate.slug)) conflicts.push({ ...candidate, reason: 'slug_exists' });
  }
  return conflicts;
}
