import type { ContentBlock } from './index.js';
import type { AnnouncementTemplate, AnnouncementTemplateBlock } from './collection-announcement-preferences.js';
import { AnnouncementOrchestrationError } from './announcement-orchestration.js';
import { isDurableAnnouncementUrl } from './collection-release-readiness.js';

export type AnnouncementLinkSource =
  | { kind: 'primary' }
  | { kind: 'publication'; destinationKey: string; collectionId?: string }
  | { kind: 'url'; url: string };
export interface AnnouncementLayoutLink {
  id: string;
  source: AnnouncementLinkSource;
  label: string;
  appearance?: 'url' | 'label' | 'native';
  required?: boolean;
  showCount?: boolean;
  countUnit?: string;
}
export interface AnnouncementLinkGroup { heading: string; links: readonly AnnouncementLayoutLink[] }
/** Resolution is supplied by a product's authoritative publication reader. */
export interface AnnouncementLinkResolution { url: string; publishedWorkCount?: number; publishedCollectionCount?: number }
export type AnnouncementLinkResolutions = Readonly<Record<string, AnnouncementLinkResolution | undefined>>;
export interface AnnouncementPresentation { discord?: 'message' | 'embed'; title?: 'automatic' | 'body' }
export interface AnnouncementTemplateCustomization {
  /** Only changed blocks are stored; untouched sections continue to inherit. */
  blockOverrides?: Readonly<Record<string, AnnouncementTemplateBlock | null>>;
  order?: readonly string[];
  presentation?: AnnouncementPresentation;
}
export const announcementLinkSourceKey = (source: AnnouncementLinkSource): string =>
  source.kind === 'publication' ? JSON.stringify([source.kind, source.collectionId ?? '', source.destinationKey]) : source.kind;
export const announcementTemplatePlatform = (provider: string): string => provider.startsWith('discord') ? 'discord' : provider.startsWith('deviantart') ? 'deviantart' : provider;

function customize(blocks: readonly AnnouncementTemplateBlock[], patch?: AnnouncementTemplateCustomization): AnnouncementTemplateBlock[] {
  const overrides = patch?.blockOverrides ?? {};
  const override = (id:string) => Object.hasOwn(overrides,id) ? overrides[id] : undefined;
  const byId = new Map(blocks.filter(b => override(b.id) !== null).map(b => [String(b.id), override(b.id) ?? b]));
  for (const [id, block] of Object.entries(overrides)) if (block) byId.set(id, block);
  const order = [...new Set([...(patch?.order ?? []), ...byId.keys()])];
  return order.flatMap(id => byId.has(id) ? [structuredClone(byId.get(id)!)] : []);
}
export function announcementTemplateBlocks(template: AnnouncementTemplate, platform?: string, destinationKey?: string): AnnouncementTemplateBlock[] {
  const common = customize(template.blocks, platform ? template.platformCustomizations?.[announcementTemplatePlatform(platform)] : undefined);
  // Existing complete destination overrides keep their original meaning.
  return customize(destinationKey && template.destinationOverrides?.[destinationKey] || common, destinationKey ? template.destinationCustomizations?.[destinationKey] : undefined);
}
export function announcementTemplatePresentation(template: AnnouncementTemplate, platform?: string, destinationKey?: string): AnnouncementPresentation {
  return { ...template.presentation, ...(platform ? template.platformCustomizations?.[announcementTemplatePlatform(platform)]?.presentation : {}), ...(destinationKey ? template.destinationCustomizations?.[destinationKey]?.presentation : {}) };
}
export function announcementTemplateCustomization(base: readonly AnnouncementTemplateBlock[], edited: readonly AnnouncementTemplateBlock[]): AnnouncementTemplateCustomization {
  const blockOverrides: Record<string, AnnouncementTemplateBlock | null> = Object.create(null);
  for (const block of base) if (!edited.some(row => row.id === block.id)) blockOverrides[block.id] = null;
  for (const block of edited) if (JSON.stringify(base.find(row => row.id === block.id)) !== JSON.stringify(block)) blockOverrides[block.id] = structuredClone(block);
  const ids = edited.map(b => String(b.id));
  return { blockOverrides, ...(JSON.stringify(base.map(b => b.id)) !== JSON.stringify(ids) ? { order: ids } : {}) };
}
export function announcementTemplateLinks(template: AnnouncementTemplate): AnnouncementLayoutLink[] {
  const blocks = [template.blocks, ...Object.values(template.destinationOverrides ?? {}), ...Object.values(template.platformCustomizations ?? {}).map(p => Object.values(p.blockOverrides ?? {}).filter((b): b is AnnouncementTemplateBlock => Boolean(b))), ...Object.values(template.destinationCustomizations ?? {}).map(p => Object.values(p.blockOverrides ?? {}).filter((b): b is AnnouncementTemplateBlock => Boolean(b)))];
  const visit = (items: readonly AnnouncementTemplateBlock[]): AnnouncementLayoutLink[] => items.flatMap(b => [...(b.linkGroup?.links ?? []), ...visit(b.children ?? [])]);
  return blocks.flatMap(visit);
}
/** Example values for authoring previews only; never publication evidence. */
export function announcementTemplateExampleLinks(template: AnnouncementTemplate, sources: readonly { destinationKey: string; url?: string; collectionId?: string }[] = []): AnnouncementLinkResolutions {
  return Object.fromEntries(announcementTemplateLinks(template).filter(link => link.source.kind !== 'url').map(link => {
    const source = link.source;
    const option = source.kind === 'publication' ? sources.find(s => s.destinationKey === source.destinationKey && s.collectionId === source.collectionId) : undefined;
    return [announcementLinkSourceKey(source), { url: option?.url ?? 'https://example.test/collection', publishedWorkCount: 10 }];
  }));
}
export function validateAnnouncementLinkGroup(group: AnnouncementLinkGroup): void {
  if (!group || typeof group.heading !== 'string' || group.heading.length > 200 || !Array.isArray(group.links) || group.links.length > 20) throw new AnnouncementOrchestrationError('INVALID_INPUT', 'Use a link group with a short heading and up to twenty links.');
  const ids = new Set<string>();
  for (const link of group.links) {
    if (!link || !/^[\w-]{1,80}$/.test(link.id) || ids.has(link.id) || typeof link.label !== 'string' || !link.label.trim() || link.label.length > 300 || !link.source || typeof link.source !== 'object') throw new AnnouncementOrchestrationError('INVALID_INPUT', 'Each grouped link needs a distinct ID, label and content source.');
    ids.add(link.id);
    const source = link.source;
    if (source.kind === 'url' ? !isDurableAnnouncementUrl(source.url) : source.kind === 'publication' ? typeof source.destinationKey !== 'string' || !source.destinationKey || source.destinationKey.length > 512 || source.collectionId !== undefined && (typeof source.collectionId !== 'string' || !source.collectionId || source.collectionId.length > 200) : source.kind !== 'primary') throw new AnnouncementOrchestrationError('INVALID_INPUT', 'Choose a published collection destination or a durable public URL.');
    if (link.appearance !== undefined && !['url', 'label', 'native'].includes(link.appearance) || link.required !== undefined && typeof link.required !== 'boolean' || link.showCount !== undefined && typeof link.showCount !== 'boolean' || link.countUnit !== undefined && (typeof link.countUnit !== 'string' || link.countUnit.length > 80) || source.kind === 'url' && link.showCount) throw new AnnouncementOrchestrationError('INVALID_INPUT', 'Choose valid link appearance and published count settings. Custom URLs have no verified count source.');
  }
}
/** Expands template-only groups into the existing provider document vocabulary. */
export function renderAnnouncementLinkGroup(block: AnnouncementTemplateBlock, resolutions: AnnouncementLinkResolutions, replace: (value: string) => string): AnnouncementTemplateBlock[] {
  const group = block.linkGroup!;
  const links = group.links.flatMap(link => {
    const resolved = link.source.kind === 'url' ? { url: link.source.url } : resolutions[announcementLinkSourceKey(link.source)];
    if (!resolved) {
      if (link.required !== false) throw new AnnouncementOrchestrationError('LINK_NOT_READY', `Wait for the published link: ${link.label}.`);
      return [];
    }
    if (!isDurableAnnouncementUrl(resolved.url)) throw new AnnouncementOrchestrationError('LINK_NOT_READY', 'Grouped links must resolve to durable public URLs.');
    let label = replace(link.label);
    if (link.showCount) {
      const count = resolved.publishedWorkCount, collections = resolved.publishedCollectionCount;
      if (!Number.isSafeInteger(count) || count! < 0 || collections !== undefined && (!Number.isSafeInteger(collections) || collections < 0)) { if(link.required===false)return []; throw new AnnouncementOrchestrationError('LINK_NOT_READY', `Confirm the published count for ${link.label}.`); }
      label += ` (${collections !== undefined ? `${collections} galleries, ` : ''}${count}${link.countUnit ? ` ${replace(link.countUnit)}` : ''})`;
    }
    return [{ id: `${block.id}-${link.id}` as ContentBlock['id'], type: 'link' as const, label, url: resolved.url, groupId: String(block.id), linkAppearance: link.appearance ?? 'url' }];
  });
  if (!links.length) return [];
  return [...(group.heading ? [{ id: `${block.id}-heading` as ContentBlock['id'], type: 'heading' as const, level: 2, text: replace(group.heading) }] : []), ...links];
}
export function announcementLayoutPreset(kind: 'release' | 'update' | 'simple' | 'blank', sources: readonly { destinationKey: string; label: string }[] = []): AnnouncementTemplate {
  const block = (id: string, type: AnnouncementTemplateBlock['type'], text: string): AnnouncementTemplateBlock => ({ id: id as ContentBlock['id'], type, text, ...(type === 'heading' ? { level: 1 } : {}) });
  if (kind === 'blank') return { blocks: [block('message', 'paragraph', '')] };
  if (kind === 'simple') return { blocks: [block('message', 'paragraph', '{{collection.title}}'), { id: 'collection-links' as ContentBlock['id'], type: 'paragraph', linkGroup: { heading: '', links: [{ id: 'primary', label: '{{primaryLink.label}}', source: { kind: 'primary' } }] } }] };
  return {
    fields: { eventLabel: kind === 'update' ? 'UPDATE' : 'NEW', seriesName: '' }, presentation: { discord: 'message', title: 'body' },
    blocks: [block('release-heading', 'heading', '{{release.label}}: {{series.name}}'), block('collection-heading', 'heading', '{{collection.title}}'),
      { id: 'preview-links' as ContentBlock['id'], type: 'paragraph', linkGroup: { heading: 'Preview:', links: sources.slice(0, 2).map((s, i) => ({ id: `preview-${i}`, label: s.label, source: { kind: 'publication', destinationKey: s.destinationKey } })) } },
      { id: 'more-links' as ContentBlock['id'], type: 'paragraph', linkGroup: { heading: 'More…', links: sources.slice(2, 5).map((s, i) => ({ id: `more-${i}`, label: s.label, source: { kind: 'publication', destinationKey: s.destinationKey } })) } }]
  };
}
