import type { WorkKind, WorkAssetRole, CollectionType } from './index.js';
import type { AnnouncementTemplate } from './collection-announcement-preferences.js';
import {parseStoredPostBlocks,type StoredPostBlock} from './content-blocks.js';

/** Preparation never grants publication, access, or delivery authority. */
export type ContentUnitRef = { kind: 'work' | 'collection'; id: string; revision: number };
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
  replacements: Array<{ previousId: string; nextId: string }>;
  primaryId?: string;
  componentMetadata?: Record<string,{caption?:string;altText?:string}>;
  state: 'draft' | 'accepted' | 'applied' | 'needs_reconciliation';
}
export type ContentPreviewRecipe =
  | { kind: 'uploaded_prepared' | 'independent'; regenerable: false }
  | { kind: 'image'; maxWidth?: number; maxHeight?: number; watermark: boolean; blur?: number }
  | { kind: 'text'; start: number; end: number }
  | { kind: 'time_range'; startMs: number; endMs: number; maxHeight?: number };
export interface ContentPreviewRelationship {
  id: string;
  target: ContentUnitRef;
  revision: number;
  components: Array<{ intakeId?: string; assetId?: string; workId?: string; sourceRevision: string; recipe: ContentPreviewRecipe }>;
  offeringId?: string;
}
export interface ContentPreparationSettings {
  access: 'private' | 'free' | 'premium' | 'members';
  discovery: boolean;
  preview: 'none' | 'uploaded' | 'generated';
  previewWatermark: boolean;
  previewMaxWidth: number;
  /** References are creator-bound configuration, never exported credentials. */
  publishDestinations: Array<{ destination: string; connectionId?: string; targetId?: string; representation: 'full' | 'preview' | 'link'; required: boolean }>;
  announce: {
    mode: 'off' | 'draft' | 'after_publication';
    template?: AnnouncementTemplate;
    destinationIds: string[];
    delayMs: number;
    followUpDelayMs?: number;
  };
}
export interface ContentUnitPreset {
  id: string;
  creatorId: string;
  name: string;
  schemaVersion: 1;
  revision: number;
  applicability: { arrangement: ContentArrangement; media: WorkKind | 'any'; previewOrigin?: ContentIntakeObject['provenance'] };
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
  blockers: Array<{ code: string; message: string; objectId?: string }>;
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
  preset?: { id: string; revision: number; name: string };
  changes?: ContentChangeSet;
  previews: ContentPreviewRelationship[];
  review?: ContentWorkflowReview;
  operationIds: string[];
}
export class ContentWorkflowError extends Error {
  constructor(readonly code: 'invalid_input' | 'revision_conflict' | 'ambiguous_file_roles' | 'missing_original' | 'preset_incompatible' | 'unsupported_operation', message: string) {
    super(message); this.name = 'ContentWorkflowError';
  }
}
const invalid = (message: string): never => { throw new ContentWorkflowError('invalid_input', message); };
export function defaultContentPreparation(): ContentPreparationSettings {
  return { access: 'private', discovery: false, preview: 'none', previewWatermark: true, previewMaxWidth: 1600,
    publishDestinations: [], announce: { mode: 'draft', destinationIds: [], delayMs: 0 } };
}
export function inferContentArrangement(entry: ContentEntryContext, objects: readonly ContentIntakeObject[]): { arrangement: ContentArrangement; needsChoice: boolean; primaryCount: number } {
  const primaryCount = objects.filter(o => o.role === 'original').length;
  if (entry.target) return { arrangement: entry.target.kind, needsChoice: false, primaryCount };
  if (entry.intent === 'work' || entry.intent === 'collection') return { arrangement: entry.intent, needsChoice: false, primaryCount };
  return { arrangement: primaryCount > 1 ? 'collection' : 'work', needsChoice: primaryCount > 1, primaryCount };
}
export function validateContentObjects(objects: readonly ContentIntakeObject[]): void {
  if (!Array.isArray(objects) || objects.length > 250) invalid('Choose up to 250 intake objects.');
  const ids = new Set(objects.map(o => o.id));
  if (ids.size !== objects.length) invalid('Intake object identities must be distinct.');
  for (const o of objects) {
    if (!o.id || o.id.length > 200 || !o.operationId || o.operationId.length > 200 || typeof o.filename !== 'string' || o.filename.length > 255 ||
      !['image','gallery','video','audio','literature','article','animation','mixed'].includes(o.media) ||
      !['original','preview','cover','attachment','excluded'].includes(o.role) ||
      !['pending','processing','ready','failed','reference'].includes(o.state) ||
      !['uploaded_original','uploaded_prepared','existing','authored','external_reference'].includes(o.provenance) ||
      !Array.isArray(o.targets) || o.targets.length > 250 || o.targets.some(id => typeof id !== 'string' || !id || id.length > 200) ||
      o.text !== undefined && (typeof o.text !== 'string' || o.text.length > 100000) || o.title !== undefined && (typeof o.title !== 'string' || o.title.length > 300)) invalid('Invalid intake object.');
    if (o.role === 'preview' && o.targets.some(id => ids.has(id) && !objects.some(target => target.id === id && target.role === 'original')))
      invalid('A preview must target original content, not another supporting file.');
    if(o.body!==undefined)parseStoredPostBlocks(o.body);
  }
}
export function validateContentPreparation(settings: ContentPreparationSettings): void {
  if (!settings || !['private','free','premium','members'].includes(settings.access) || typeof settings.discovery !== 'boolean' ||
    !['none','uploaded','generated'].includes(settings.preview) || typeof settings.previewWatermark !== 'boolean' ||
    !Number.isSafeInteger(settings.previewMaxWidth) || settings.previewMaxWidth < 64 || settings.previewMaxWidth > 10000 ||
    !Array.isArray(settings.publishDestinations) || settings.publishDestinations.length > 20) invalid('Invalid content preparation settings.');
  for (const d of settings.publishDestinations) if (!d || typeof d.destination !== 'string' || !d.destination || d.destination.length > 100 ||
    !['full','preview','link'].includes(d.representation) || typeof d.required !== 'boolean' ||
    [d.connectionId,d.targetId].some(id => id !== undefined && (typeof id !== 'string' || !id || id.length > 200))) invalid('Invalid publication destination.');
  const a = settings.announce;
  if (!a || !['off','draft','after_publication'].includes(a.mode) || !Array.isArray(a.destinationIds) || a.destinationIds.length > 20 ||
    a.destinationIds.some(id => typeof id !== 'string' || !id || id.length > 200) || new Set(a.destinationIds).size !== a.destinationIds.length ||
    !Number.isSafeInteger(a.delayMs) || a.delayMs < 0 || a.delayMs > 31536000000 ||
    a.followUpDelayMs !== undefined && (!Number.isSafeInteger(a.followUpDelayMs) || a.followUpDelayMs < 600000 || a.followUpDelayMs > 31536000000)) invalid('Invalid announcement preparation.');
}
export function validatePreviewRecipe(recipe: ContentPreviewRecipe): void {
  if (!recipe || !['uploaded_prepared','independent','image','text','time_range'].includes(recipe.kind)) invalid('Choose a supported preview recipe.');
  if (recipe.kind === 'uploaded_prepared' || recipe.kind === 'independent') { if (recipe.regenerable !== false) invalid('Uploaded and independent previews have no inferred regeneration recipe.'); }
  if (recipe.kind === 'image' && (typeof recipe.watermark !== 'boolean' || [recipe.maxWidth,recipe.maxHeight].some(n => n !== undefined && (!Number.isSafeInteger(n) || n < 1 || n > 10000)) || recipe.blur !== undefined && (!Number.isFinite(recipe.blur) || recipe.blur < 0 || recipe.blur > 100))) invalid('Invalid image preview recipe.');
  if (recipe.kind === 'text' && (!Number.isSafeInteger(recipe.start) || !Number.isSafeInteger(recipe.end) || recipe.start < 0 || recipe.end <= recipe.start)) invalid('Choose an exact non-empty text range.');
  if (recipe.kind === 'time_range' && (!Number.isSafeInteger(recipe.startMs) || !Number.isSafeInteger(recipe.endMs) || recipe.startMs < 0 || recipe.endMs <= recipe.startMs || recipe.maxHeight !== undefined && (!Number.isSafeInteger(recipe.maxHeight) || recipe.maxHeight < 1 || recipe.maxHeight > 10000))) invalid('Choose an exact non-empty time range.');
}
/** Suggestions require confirmation; names never decide custody or original access. */
export function suggestContentPairs(objects: readonly ContentIntakeObject[]) {
  const stem = (name: string) => name.replace(/\.[^.]+$/, '').replace(/[-_ ](?:preview|watermarked|thumb|thumbnail|sample|cover|original|full)(?:[-_ ]?\d+)?$/i, '').toLowerCase();
  return objects.filter(o => /(?:preview|watermarked|thumb|thumbnail|sample)/i.test(o.filename)).map(o => ({ objectId: o.id,
    candidateIds: objects.filter(other => other.id !== o.id && other.role === 'original' && stem(other.filename) === stem(o.filename)).map(other => other.id) }));
}
export function contentPresetKey(preset: Pick<ContentUnitPreset,'applicability'>): string {
  return JSON.stringify([preset.applicability.arrangement,preset.applicability.media,preset.applicability.previewOrigin ?? null]);
}
export function resolveContentPreset(presets: readonly ContentUnitPreset[], creatorId: string, arrangement: ContentArrangement, media: WorkKind | 'any', explicitId?: string, previewOrigin?: ContentIntakeObject['provenance']): ContentUnitPreset | undefined {
  const candidates = presets.filter(p => p.creatorId === creatorId && !p.archived && p.applicability.arrangement === arrangement &&
    (p.applicability.media === media || p.applicability.media === 'any') && (!p.applicability.previewOrigin || p.applicability.previewOrigin === previewOrigin));
  if (explicitId) {
    const chosen = candidates.find(p => p.id === explicitId);
    if (!chosen) throw new ContentWorkflowError('preset_incompatible', 'Choose a preset matching this Creator, arrangement, media, and preview source.');
    return structuredClone(chosen);
  }
  const defaults = candidates.filter(p => p.isDefault), exact = defaults.filter(p => p.applicability.media === media && p.applicability.previewOrigin === previewOrigin);
  const ranked = exact.length ? exact : defaults.filter(p => p.applicability.media === media).length ? defaults.filter(p => p.applicability.media === media) : defaults;
  if (ranked.length > 1) throw new ContentWorkflowError('preset_incompatible', 'Several matching defaults are available. Choose a preset.');
  return ranked[0] ? structuredClone(ranked[0]) : undefined;
}
/** Presets carry reusable choices only. Content refs and absolute schedules never enter this projection. */
export function captureContentPreset(input: { id: string; creatorId: string; name: string; revision: number; applicability: ContentUnitPreset['applicability']; settings: ContentPreparationSettings; isDefault: boolean }): ContentUnitPreset {
  if (!input.id || !input.creatorId || !input.name.trim() || input.name.length > 80 || !Number.isSafeInteger(input.revision) || input.revision < 1 ||
    !['work','collection','separate_works'].includes(input.applicability.arrangement)) invalid('Choose a valid preset name and applicability.');
  validateContentPreparation(input.settings);
  const s = input.settings;
  return { id: input.id, creatorId: input.creatorId, name: input.name.trim(), schemaVersion: 1, revision: input.revision,
    applicability: structuredClone(input.applicability), isDefault: input.isDefault, archived: false,
    settings: { access:s.access, discovery:s.discovery, preview:s.preview, previewWatermark:s.previewWatermark, previewMaxWidth:s.previewMaxWidth,
      publishDestinations:s.publishDestinations.map(d=>({destination:d.destination,connectionId:d.connectionId,targetId:d.targetId,representation:d.representation,required:d.required})),
      announce:{mode:s.announce.mode,template:s.announce.template ? structuredClone(s.announce.template) : undefined,destinationIds:[...s.announce.destinationIds],delayMs:s.announce.delayMs,followUpDelayMs:s.announce.followUpDelayMs} } };
}
export function contentWorkflowBlockers(draft: ContentWorkflowDraft): Array<{code:string;message:string;objectId?:string}> {
  validateContentObjects(draft.objects); validateContentPreparation(draft.settings);
  const blockers: Array<{code:string;message:string;objectId?:string}> = [];
  const active = draft.objects.filter(o=>o.role !== 'excluded');
  if (!active.length && !draft.entry.target) blockers.push({code:'missing_original',message:'Upload, write, or select content to prepare.'});
  if (!draft.title.trim() && !draft.entry.target) blockers.push({code:'missing_title',message:'Give this content a title.'});
  if (active.some(o=>o.role==='original') && inferContentArrangement(draft.entry,draft.objects).needsChoice && !draft.arrangementConfirmed)
    blockers.push({code:'arrangement_required',message:'Confirm how these originals should be arranged.'});
  for (const o of active) {
    if (!['ready','reference'].includes(o.state)) blockers.push({code:o.state==='failed'?'processing_failed':'processing_pending',message:o.error || `${o.filename} is not ready.`,objectId:o.id});
    if (o.role==='preview' && !o.targets.length && !draft.entry.target) blockers.push({code:'ambiguous_file_roles',message:`Choose what ${o.filename} promotes, or explicitly prepare a preview-only Work.`,objectId:o.id});
  }
  return blockers;
}
