/** Product adapters retain their existing watermark schema and renderer. */
export type PublicationWatermarkSettings = Readonly<Record<string, unknown>>;
export const PUBLICATION_IMAGE_VARIANTS = ['original', 'thumbnail', 'reduced', 'share', 'share-alternate', 'watermarked-original'] as const;
export type PublicationImageVariant = typeof PUBLICATION_IMAGE_VARIANTS[number];
export interface PublicationImageSelection<W = PublicationWatermarkSettings> {
  schemaVersion: 1;
  variant: { mode: 'inherit' } | { mode: 'override'; value: PublicationImageVariant };
  watermark: { mode: 'inherit' } | { mode: 'override'; value: W };
  context: { mode: 'inherit' } | { mode: 'collection'; collectionId: string };
}
export interface PublicationImageConfiguration<W = PublicationWatermarkSettings> {
  imageSelection?: PublicationImageSelection<W>;
  /** Restore preserves a missing explicit context without accidentally binding it by ID. */
  unresolvedImageContext?: { sourceCollectionId: string };
  /** Independent of the older copy/record CAS revision. Missing means zero. */
  configurationRevision?: number;
}
export type PublicationImageErrorCode = 'publication_revision_conflict' | 'idempotency_conflict' | 'publication_context_unavailable'
  | 'publication_image_unavailable' | 'publication_review_stale' | 'publication_busy' | 'publication_identity_conflict'
  | 'publication_reconciliation_required' | 'publication_not_found' | 'invalid_request';
export class PublicationImageError extends Error {
  constructor(readonly code: PublicationImageErrorCode, message: string) { super(message); this.name = 'PublicationImageError'; }
}
export const inheritedPublicationImageSelection = <W = PublicationWatermarkSettings>(): PublicationImageSelection<W> => ({
  schemaVersion: 1, variant: { mode: 'inherit' }, watermark: { mode: 'inherit' }, context: { mode: 'inherit' }
});
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const keys = (value: Record<string, unknown>, names: readonly string[]) => Object.keys(value).every(key => names.includes(key));
export const isPublicationIdentifier = (value: unknown): value is string => typeof value === 'string' && value.trim() === value
  && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);
export function assertPublicationConfigurationRevision(value: unknown): asserts value is number | undefined {
  if (value !== undefined && (!Number.isSafeInteger(value) || (value as number) < 0)) throw new PublicationImageError('invalid_request', 'Invalid configuration revision.');
}
/** A mandatory product validator prevents a second, weaker watermark schema. */
export function validatePublicationImageSelection<W>(value: unknown, validateWatermark: (value: unknown) => W): PublicationImageSelection<W> {
  if (!object(value) || !keys(value, ['schemaVersion', 'variant', 'watermark', 'context']) || value.schemaVersion !== 1
    || !object(value.variant) || !object(value.watermark) || !object(value.context)) throw new PublicationImageError('invalid_request', 'Invalid image selection.');
  const { variant, watermark, context } = value;
  if (!(variant.mode === 'inherit' && keys(variant, ['mode']) || variant.mode === 'override' && keys(variant, ['mode', 'value']) && PUBLICATION_IMAGE_VARIANTS.includes(variant.value as PublicationImageVariant))
    || !(watermark.mode === 'inherit' && keys(watermark, ['mode']) || watermark.mode === 'override' && keys(watermark, ['mode', 'value']) && 'value' in watermark)
    || !(context.mode === 'inherit' && keys(context, ['mode']) || context.mode === 'collection' && keys(context, ['mode', 'collectionId']) && isPublicationIdentifier(context.collectionId))) {
    throw new PublicationImageError('invalid_request', 'Invalid image selection.');
  }
  const result = { schemaVersion: 1, variant: structuredClone(variant), context: structuredClone(context),
    watermark: watermark.mode === 'override' ? { mode: 'override', value: validateWatermark(structuredClone(watermark.value)) } : { mode: 'inherit' } } as PublicationImageSelection<W>;
  // Reject non-JSON settings, including secrets represented by runtime objects.
  publicationImageCanonicalJson(result);
  return structuredClone(result);
}
/** Stable, finite JSON only; browser-safe and shared by reviews and persistence. */
export function publicationImageCanonicalJson(value: unknown): string {
  const visit = (item: unknown): unknown => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (Array.isArray(item)) return item.map(visit);
    if (object(item) && (Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null)) {
      return Object.fromEntries(Object.keys(item).sort().filter(key => item[key] !== undefined).map(key => [key, visit(item[key])]));
    }
    throw new PublicationImageError('invalid_request', 'Image settings must contain finite JSON values.');
  };
  return JSON.stringify(visit(value));
}
export async function publicationImageFingerprint(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(publicationImageCanonicalJson(value));
  return Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
}
export interface PublicationImagePreferences<W> {
  connections?: Readonly<Record<string, PublicationImageVariant>>;
  platforms?: Readonly<Record<string, PublicationImageVariant>>;
  default?: PublicationImageVariant;
  watermark?: W;
}
export interface PublicationImageProvenance {
  source: 'publication' | 'work' | 'collection' | 'creator' | 'platform';
  id: string;
  scope: 'override' | 'connection' | 'platform' | 'default' | 'sole-membership' | 'defaults-source';
  revision?: number;
}
export interface PublicationImageAvailability {
  enabled: boolean;
  available: boolean;
  /** Preserve the adapter's existing watermark policy for watermarkable variants. Original is always unmarked. */
  watermarkEnabled?: boolean;
  width?: number;
  height?: number;
  /** Must include existing size settings and renderer recipe/version. */
  recipeFingerprint: string;
}
export interface PublicationImageResolution<W = PublicationWatermarkSettings> {
  publicationId: string;
  configurationRevision: number;
  variant: PublicationImageVariant;
  watermark?: W;
  watermarkDormant: boolean;
  collectionId?: string;
  dimensions?: { width: number; height: number };
  provenance: { variant: PublicationImageProvenance; watermark?: PublicationImageProvenance; context?: PublicationImageProvenance };
  blockers: readonly ('publication_context_unavailable' | 'publication_image_unavailable')[];
  dependencyFingerprint: string;
  /** Effective delivery dependencies; dormant watermark edits do not cause drift. */
  imageFingerprint: string;
}
export interface ResolvePublicationImageInput<W> {
  work: { tenantId: string; creatorId: string; workId: string; revision?: number; defaultsCollectionId?: string; preferences: PublicationImagePreferences<W> };
  publication: { tenantId: string; creatorId: string; workId: string; publicationId: string; connectionId: string; destination: string } & PublicationImageConfiguration<W>;
  connection: { tenantId: string; creatorId: string; connectionId: string; destination: string };
  creator: { tenantId: string; creatorId: string; revision?: number; preferences: PublicationImagePreferences<W> };
  /** Current server-loaded memberships, not collection IDs supplied by the browser. */
  collections: readonly { tenantId: string; creatorId: string; collectionId: string; revision?: number; workIds: readonly string[]; preferences: PublicationImagePreferences<W> }[];
  platform: { variant: PublicationImageVariant; watermark?: W; revision?: number };
  variants: Readonly<Partial<Record<PublicationImageVariant, PublicationImageAvailability>>>;
  validateWatermark: (value: unknown) => W;
  /** If supplied, must agree with the saved/default context. It never overrides it. */
  requestedCollectionId?: string;
}
/** Pure resolution over authorized, server-loaded records. Never fetches or exposes private file references. */
export async function resolvePublicationImageSelection<W>(raw: ResolvePublicationImageInput<W>): Promise<PublicationImageResolution<W>> {
  // Snapshot before hashing yields so concurrent caller mutations cannot change the result.
  const { validateWatermark, ...data } = raw;
  const input = structuredClone(data), { work, publication: p, connection, creator } = input;
  if ([p.tenantId, p.creatorId, p.workId, p.publicationId, p.connectionId, p.destination].some(id => !isPublicationIdentifier(id))
    || [work, connection, creator].some(record => record.tenantId !== p.tenantId || record.creatorId !== p.creatorId)
    || work.workId !== p.workId || connection.connectionId !== p.connectionId || connection.destination !== p.destination) {
    throw new PublicationImageError('publication_not_found', 'Publication not found.');
  }
  assertPublicationConfigurationRevision(p.configurationRevision);
  const selection = p.imageSelection === undefined ? inheritedPublicationImageSelection<W>() : validatePublicationImageSelection(p.imageSelection, validateWatermark);
  const eligible = input.collections.filter(c => c.tenantId === p.tenantId && c.creatorId === p.creatorId && c.workIds.includes(work.workId));
  const collectionId = selection.context.mode === 'collection' ? selection.context.collectionId
    : work.defaultsCollectionId ?? (eligible.length === 1 ? eligible[0].collectionId : undefined);
  const collection = collectionId ? eligible.find(c => c.collectionId === collectionId) : undefined;
  const blockers: Array<'publication_context_unavailable' | 'publication_image_unavailable'> = [];
  if (p.unresolvedImageContext || collectionId && !collection || input.requestedCollectionId !== undefined && input.requestedCollectionId !== collectionId) blockers.push('publication_context_unavailable');
  const at = (source: PublicationImageProvenance['source'], id: string, scope: PublicationImageProvenance['scope']): PublicationImageProvenance => {
    const revision = source === 'publication' ? p.configurationRevision ?? 0 : source === 'work' ? work.revision
      : source === 'collection' ? collection?.revision : source === 'creator' ? creator.revision : input.platform.revision;
    assertPublicationConfigurationRevision(revision);
    return { source, id, scope, ...(revision !== undefined ? { revision } : {}) };
  };
  const preference = (preferences: PublicationImagePreferences<W>, source: PublicationImageProvenance['source'], id: string, includePlatform: boolean) => {
    if (preferences.connections?.[p.connectionId] !== undefined) return { value: preferences.connections[p.connectionId], provenance: at(source, id, 'connection') };
    if (includePlatform && preferences.platforms?.[p.destination] !== undefined) return { value: preferences.platforms[p.destination], provenance: at(source, id, 'platform') };
    return preferences.default !== undefined ? { value: preferences.default, provenance: at(source, id, 'default') } : undefined;
  };
  const resolved = selection.variant.mode === 'override' ? { value: selection.variant.value, provenance: at('publication', p.publicationId, 'override') }
    : preference(work.preferences, 'work', work.workId, false)
      ?? (collection && preference(collection.preferences, 'collection', collection.collectionId, true))
      ?? preference(creator.preferences, 'creator', creator.creatorId, true)
      ?? { value: input.platform.variant, provenance: at('platform', p.destination, 'default') };
  const watermark = selection.watermark.mode === 'override' ? { value: validateWatermark(selection.watermark.value), provenance: at('publication', p.publicationId, 'override') }
    : collection?.preferences.watermark !== undefined ? { value: validateWatermark(collection.preferences.watermark), provenance: at('collection', collection.collectionId, 'default') }
      : creator.preferences.watermark !== undefined ? { value: validateWatermark(creator.preferences.watermark), provenance: at('creator', creator.creatorId, 'default') }
        : input.platform.watermark !== undefined ? { value: validateWatermark(input.platform.watermark), provenance: at('platform', p.destination, 'default') } : undefined;
  const variant = resolved.value, availability = input.variants[variant];
  if (!PUBLICATION_IMAGE_VARIANTS.includes(variant) || !availability?.enabled || !availability.available || !availability.recipeFingerprint
    || [availability.width, availability.height].some(n => n !== undefined && (!Number.isSafeInteger(n) || n < 1))) blockers.push('publication_image_unavailable');
  const watermarkDormant = variant === 'original' || !(availability?.watermarkEnabled ?? ['share', 'share-alternate', 'watermarked-original'].includes(variant));
  const context = collection ? at(selection.context.mode === 'collection' ? 'publication' : 'collection',
    selection.context.mode === 'collection' ? p.publicationId : collection.collectionId,
    selection.context.mode === 'collection' ? 'override' : work.defaultsCollectionId ? 'defaults-source' : 'sole-membership') : undefined;
  const effective = { variant, watermark: watermarkDormant ? undefined : watermark?.value, recipeFingerprint: availability?.recipeFingerprint,
    width: availability?.width, height: availability?.height, collectionId, blockers };
  const imageFingerprint = await publicationImageFingerprint(effective);
  const dependencyFingerprint = await publicationImageFingerprint({ tenantId: p.tenantId, creatorId: p.creatorId, workId: p.workId,
    publicationId: p.publicationId, connectionId: p.connectionId, destination: p.destination,
    configurationRevision: p.configurationRevision ?? 0, effective });
  return { publicationId: p.publicationId, configurationRevision: p.configurationRevision ?? 0, variant,
    ...(watermark ? { watermark: structuredClone(watermark.value) } : {}), watermarkDormant,
    ...(collectionId ? { collectionId } : {}),
    ...(availability?.width && availability.height ? { dimensions: { width: availability.width, height: availability.height } } : {}),
    provenance: { variant: resolved.provenance, ...(watermark ? { watermark: watermark.provenance } : {}), ...(context ? { context } : {}) },
    blockers, dependencyFingerprint, imageFingerprint };
}

/** Nonsecret evidence. Private storage references belong in the operation store only. */
export interface PublicationImageDeliveryEvidence {
  operationId: string;
  confirmedAt: string;
  imageFingerprint: string;
  sourceAssetId: string;
  sourceChecksum: string;
  fileChecksum: string;
  sizeBytes: number;
  mimeType: string;
  width: number;
  height: number;
  variant: PublicationImageVariant;
  recipeFingerprint: string;
  watermarkFingerprint?: string;
}
export function validatePublicationImageDeliveryEvidence(value: PublicationImageDeliveryEvidence): void {
  const digest = (item: unknown) => typeof item === 'string' && /^[a-f0-9]{64}$/.test(item);
  if (!value || !isPublicationIdentifier(value.operationId) || !isPublicationIdentifier(value.sourceAssetId)
    || !Number.isFinite(Date.parse(value.confirmedAt)) || ![value.imageFingerprint, value.sourceChecksum, value.fileChecksum, value.recipeFingerprint].every(digest)
    || value.watermarkFingerprint !== undefined && !digest(value.watermarkFingerprint)
    || ![value.sizeBytes, value.width, value.height].every(n => Number.isSafeInteger(n) && n > 0)
    || !PUBLICATION_IMAGE_VARIANTS.includes(value.variant) || typeof value.mimeType !== 'string' || !/^image\/[a-z0-9.+-]+$/.test(value.mimeType)) {
    throw new PublicationImageError('invalid_request', 'Invalid confirmed image evidence.');
  }
}
export async function comparePublicationImage(input: {
  resolution: PublicationImageResolution; sourceAssetId: string; sourceChecksum: string; recipeFingerprint: string; watermarkFingerprint?: string;
  confirmed?: PublicationImageDeliveryEvidence; acceptedDifferenceFingerprint?: string;
}): Promise<{ reasons: readonly string[]; fingerprint: string; accepted: boolean }> {
  const reasons: string[] = [];
  if (input.resolution.blockers.length) reasons.push('unavailable_configuration');
  const before = input.confirmed;
  if (!before) reasons.push('unknown_delivery');
  else {
    if (before.sourceAssetId !== input.sourceAssetId || before.sourceChecksum !== input.sourceChecksum) reasons.push('source_changed');
    if (before.variant !== input.resolution.variant) reasons.push('variant_changed');
    if (before.recipeFingerprint !== input.recipeFingerprint || input.resolution.dimensions &&
      (before.width !== input.resolution.dimensions.width || before.height !== input.resolution.dimensions.height)) reasons.push('recipe_changed');
    if (before.watermarkFingerprint !== input.watermarkFingerprint) reasons.push('watermark_changed');
  }
  const fingerprint = await publicationImageFingerprint({ publicationId: input.resolution.publicationId, desired: input.resolution.imageFingerprint,
    sourceAssetId: input.sourceAssetId, sourceChecksum: input.sourceChecksum, recipeFingerprint: input.recipeFingerprint,
    watermarkFingerprint: input.watermarkFingerprint, confirmed: before });
  return { reasons, fingerprint, accepted: reasons.length > 0 && !input.resolution.blockers.length && Boolean(before) && fingerprint === input.acceptedDifferenceFingerprint };
}
