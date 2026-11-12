import type { PublicationImageVariant } from './publication-image.js';
import type { WorkKind, WorkAssetRole, CollectionType } from './index.js';
import type { AnnouncementTiming, AnnouncementFollowUpTiming, AnnouncementLatePolicy } from './announcement-plan-scheduler.js';
import type { AnnouncementMediaSelection, AnnouncementDestinationSelection, CollectionAnnouncementTriggerPreferences } from './collection-announcement-preferences.js';
import type { AnnouncementTemplate } from './collection-announcement-preferences.js';
import { parseStoredPostBlocks, type StoredPostBlock } from './content-blocks.js';
import { defaultCollectionAnnouncementPreferences, validateCollectionAnnouncementPreferences, validateAnnouncementTemplate } from './collection-announcement-preferences.js';
import { validateAnnouncementTiming } from './announcement-plan-scheduler.js';
/** Preparation never grants publication, access, or delivery authority. */
export type ContentUnitRef = {
    kind: 'work' | 'collection';
    id: string;
    revision: number;
};
export type ContentArrangement = 'work' | 'collection' | 'separate_works';
export type ContentIntakeRole = 'original' | 'preview' | 'cover' | 'attachment' | 'excluded';
export type ContentCheckpoint = 'content' | 'organize' | 'access' | 'preview' | 'publish' | 'announce' | 'review';
export interface ContentEntryContext {
    intent: 'new' | 'work' | 'collection' | 'add' | 'preview' | 'announce';
    target?: ContentUnitRef;
    returnPath?: string;
}
export interface ContentIntakeObject {
    id: string;
    operationId: string;
    filename: string;
    media: WorkKind;
    role: ContentIntakeRole;
    state: 'pending' | 'processing' | 'ready' | 'failed' | 'reference';
    sourceFileId?: string;
    existingWork?: ContentUnitRef;
    existingCollection?: ContentUnitRef;
    result?: ContentUnitRef;
    checksum?: string;
    targets: string[];
    provenance: 'uploaded_original' | 'uploaded_prepared' | 'existing' | 'authored' | 'external_reference';
    text?: string;
    body?: StoredPostBlock[];
    title?: string;
    error?: string;
}
export interface ContentComponentRef {
    id: string;
    assetId: string;
    sourceRevision: string;
    role: WorkAssetRole;
    caption?: string;
    altText?: string;
}
export interface ContentChangeSet {
    id: string;
    target: ContentUnitRef;
    /** Complete proposed order; absence of an old reference is an explicit removal. */
    orderedIds: string[];
    additions: string[];
    replacements: Array<{
        previousId: string;
        nextId: string;
    }>;
    primaryId?: string;
    componentMetadata?: Record<string, {
        caption?: string;
        altText?: string;
    }>;
    state: 'draft' | 'accepted' | 'applied' | 'needs_reconciliation';
}
export type ContentPreviewRecipe = {
    kind: 'uploaded_prepared' | 'independent';
    regenerable: false;
} | {
    kind: 'image';
    maxWidth?: number;
    maxHeight?: number;
    watermark: boolean;
    blur?: number;
} | {
    kind: 'text';
    start: number;
    end: number;
} | {
    kind: 'time_range';
    startMs: number;
    endMs: number;
    maxHeight?: number;
};
export interface ContentPreviewRelationship {
    id: string;
    target: ContentUnitRef;
    revision: number;
    components: Array<{
        intakeId?: string;
        assetId?: string;
        workId?: string;
        sourceRevision: string;
        recipe: ContentPreviewRecipe;
    }>;
    offeringId?: string;
    representationIds?: string[];
    previewCollectionId?: string;
}
/** Exact approved output. Storage locations belong to the host, never this portable contract. */
export interface ContentRepresentation {
    id: string;
    subject: ContentUnitRef;
    kind: 'full' | 'preview';
    relationshipId?: string;
    components: Array<{
        id: string;
        assetId?: string;
        sourceFileId?: string;
        checksum: string;
        recipe: ContentPreviewRecipe;
    }>;
    body?: StoredPostBlock[];
}
export type ContentReleaseSubject = {
    kind: 'work' | 'collection' | 'works';
    ids: string[];
};
/** A fallback is derived catalogue membership and confers no visibility or access rights. */
export function standaloneImageWorkIds(works: readonly {
    workId: string;
    kind: string;
}[], memberships: readonly {
    workId: string;
}[]): string[] {
    const named = new Set(memberships.map(m => m.workId));
    return works.filter(w => w.kind === 'image' && !named.has(w.workId)).map(w => w.workId);
}
export interface ContentCommerceDefaults {
    kind: 'purchase' | 'subscription';
    amount: string;
    currency: 'USD' | 'CAD' | 'EUR' | 'GBP' | 'AUD' | 'JPY';
    terms: string;
    supportEmail: string;
    downloads: boolean;
    packageDownload: boolean;
    /** Installed purchase/subscription services include subsequently reviewed additions. */
    futureAdditions: 'included';
    billing?: 'month' | 'year';
    planName?: string;
}
export type ContentMetadataField = 'tags' | 'isMature' | 'matureLevel' | 'matureClassification' | 'isAiGenerated' | 'noAi' | 'displayResolution' | 'allowFreeDownload' | 'addWatermark' | 'allowComments';
export type ContentMetadataValues = Partial<Record<ContentMetadataField, string | string[] | boolean | number | null>>;
export interface ContentMetadataDefaults {
    titlePattern?: string;
    descriptionPattern?: string;
    shared: ContentMetadataValues;
    overrides: Array<{
        destination: string;
        accountId?: string;
        targetIds?: string[];
        values: ContentMetadataValues;
    }>;
}
export interface ContentPreparationSettings {
    metadata?: ContentMetadataDefaults;
    commerce?: ContentCommerceDefaults;
    /** Current host offering version binding; never captured in a reusable preset. */
    commerceOffer?: {
        id: string;
        environment: 'sandbox' | 'live';
    };
    structure?: {
        collectionType: 'collection' | 'gallery' | 'series' | 'playlist' | 'volume';
        order: 'intake';
        cover: 'first_eligible_image' | 'none';
    };
    access: 'private' | 'free' | 'premium' | 'members';
    discovery: boolean;
    preview: 'none' | 'uploaded' | 'generated';
    previewWatermark: boolean;
    previewMaxWidth: number;
    visibility?: 'public' | 'unlisted';
    releaseTime?: {
        instant: string;
        localDateTime: string;
        timeZone: string;
        offsetMinutes: number;
    };
    /** Existing offering binding; capture omits it and requires a fresh binding on reuse. */
    offerId?: string;
    /** References are creator-bound configuration, never exported credentials. */
    publishDestinations: Array<{
        destination: string;
        connectionId?: string;
        targetId?: string;
        representation: 'full' | 'preview' | 'link';
        imageVariant?: PublicationImageVariant;
        required: boolean;
    }>;
    announce: {
        mode: 'off' | 'draft' | 'after_publication';
        template?: AnnouncementTemplate;
        destinationIds: string[];
        delayMs: number;
        followUpDelayMs?: number;
        timing?: AnnouncementTiming;
        media?: AnnouncementMediaSelection;
        mediaRequirement?: 'select_managed_previews';
        links?: CollectionAnnouncementTriggerPreferences['links'];
        latePolicy?: AnnouncementLatePolicy;
        followUp?: {
            template?: AnnouncementTemplate;
            destinationIds: string[];
            media: AnnouncementMediaSelection;
            mediaRequirement?: 'select_managed_previews';
            timing: AnnouncementFollowUpTiming;
            latePolicy: AnnouncementLatePolicy;
        };
    };
}
export interface ContentUnitPreset {
    id: string;
    creatorId: string;
    name: string;
    schemaVersion: 1;
    revision: number;
    applicability: {
        arrangement: ContentArrangement;
        collectionType?: CollectionType;
        media: WorkKind | 'any';
        previewOrigin?: ContentIntakeObject['provenance'];
    };
    settings: ContentPreparationSettings;
    isDefault: boolean;
    archived: boolean;
}
export interface ContentWorkflowReview {
    id: string;
    workflowRevision: number;
    fingerprint: string;
    expiresAt: string;
    action: 'save' | 'publish' | 'schedule';
    targets: ContentUnitRef[];
    blockers: Array<{
        code: string;
        message: string;
        objectId?: string;
    }>;
}
export interface ContentWorkflowDraft {
    id: string;
    schemaVersion: 1;
    tenantId: string;
    creatorId: string;
    actorId: string;
    revision: number;
    createdAt: string;
    updatedAt: string;
    entry: ContentEntryContext;
    checkpoint: ContentCheckpoint;
    state: 'draft' | 'accepted' | 'completed' | 'cancelled' | 'needs_reconciliation';
    title: string;
    arrangement?: ContentArrangement;
    arrangementConfirmed: boolean;
    collectionType: CollectionType;
    objects: ContentIntakeObject[];
    units: ContentUnitRef[];
    settings: ContentPreparationSettings;
    preset?: {
        id: string;
        revision: number;
        name: string;
    };
    changes?: ContentChangeSet;
    /** Referenced child groupings. These links grant no access or publication authority. */
    hierarchy?: {
        children: ContentUnitRef[];
        state: 'draft' | 'applied';
    };
    releaseScope?: {
        workIds: string[];
        componentIds?: string[];
    };
    previews: ContentPreviewRelationship[];
    review?: ContentWorkflowReview;
    operationIds: string[];
}
export class ContentWorkflowError extends Error {
    constructor(readonly code: 'invalid_input' | 'revision_conflict' | 'ambiguous_file_roles' | 'missing_original' | 'preset_incompatible' | 'unsupported_operation', message: string) {
        super(message);
        this.name = 'ContentWorkflowError';
    }
}
const invalid = (message: string): never => { throw new ContentWorkflowError('invalid_input', message); };
export function defaultContentPreparation(): ContentPreparationSettings {
    return { access: 'private', discovery: false, preview: 'none', previewWatermark: true, previewMaxWidth: 1600,
        publishDestinations: [], announce: { mode: 'draft', destinationIds: [], delayMs: 0 } };
}
export function inferContentArrangement(entry: ContentEntryContext, objects: readonly ContentIntakeObject[]): {
    arrangement: ContentArrangement;
    needsChoice: boolean;
    primaryCount: number;
} {
    const primaryCount = objects.filter(o => o.role === 'original').length;
    if (!entry.target && objects.some(o => o.role === 'original' && o.existingCollection))
        return { arrangement: 'collection', needsChoice: entry.intent === 'work' || primaryCount > 1, primaryCount };
    if (entry.target)
        return { arrangement: entry.target.kind, needsChoice: false, primaryCount };
    if (entry.intent === 'work' || entry.intent === 'collection')
        return { arrangement: entry.intent, needsChoice: false, primaryCount };
    return { arrangement: primaryCount > 1 ? 'collection' : 'work', needsChoice: primaryCount > 1, primaryCount };
}
export function validateContentObjects(objects: readonly ContentIntakeObject[]): void {
    if (!Array.isArray(objects) || objects.length > 250)
        invalid('Choose up to 250 intake objects.');
    const ids = new Set(objects.map(o => o.id));
    if (ids.size !== objects.length)
        invalid('Intake object identities must be distinct.');
    for (const o of objects) {
        if (o.existingCollection && (o.existingCollection.kind !== 'collection' || o.provenance !== 'existing' || !['original', 'excluded'].includes(o.role)))
            invalid('A referenced Collection must remain a child grouping or be excluded.');
        if (!o.id || o.id.length > 200 || !o.operationId || o.operationId.length > 200 || typeof o.filename !== 'string' || o.filename.length > 255 ||
            !['image', 'gallery', 'video', 'audio', 'literature', 'article', 'animation', 'mixed'].includes(o.media) ||
            !['original', 'preview', 'cover', 'attachment', 'excluded'].includes(o.role) ||
            !['pending', 'processing', 'ready', 'failed', 'reference'].includes(o.state) ||
            !['uploaded_original', 'uploaded_prepared', 'existing', 'authored', 'external_reference'].includes(o.provenance) ||
            !Array.isArray(o.targets) || o.targets.length > 250 || o.targets.some(id => typeof id !== 'string' || !id || id.length > 200) ||
            o.text !== undefined && (typeof o.text !== 'string' || o.text.length > 100000) || o.title !== undefined && (typeof o.title !== 'string' || o.title.length > 300))
            invalid('Invalid intake object.');
        if (o.role === 'preview' && o.targets.some(id => ids.has(id) && !objects.some(target => target.id === id && target.role === 'original')))
            invalid('A preview must target original content, not another supporting file.');
        if (o.body !== undefined)
            parseStoredPostBlocks(o.body);
    }
}
export function validateContentPreparation(settings: ContentPreparationSettings, options: {allowIncompleteMedia?:boolean} = {}): void {
    if (!settings || !['private', 'free', 'premium', 'members'].includes(settings.access) || typeof settings.discovery !== 'boolean' ||
        !['none', 'uploaded', 'generated'].includes(settings.preview) || typeof settings.previewWatermark !== 'boolean' ||
        !Number.isSafeInteger(settings.previewMaxWidth) || settings.previewMaxWidth < 64 || settings.previewMaxWidth > 10000 ||
        !Array.isArray(settings.publishDestinations) || settings.publishDestinations.length > 20)
        invalid('Invalid content preparation settings.');
    for (const d of settings.publishDestinations)
        if (!d || typeof d.destination !== 'string' || !d.destination || d.destination.length > 100 ||
            !['full', 'preview', 'link'].includes(d.representation) || d.imageVariant !== undefined && !['original', 'thumbnail', 'reduced', 'share', 'share-alternate', 'watermarked-original'].includes(d.imageVariant) || typeof d.required !== 'boolean' ||
            [d.connectionId, d.targetId].some(id => id !== undefined && (typeof id !== 'string' || !id || id.length > 200)))
            invalid('Invalid publication destination.');
    if (settings.structure && (!['collection', 'gallery', 'series', 'playlist', 'volume'].includes(settings.structure.collectionType) || settings.structure.order !== 'intake' || !['first_eligible_image', 'none'].includes(settings.structure.cover)))
        invalid('Choose supported content structure defaults.');
    const c = settings.commerce;
    if (c && (!['purchase', 'subscription'].includes(c.kind) || typeof c.amount !== 'string' || !/^\d{1,10}(?:\.\d{1,2})?$/.test(c.amount) || Number(c.amount) <= 0 || !['USD', 'CAD', 'EUR', 'GBP', 'AUD', 'JPY'].includes(c.currency) || c.currency === 'JPY' && c.amount.includes('.') || typeof c.terms !== 'string' || c.terms.length > 10000 || typeof c.supportEmail !== 'string' || c.supportEmail.length > 254 || typeof c.downloads !== 'boolean' || typeof c.packageDownload !== 'boolean' || c.futureAdditions !== 'included' || c.kind === 'subscription' && !['month', 'year'].includes(c.billing ?? '') || c.planName !== undefined && (typeof c.planName !== 'string' || c.planName.length > 127)))
        invalid('Choose supported reusable purchase terms.');
    if (settings.commerceOffer && (!settings.commerceOffer.id || typeof settings.commerceOffer.id !== 'string' || settings.commerceOffer.id.length > 200 || !['sandbox', 'live'].includes(settings.commerceOffer.environment)))
        invalid('Choose a current offering version.');
    const m = settings.metadata;
    if (m) {
        const fields = ['tags', 'isMature', 'matureLevel', 'matureClassification', 'isAiGenerated', 'noAi', 'displayResolution', 'allowFreeDownload', 'addWatermark', 'allowComments'];
        const values = (v: ContentMetadataValues) => { if (!v || typeof v !== 'object' || Array.isArray(v))
            invalid('Choose metadata defaults.'); for (const [key, value] of Object.entries(v)) {
            if (!fields.includes(key))
                invalid('Choose reusable metadata fields.');
            if (['tags', 'matureClassification'].includes(key)) {
                if (!Array.isArray(value) || value.length > 100 || value.some(item => typeof item !== 'string' || item.length > 100))
                    invalid('Choose bounded metadata lists.');
            }
            else if (key === 'matureLevel') {
                if (!['moderate', 'strict'].includes(String(value)))
                    invalid('Choose a maturity level.');
            }
            else if (key === 'displayResolution') {
                if (value !== null && ![400, 600, 800, 900, 1024, 1280, 1600, 1920].includes(value as number))
                    invalid('Choose a supported display width.');
            }
            else if (typeof value !== 'boolean')
                invalid('Choose enabled or disabled metadata defaults.');
        } };
        for (const pattern of [m.titlePattern, m.descriptionPattern])
            if (pattern !== undefined && (typeof pattern !== 'string' || pattern.length > 10000 || /\{(?!title\}|description\}|creator\})[^}]*\}/.test(pattern)))
                invalid('Use title, description or creator variables in metadata patterns.');
        if (!Array.isArray(m.overrides) || m.overrides.length > 100)
            invalid('Choose bounded destination defaults.');
        values(m.shared);
        for (const row of m.overrides) {
            if (!row || typeof row.destination !== 'string' || row.destination.length > 100 || row.accountId !== undefined && (typeof row.accountId !== 'string' || row.accountId.length > 200) || row.targetIds !== undefined && (!Array.isArray(row.targetIds) || row.targetIds.length > 100 || row.targetIds.some(id => typeof id !== 'string' || !id || id.length > 200)))
                invalid('Choose creator-bound metadata destinations.');
            values(row.values);
        }
    }
    const a = settings.announce;
    if (!a || !['off', 'draft', 'after_publication'].includes(a.mode) || !Array.isArray(a.destinationIds) || a.destinationIds.length > 20 ||
        a.destinationIds.some(id => typeof id !== 'string' || !id || id.length > 200) || new Set(a.destinationIds).size !== a.destinationIds.length ||
        !Number.isSafeInteger(a.delayMs) || a.delayMs < 0 || a.delayMs > 31536000000 ||
        a.followUpDelayMs !== undefined && (!Number.isSafeInteger(a.followUpDelayMs) || a.followUpDelayMs < 600000 || a.followUpDelayMs > 31536000000))
        invalid('Invalid announcement preparation.');
    if (a.template)
        validateAnnouncementTemplate(a.template);
    // The ordinary workflow and advanced editor share the established scheduler/media contract.
    if (a.followUp && (!Array.isArray(a.followUp.destinationIds) || a.followUp.destinationIds.some(id => typeof id !== 'string' || !id || id.length > 200)))
        invalid('Choose valid follow-up destination references.');
    if (a.followUp?.template)
        validateAnnouncementTemplate(a.followUp.template);
    if (a.followUp?.mediaRequirement !== undefined && a.followUp.mediaRequirement !== 'select_managed_previews')
        invalid('Choose a supported follow-up media requirement.');
    const ids = [...new Set([...a.destinationIds, ...(a.followUp?.destinationIds ?? [])])];
    // Binding ownership is validated with real host bindings at release preparation;
    // neutral draft validation cannot invent the destination keys of those bindings.
    const withoutBindings = (template: AnnouncementTemplate | undefined) => template ? { ...template, destinationOverrides: undefined, destinationCustomizations: undefined } : undefined;
    const draftMedia=(media:AnnouncementMediaSelection|undefined)=>options.allowIncompleteMedia&&media?.mode==='managed_previews'&&Array.isArray(media.assets)&&!media.assets.length?{mode:'none' as const}:media;
    const validation = { ...a, media:draftMedia(a.media), template: withoutBindings(a.template), followUp: a.followUp ? { ...a.followUp, media:draftMedia(a.followUp.media)!, template: withoutBindings(a.followUp.template) } : undefined };
    try {
        contentAnnouncementTrigger(validation, ids.map(id => ({ binding: { provider: 'validation', accountId: id, connectionId: id, targetId: id, postType: 'announcement' }, settings: { destinationId: id } })), 'native');
    }
    catch (error) {
        invalid(error instanceof Error ? error.message : 'Invalid announcement preparation.');
    }
    if (a.mediaRequirement !== undefined && a.mediaRequirement !== 'select_managed_previews')
        invalid('Choose a supported announcement media requirement.');
    if (settings.visibility !== undefined && !['public', 'unlisted'].includes(settings.visibility))
        invalid('Choose public or unlisted visibility.');
    if (settings.releaseTime)
        validateAnnouncementTiming({ mode: 'at_time', civilTime: settings.releaseTime });
    if (settings.offerId !== undefined && (typeof settings.offerId !== 'string' || !settings.offerId || settings.offerId.length > 200))
        invalid('Choose a valid offering.');
}
export function validatePreviewRecipe(recipe: ContentPreviewRecipe): void {
    if (!recipe || !['uploaded_prepared', 'independent', 'image', 'text', 'time_range'].includes(recipe.kind))
        invalid('Choose a supported preview recipe.');
    if (recipe.kind === 'uploaded_prepared' || recipe.kind === 'independent') {
        if (recipe.regenerable !== false)
            invalid('Uploaded and independent previews have no inferred regeneration recipe.');
    }
    if (recipe.kind === 'image' && (typeof recipe.watermark !== 'boolean' || [recipe.maxWidth, recipe.maxHeight].some(n => n !== undefined && (!Number.isSafeInteger(n) || n < 1 || n > 10000)) || recipe.blur !== undefined && (!Number.isFinite(recipe.blur) || recipe.blur < 0 || recipe.blur > 100)))
        invalid('Invalid image preview recipe.');
    if (recipe.kind === 'text' && (!Number.isSafeInteger(recipe.start) || !Number.isSafeInteger(recipe.end) || recipe.start < 0 || recipe.end <= recipe.start))
        invalid('Choose an exact non-empty text range.');
    if (recipe.kind === 'time_range' && (!Number.isSafeInteger(recipe.startMs) || !Number.isSafeInteger(recipe.endMs) || recipe.startMs < 0 || recipe.endMs <= recipe.startMs || recipe.maxHeight !== undefined && (!Number.isSafeInteger(recipe.maxHeight) || recipe.maxHeight < 1 || recipe.maxHeight > 10000)))
        invalid('Choose an exact non-empty time range.');
}
/** Suggestions require confirmation; names never decide custody or original access. */
export function suggestContentPairs(objects: readonly ContentIntakeObject[]) {
    const stem = (name: string) => name.replace(/\.[^.]+$/, '').replace(/[-_ ](?:preview|watermarked|thumb|thumbnail|sample|cover|original|full)(?:[-_ ]?\d+)?$/i, '').toLowerCase();
    return objects.filter(o => /(?:preview|watermarked|thumb|thumbnail|sample)/i.test(o.filename)).map(o => ({ objectId: o.id,
        candidateIds: objects.filter(other => other.id !== o.id && other.role === 'original' && stem(other.filename) === stem(o.filename)).map(other => other.id) }));
}
export function contentPresetKey(preset: Pick<ContentUnitPreset, 'applicability'>): string {
    return JSON.stringify([preset.applicability.arrangement, preset.applicability.media, preset.applicability.previewOrigin ?? null, preset.applicability.collectionType ?? null]);
}
export function resolveContentPreset(presets: readonly ContentUnitPreset[], creatorId: string, arrangement: ContentArrangement, media: WorkKind | 'any', explicitId?: string, previewOrigin?: ContentIntakeObject['provenance'], collectionType?: CollectionType): ContentUnitPreset | undefined {
    const candidates = presets.filter(p => p.creatorId === creatorId && !p.archived && p.applicability.arrangement === arrangement &&
        (!p.applicability.collectionType || p.applicability.collectionType === collectionType) && (p.applicability.media === media || p.applicability.media === 'any') && (!p.applicability.previewOrigin || p.applicability.previewOrigin === previewOrigin));
    if (explicitId) {
        const chosen = candidates.find(p => p.id === explicitId);
        if (!chosen)
            throw new ContentWorkflowError('preset_incompatible', 'Choose a preset matching this Creator, arrangement, media, and preview source.');
        return structuredClone(chosen);
    }
    const matchingDefaults = candidates.filter(p => p.isDefault), typedDefaults = collectionType ? matchingDefaults.filter(p => p.applicability.collectionType === collectionType) : [];
    const defaults = typedDefaults.length ? typedDefaults : matchingDefaults, exact = defaults.filter(p => p.applicability.media === media && p.applicability.previewOrigin === previewOrigin);
    const ranked = exact.length ? exact : defaults.filter(p => p.applicability.media === media).length ? defaults.filter(p => p.applicability.media === media) : defaults;
    if (ranked.length > 1)
        throw new ContentWorkflowError('preset_incompatible', 'Several matching defaults are available. Choose a preset.');
    return ranked[0] ? structuredClone(ranked[0]) : undefined;
}
/** Resolve current destination bindings in the host; reusable preferences carry no delivery authority. */
export function contentAnnouncementTrigger(value: ContentPreparationSettings['announce'], destinations: readonly AnnouncementDestinationSelection[], nativeKey: string): CollectionAnnouncementTriggerPreferences {
    const preferences = defaultCollectionAnnouncementPreferences('Etc/UTC'), trigger = preferences.initial;
    const bind = (ids: readonly string[]) => ids.map(id => {
        const destination = destinations.find(d => d.settings.destinationId === id);
        if (!destination)
            invalid('Rebind the unavailable announcement destination.');
        return structuredClone(destination!);
    });
    trigger.behaviour = value.mode === 'off' || !value.destinationIds.length ? 'off' : value.mode === 'draft' ? 'draft' : 'automatic';
    trigger.template = value.template ?? trigger.template;
    trigger.destinations = bind(value.destinationIds);
    trigger.media = value.media ?? { mode: 'none' };
    trigger.links = value.links ? structuredClone(value.links) : { primary: { destinationKey: nativeKey, label: 'View content' }, secondary: [] };
    for (const link of [trigger.links.primary, ...trigger.links.secondary])
        if (link?.destinationKey === 'native')
            link.destinationKey = nativeKey;
    trigger.timing = value.timing ?? (value.delayMs ? { mode: 'delay_after_publication', durationMs: value.delayMs, timeZone: 'Etc/UTC' } : { mode: 'after_publication', timeZone: 'Etc/UTC' });
    trigger.latePolicy = value.latePolicy ?? trigger.latePolicy;
    if (value.followUp) {
        const f = value.followUp;
        trigger.followUp = { enabled: true, template: f.template ?? trigger.template, destinations: bind(f.destinationIds), media: f.media, timing: f.timing, latePolicy: f.latePolicy };
    }
    else if (value.followUpDelayMs)
        trigger.followUp = { enabled: true, template: trigger.template, destinations: trigger.destinations, media: { mode: 'none' }, timing: { mode: 'delay_after_parent', durationMs: value.followUpDelayMs, anchor: { mode: 'corresponding_destination' }, timeZone: 'Etc/UTC' }, latePolicy: trigger.latePolicy };
    preferences.additions = structuredClone(trigger);
    validateCollectionAnnouncementPreferences(preferences);
    return trigger;
}
function reusableContentAnnouncement(value: ContentPreparationSettings['announce']): ContentPreparationSettings['announce'] {
    const zone = (timing: AnnouncementTiming) => timing.mode === 'at_time' ? timing.civilTime.timeZone : timing.timeZone;
    const relative = (timing: AnnouncementTiming | undefined): AnnouncementTiming | undefined => !timing ? undefined : timing.mode === 'delay_after_publication' ? { mode: timing.mode, timeZone: zone(timing), durationMs: timing.durationMs } : { mode: 'after_publication', timeZone: zone(timing) };
    const publicMedia = (media: AnnouncementMediaSelection | undefined): AnnouncementMediaSelection | undefined => media?.mode === 'cover' ? { mode: 'cover', altText: media.altText, caption: media.caption } : media ? { mode: 'none' } : undefined;
    const policy = (p: AnnouncementLatePolicy | undefined) => p ? { mode: p.mode, maximumLatenessMs: p.maximumLatenessMs } : undefined;
    const follow = value.followUp;
    const anchor = follow?.timing.anchor;
    return { mode: value.mode, template: value.template ? reusableContentTemplate(value.template) : undefined, destinationIds: [...value.destinationIds], delayMs: value.delayMs, followUpDelayMs: value.followUpDelayMs,
        timing: relative(value.timing), media: publicMedia(value.media), mediaRequirement: value.media?.mode === 'managed_previews' ? 'select_managed_previews' : value.mediaRequirement,
        links: value.links ? { primary: value.links.primary ? { destinationKey: value.links.primary.destinationKey, label: value.links.primary.label } : undefined, secondary: value.links.secondary.map(l => ({ destinationKey: l.destinationKey, label: l.label })) } : undefined, latePolicy: policy(value.latePolicy),
        followUp: follow ? { template: follow.template ? reusableContentTemplate(follow.template) : undefined, destinationIds: [...follow.destinationIds], media: publicMedia(follow.media)!, mediaRequirement: follow.media.mode === 'managed_previews' ? 'select_managed_previews' : follow.mediaRequirement, latePolicy: policy(follow.latePolicy)!, timing: { mode: 'delay_after_parent', durationMs: follow.timing.mode === 'at_time' ? value.followUpDelayMs ?? 86400000 : follow.timing.durationMs, timeZone: follow.timing.mode === 'at_time' ? follow.timing.civilTime.timeZone : follow.timing.timeZone, anchor: anchor!.mode === 'parent_destination' ? { mode: anchor!.mode, destinationKey: anchor!.destinationKey } : { mode: anchor!.mode } } } : undefined };
}
/** Presets carry reusable choices only. Content refs and absolute schedules never enter this projection. */
export function captureContentPreset(input: {
    id: string;
    creatorId: string;
    name: string;
    revision: number;
    applicability: ContentUnitPreset['applicability'];
    settings: ContentPreparationSettings;
    isDefault: boolean;
}): ContentUnitPreset {
    if (!input.id || !input.creatorId || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80 || !Number.isSafeInteger(input.revision) || input.revision < 1 ||
        !['work', 'collection', 'separate_works'].includes(input.applicability.arrangement) || !['any', 'image', 'gallery', 'video', 'audio', 'literature', 'article', 'animation', 'mixed'].includes(input.applicability.media) || input.applicability.previewOrigin !== undefined && !['uploaded_original', 'uploaded_prepared', 'existing', 'authored', 'external_reference'].includes(input.applicability.previewOrigin))
        invalid('Choose a valid preset name and applicability.');
    if (input.applicability.collectionType !== undefined && (!['collection', 'gallery', 'series', 'playlist', 'volume'].includes(input.applicability.collectionType) || input.applicability.arrangement !== 'collection'))
        invalid('Choose a supported grouping shape for this preset.');
    validateContentPreparation(input.settings);
    const s = input.settings;
    return { id: input.id, creatorId: input.creatorId, name: input.name.trim(), schemaVersion: 1, revision: input.revision,
        applicability: { arrangement: input.applicability.arrangement, media: input.applicability.media, previewOrigin: input.applicability.previewOrigin, collectionType: input.applicability.collectionType }, isDefault: input.isDefault, archived: false,
        settings: { metadata: s.metadata ? { titlePattern: s.metadata.titlePattern, descriptionPattern: s.metadata.descriptionPattern, shared: structuredClone(s.metadata.shared), overrides: s.metadata.overrides.map(row => ({ destination: row.destination, accountId: row.accountId, targetIds: row.targetIds ? [...row.targetIds] : undefined, values: structuredClone(row.values) })) } : undefined, commerce: s.commerce ? { kind: s.commerce.kind, amount: s.commerce.amount, currency: s.commerce.currency, terms: s.commerce.terms, supportEmail: s.commerce.supportEmail, downloads: s.commerce.downloads, packageDownload: s.commerce.packageDownload, futureAdditions: s.commerce.futureAdditions, billing: s.commerce.billing, planName: s.commerce.planName } : undefined, structure: s.structure ? { collectionType: s.structure.collectionType, order: s.structure.order, cover: s.structure.cover } : undefined, access: s.access, discovery: s.discovery, preview: s.preview, previewWatermark: s.previewWatermark, previewMaxWidth: s.previewMaxWidth,
            publishDestinations: s.publishDestinations.map(d => ({ destination: d.destination, connectionId: d.connectionId, targetId: d.targetId, representation: d.representation, imageVariant: d.imageVariant, required: d.required })),
            visibility: s.visibility,
            announce: reusableContentAnnouncement(s.announce) } };
}
/** Reject concrete media and links rather than silently copying another subject's private data. */
export function reusableContentTemplate(template: AnnouncementTemplate): AnnouncementTemplate {
    validateAnnouncementTemplate(template);
    const block = (b: AnnouncementTemplate['blocks'][number]): AnnouncementTemplate['blocks'][number] => {
        if (b.assetId || b.fileId || b.url || b.html || b.data || b.children?.length)
            invalid('Replace content-specific media, links and embedded content with reusable subject variables before saving this preset.');
        if (b.linkGroup?.links.some(link => link.source.kind === 'url' || link.source.kind === 'publication' && link.source.collectionId))
            invalid('Use links to the current subject instead of specific URLs or Collections in this preset.');
        if ([b.text, b.quote, b.caption, b.title].some(value => value && /https?:\/\//i.test(value)))
            invalid('Use a subject link variable instead of a specific URL in this preset.');
        const linkGroup = b.linkGroup ? { heading: b.linkGroup.heading, links: b.linkGroup.links.map(link => ({ id: link.id, label: link.label, appearance: link.appearance, required: link.required, showCount: link.showCount, countUnit: link.countUnit, source: link.source.kind === 'publication' ? { kind: 'publication' as const, destinationKey: link.source.destinationKey } : { kind: 'primary' as const } })) } : undefined;
        return { id: b.id, type: b.type, text: b.text, level: b.level, caption: b.caption, quote: b.quote, author: b.author, title: b.title, label: b.label, alt: b.alt, question: b.question, items: b.items, answers: b.answers, groupId: b.groupId, linkAppearance: b.linkAppearance, linkGroup };
    };
    const customization = (map: AnnouncementTemplate['platformCustomizations']) => map ? Object.fromEntries(Object.entries(map).map(([key, value]) => [key, { order: value.order ? [...value.order] : undefined, presentation: value.presentation ? { discord: value.presentation.discord, title: value.presentation.title } : undefined, blockOverrides: value.blockOverrides ? Object.fromEntries(Object.entries(value.blockOverrides).map(([id, b]) => [id, b ? block(b) : null])) : undefined }])) : undefined;
    if ([template.fields?.seriesName, template.fields?.eventLabel].some(value => value && /https?:\/\//i.test(value)))
        invalid('Use reusable branding or event labels instead of concrete URLs in preset fields.');
    return { blocks: template.blocks.map(block), fields: template.fields ? { seriesName: template.fields.seriesName, eventLabel: template.fields.eventLabel } : undefined, presentation: template.presentation ? { discord: template.presentation.discord, title: template.presentation.title } : undefined, platformCustomizations: customization(template.platformCustomizations), destinationCustomizations: customization(template.destinationCustomizations), destinationOverrides: template.destinationOverrides ? Object.fromEntries(Object.entries(template.destinationOverrides).map(([key, blocks]) => [key, blocks.map(block)])) : undefined };
}
export function contentWorkflowBlockers(draft: ContentWorkflowDraft): Array<{
    code: string;
    message: string;
    objectId?: string;
}> {
    validateContentObjects(draft.objects);
    validateContentPreparation(draft.settings,{allowIncompleteMedia:true});
    const blockers: Array<{
        code: string;
        message: string;
        objectId?: string;
    }> = [];
    const active = draft.objects.filter(o => o.role !== 'excluded');
    if (!active.length && !draft.entry.target)
        blockers.push({ code: 'missing_original', message: 'Upload, write, or select content to prepare.' });
    if (!draft.title.trim() && !draft.entry.target)
        blockers.push({ code: 'missing_title', message: 'Give this content a title.' });
    if (active.some(o => o.existingCollection) && (draft.arrangement !== 'collection' || draft.settings.structure?.collectionType !== 'volume'))
        blockers.push({ code: 'hierarchy_required', message: 'Choose a Volume to include existing Collections without flattening their contents.' });
    if (active.some(o => o.role === 'original') && inferContentArrangement(draft.entry, draft.objects).needsChoice && !draft.arrangementConfirmed)
        blockers.push({ code: 'arrangement_required', message: 'Confirm how these originals should be arranged.' });
    for (const o of active) {
        if (!['ready', 'reference'].includes(o.state))
            blockers.push({ code: o.state === 'failed' ? 'processing_failed' : 'processing_pending', message: o.error || `${o.filename} is not ready.`, objectId: o.id });
        if (o.role === 'preview' && !o.targets.length && !draft.entry.target)
            blockers.push({ code: 'ambiguous_file_roles', message: `Choose what ${o.filename} promotes, or explicitly prepare a preview-only Work.`, objectId: o.id });
        if (['cover', 'attachment'].includes(o.role) && !o.targets.length && active.filter(o => o.role === 'original').length > 1)
            blockers.push({ code: 'ambiguous_file_roles', message: `Choose the Work that ${o.filename} belongs to. Collection covers can also be prepared in Collection management.`, objectId: o.id });
    }
    if (draft.settings.preview === 'uploaded' && !active.some(o => o.role === 'preview') && !draft.previews?.length)
        blockers.push({ code: 'preview_missing', message: 'This setup expects a prepared preview. Upload one and choose its target.' });
    if (draft.settings.announce.mode !== 'off' && draft.settings.announce.mediaRequirement === 'select_managed_previews' && draft.settings.announce.media?.mode !== 'managed_previews')
        blockers.push({ code: 'announcement_media_required', message: 'Select fresh public announcement previews for this setup.' });
    if (draft.settings.announce.mode !== 'off' && draft.settings.announce.followUp?.mediaRequirement === 'select_managed_previews' && draft.settings.announce.followUp.media.mode !== 'managed_previews')
        blockers.push({ code: 'announcement_media_required', message: 'Select fresh public previews for the follow-up announcement.' });
    if(draft.settings.announce.mode!=='off'&&draft.settings.announce.media?.mode==='managed_previews'&&!draft.settings.announce.media.assets.length)blockers.push({code:'announcement_media_required',message:'Select announcement previews, or choose no media.'});
    if(draft.settings.announce.mode!=='off'&&draft.settings.announce.followUp?.media.mode==='managed_previews'&&!draft.settings.announce.followUp.media.assets.length)blockers.push({code:'announcement_media_required',message:'Select follow-up previews, or choose no media.'});
    return blockers;
}
