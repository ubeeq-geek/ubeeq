import type { ContentBlock } from './index.js';
import { WEBSITE_THEMES, WEBSITE_PAGE_TEMPLATES, type WebsiteThemeId, type WebsitePageTemplate } from './website-design.js';

export const WEBSITE_API_VERSION = '1' as const;
export class WebsiteError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
export interface WebsiteDocument {
  id: string; workspaceId: string; revision: number;
  blocks: readonly ContentBlock[];
}
export interface WebsitePage {
  id: string; websiteId: string; workspaceId: string; revision: number;
  documentId: string; kind: 'home' | 'page' | 'portfolio' | 'update';
  title: string; slug: string; parentId?: string; order: number;
  state: 'draft' | 'ready' | 'archived'; navigation: boolean; navigationLabel?: string;
  description?: string; date?: string; excerpt?: string; noindex?: boolean; canonicalUrl?: string;
  seoTitle?: string; socialAssetId?: string; layout?: 'reading' | 'wide';
  template?: WebsitePageTemplate; coverAssetId?: string; backgroundAssetId?: string;
  coverPosition?: {x:number;y:number}; backgroundPosition?: {x:number;y:number}; footerNavigation?: boolean;
}
export type WebsiteDestination =
  | { mode: 'local' }
  | { mode: 'manual'; url: string }
  | { mode: 'connected'; destinationId: string; accountId: string; spaceId?: string };
export interface GalleryDestinationRule {
  destination: WebsiteDestination;
  missing?: 'error' | 'omit' | 'fallback'; fallback?: WebsiteDestination;
}
/** A selected publication, never a Work-level alias. Data comes from existing catalogues. */
export interface WebsiteGallery {
  publicationId: string; workId: string; workspaceId: string; revision: number;
  title: string; slug: string; description?: string; tags: readonly string[];
  collectionIds: readonly string[]; date: string; premium: boolean;
  previewAssetIds: readonly string[]; publicAssetIds: readonly string[];
  destination?: GalleryDestinationRule; generateLocal?: boolean; canonicalUrl?: string;
}
export interface WebsitePublicationMapping {
  publicationId: string; workspaceId: string; destinationId: string;
  accountId: string; spaceId?: string; publicUrl: string;
}
export interface WebsiteRedirect { from: string; to: string; status: 301 | 308; }
export interface WebsiteGallerySettings {
  publicationId: string; title?: string; slug?: string;
  destination?: GalleryDestinationRule; generateLocal?: boolean; canonicalUrl?: string;
}
export interface Website {
  id: string; workspaceId: string; creatorIdentityId: string; revision: number;
  title: string; locale: string; homePageId: string;
  theme: { id: WebsiteThemeId; version: '1'; settings: { colorMode?: 'light' | 'dark' | 'system'; width?: 'reading' | 'wide'; footer?: string; logoAssetId?: string; faviconAssetId?: string; font?: 'system' | 'serif'; accentColor?: string; headerLayout?:'split'|'centered'|'stacked'; footerLayout?:'split'|'centered'|'minimal'; showWordmark?:boolean } };
  galleryDefault: GalleryDestinationRule; mediaMode: 'bundled' | 'linked';
  basePath: string; publicBaseUrl?: string; noindex?: boolean;
  pages: readonly WebsitePage[]; galleryPublicationIds: readonly string[];
  gallerySettings?: readonly WebsiteGallerySettings[];
  navigationLinks?: readonly { label: string; url: string }[];
  footerLinks?: readonly { label: string; url: string }[];
  redirects: readonly WebsiteRedirect[];
}
export interface WebsiteDependency { kind: 'website' | 'document' | 'publication' | 'asset' | 'catalogue' | 'policy'; id: string; revision: string; }
export interface WebsiteReleaseDecision {
  decision: 'allow' | 'hold' | 'deny'; revision: string; reasons: readonly string[];
  affectedDependencies?: readonly string[]; expiresAt?: string;
}
export interface WebsiteCapabilities {
  apiVersion: '1'; export: boolean; maxPages: number; maxAssets: number; maxBytes: number;
  deploymentAdapters: readonly { id: string; apiVersion: '1'; capabilities: StaticDeploymentCapabilities }[];
}
export interface StaticDeploymentCapabilities {
  stage: boolean; atomicActivation: boolean; rollback: boolean; redirects: boolean;
  customDomains: boolean; basePaths: boolean;
}
export interface WebsiteDeploymentInput {
  workspaceId: string; targetId: string; targetRevision: number; buildId: string;
  artifactDigest: string; desiredGeneration: number; idempotencyKey: string; credentialReference: string;
}
export interface WebsiteDeploymentResult {
  state: 'staged' | 'activated' | 'failed' | 'unknown'; targetId: string;
  releaseId?: string; publicUrl?: string;
}
export interface StaticDeploymentAdapter {
  id: string; apiVersion: '1'; capabilities: StaticDeploymentCapabilities;
  validateTarget(input: { workspaceId: string; targetId: string; revision: number; basePath: string }): Promise<{ valid: boolean; reasons: readonly string[] }>;
  deploy(input: WebsiteDeploymentInput): Promise<WebsiteDeploymentResult>;
  getStatus(input: { workspaceId: string; targetId: string; idempotencyKey: string }): Promise<WebsiteDeploymentResult>;
  rollback?(input: WebsiteDeploymentInput & { releaseId: string }): Promise<WebsiteDeploymentResult>;
  unpublish?(input: { workspaceId: string; targetId: string; expectedGeneration: number }): Promise<WebsiteDeploymentResult>;
}

/** Canonical directory paths; reject ambiguous encodings instead of repeatedly decoding. */
export const websitePath = (input: string): string => {
  if (typeof input !== 'string' || input.length > 1024 || /[%\\?#\u0000-\u0020\u007f]/u.test(input)) throw new WebsiteError('invalid_path', 'Paths cannot contain encoding, whitespace, query strings, fragments, or backslashes.');
  const parts = input.normalize('NFC').toLowerCase().split('/').filter(Boolean);
  if (parts.some(part => !/^[\p{L}\p{N}][\p{L}\p{N}_-]*$/u.test(part) || ['con','prn','aux','nul','com1','lpt1'].includes(part))) throw new WebsiteError('invalid_path', 'Use safe path segments without traversal or reserved filenames.');
  return '/' + (parts.length ? parts.map(encodeURIComponent).join('/') + '/' : '');
};
export const websiteExternalUrl = (value: string, contact = false): string => {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\\]/u.test(value)) throw new WebsiteError('invalid_url', 'A public absolute URL is required.');
  let url: URL;
  try { url = new URL(value); } catch { throw new WebsiteError('invalid_url', 'A public absolute URL is required.'); }
  if (!(['https:', 'http:', ...(contact ? ['mailto:'] : [])].includes(url.protocol)) || url.username || url.password || [...url.searchParams.keys(), ...(url.hash.includes('=') ? [...new URLSearchParams(url.hash.slice(1)).keys()] : [])].some(key => /token|secret|signature|credential|authorization|password|api[-_]?key|^auth$|^key$|^sig$|^x-amz-/i.test(key))) throw new WebsiteError('invalid_url', 'URL scheme, credentials, or signed query parameters are not permitted.');
  return url.href;
};
export const websiteRoutes = (site: Website): ReadonlyMap<string, string> => {
  if (!site.id || !site.workspaceId || !site.creatorIdentityId || !Number.isSafeInteger(site.revision) || site.revision < 1 || !site.title?.trim() || !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(site.locale)) throw new WebsiteError('invalid_website', 'Website identity, revision, title and locale are required.');
  websitePath(site.basePath);
  if (site.publicBaseUrl) { const url = new URL(websiteExternalUrl(site.publicBaseUrl)); if (url.pathname !== '/' || url.search || url.hash) throw new WebsiteError('invalid_url', 'Public base URL must be an origin; configure the base path separately.'); }
  if (!WEBSITE_THEMES.some(theme=>theme.id===site.theme.id) || site.theme.version !== '1' || Object.keys(site.theme.settings).some(key => !['colorMode','width','footer','logoAssetId','faviconAssetId','font','accentColor','headerLayout','footerLayout','showWordmark'].includes(key)) || (site.theme.settings.colorMode && !['light','dark','system'].includes(site.theme.settings.colorMode)) || (site.theme.settings.width && !['reading','wide'].includes(site.theme.settings.width)) || (site.theme.settings.font && !['system','serif'].includes(site.theme.settings.font))) throw new WebsiteError('unsupported_theme', 'Unsupported theme or settings.');
  if(site.theme.settings.headerLayout&&!['split','centered','stacked'].includes(site.theme.settings.headerLayout)||site.theme.settings.footerLayout&&!['split','centered','minimal'].includes(site.theme.settings.footerLayout)||site.theme.settings.showWordmark!==undefined&&typeof site.theme.settings.showWordmark!=='boolean')throw new WebsiteError('invalid_theme','Choose a supported header and footer layout.');
  if (site.theme.settings.accentColor) {
    const color=site.theme.settings.accentColor;
    if(!/^#[a-f0-9]{6}$/i.test(color)) throw new WebsiteError('invalid_theme','Accent color must be a six-digit hexadecimal value.');
    const luminance=(hex:string) => [1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255).map(c=>c<=.04045?c/12.92:((c+.055)/1.055)**2.4).reduce((sum,c,i)=>sum+c*[.2126,.7152,.0722][i],0);
    const palette=WEBSITE_THEMES.find(theme=>theme.id===site.theme.id)!;
    for(const background of site.theme.settings.colorMode==='dark'?[palette.dark.canvas]:site.theme.settings.colorMode==='system'?[palette.light.canvas,palette.dark.canvas]:[palette.light.canvas]) {
      const a=luminance(color),b=luminance(background);
      if((Math.max(a,b)+.05)/(Math.min(a,b)+.05)<4.5) throw new WebsiteError('theme_contrast','Accent color needs at least 4.5:1 contrast against the selected canvas. Choose another color or color mode.');
    }
  }
  for(const item of [...(site.navigationLinks??[]),...(site.footerLinks??[])]) { if(!item.label?.trim()) throw new WebsiteError('invalid_navigation','External navigation links require a label.'); websiteExternalUrl(item.url,true); }
  if (!['bundled','linked'].includes(site.mediaMode)) throw new WebsiteError('invalid_media_mode', 'Choose bundled or linked public media.');
  const validateRule = (rule: GalleryDestinationRule) => {
    const destination = (d: WebsiteDestination) => {
      if (!d || !['local','manual','connected'].includes(d.mode)) throw new WebsiteError('invalid_destination','Choose Local, a manual URL or a connected destination.');
      if (d.mode === 'manual') websiteExternalUrl(d.url);
      if (d.mode === 'connected' && (!d.destinationId?.trim() || !d.accountId?.trim())) throw new WebsiteError('invalid_destination','Connected destinations require an instance and account.');
    };
    destination(rule.destination);
    if (rule.missing && !['error','omit','fallback'].includes(rule.missing)) throw new WebsiteError('invalid_destination','Unsupported missing-target behavior.');
    if (rule.missing === 'fallback' && !rule.fallback) throw new WebsiteError('invalid_destination','A fallback rule requires a separately configured destination.');
    if (rule.fallback) destination(rule.fallback);
  };
  validateRule(site.galleryDefault);
  if (new Set(site.gallerySettings?.map(g=>g.publicationId)).size !== (site.gallerySettings?.length ?? 0)) throw new WebsiteError('duplicate_selection','Gallery settings must select unique publications.');
  for (const setting of site.gallerySettings ?? []) {
    if (!site.galleryPublicationIds.includes(setting.publicationId)) throw new WebsiteError('foreign_reference','Gallery settings must reference a selected publication.');
    if (setting.destination) validateRule(setting.destination);
    if (setting.slug) { if(setting.slug.includes('/')) throw new WebsiteError('invalid_path','Gallery slug must be a single segment.'); websitePath(setting.slug); }
    if (setting.canonicalUrl) websiteExternalUrl(setting.canonicalUrl);
  }
  const pages = new Map(site.pages.map(page => [page.id, page]));
  if (pages.size !== site.pages.length || !site.pages.length || site.pages.filter(p => p.kind === 'home').length !== 1 || pages.get(site.homePageId)?.kind !== 'home') throw new WebsiteError('invalid_home', 'Exactly one Home page is required.');
  if (new Set(site.galleryPublicationIds).size !== site.galleryPublicationIds.length) throw new WebsiteError('duplicate_selection', 'Gallery publication selections must be unique.');
  const routes = new Map<string, string>(), occupied = new Set<string>();
  for (const page of site.pages) {
    if (page.websiteId !== site.id || page.workspaceId !== site.workspaceId || !page.id || !page.documentId || !page.title?.trim() || !Number.isSafeInteger(page.revision) || page.revision < 1 || !Number.isFinite(page.order) || !['home','page','portfolio','update'].includes(page.kind) || !['draft','ready','archived'].includes(page.state)) throw new WebsiteError('invalid_page', 'Pages and documents must belong to this website and workspace.');
    if(page.template&&!WEBSITE_PAGE_TEMPLATES.some(t=>t.id===page.template))throw new WebsiteError('invalid_template','Choose a supported page template.');
    for(const position of [page.coverPosition,page.backgroundPosition])if(position&&(!Number.isFinite(position.x)||!Number.isFinite(position.y)||position.x<0||position.x>1||position.y<0||position.y>1))throw new WebsiteError('invalid_position','Image positions must be between zero and one.');
    for(const id of [page.coverAssetId,page.backgroundAssetId])if(id&&(typeof id!=='string'||!/^[-a-zA-Z0-9_:]{1,160}$/.test(id)))throw new WebsiteError('invalid_media','Choose an image from the library.');
    if(page.footerNavigation!==undefined&&typeof page.footerNavigation!=='boolean')throw new WebsiteError('invalid_navigation','Choose whether this page appears in the footer.');
    if (page.canonicalUrl) websiteExternalUrl(page.canonicalUrl);
    if (page.kind === 'home' && (page.parentId || page.slug || page.state !== 'ready')) throw new WebsiteError('invalid_home', 'Home must be ready, without a parent or slug.');
    const parent = page.parentId ? pages.get(page.parentId) : undefined;
    if (page.parentId && (!parent || parent.id === page.id || parent.parentId || parent.kind === 'home' || parent.kind === 'update' || parent.state === 'archived')) throw new WebsiteError('invalid_hierarchy', 'A sub-page requires a top-level editorial parent; cycles and third levels are forbidden.');
    if (page.kind !== 'home' && (!page.slug || page.slug.includes('/'))) throw new WebsiteError('invalid_path', 'Each editorial slug must be one path segment.');
    if (page.kind === 'update' && page.parentId) throw new WebsiteError('invalid_hierarchy', 'Update routes cannot have an editorial parent.');
    const route = page.kind === 'home' ? '/' : websitePath(page.kind === 'update' ? `/updates/${page.slug}` : `${parent ? '/' + parent.slug : ''}/${page.slug}`);
    if (page.kind !== 'update' && route !== '/galleries/' && /^\/(galleries|updates|assets|page)\//.test(route)) throw new WebsiteError('reserved_route', 'This route namespace is reserved for generated content.');
    if (occupied.has(route)) throw new WebsiteError('route_collision', `Duplicate normalized route: ${route}`);
    occupied.add(route); routes.set(page.id, route);
  }
  for (const redirect of site.redirects) {
    const route = websitePath(redirect.from);
    if (occupied.has(route) || route === '/' || /^\/(assets|galleries|updates|page)\//.test(route) || ![301,308].includes(redirect.status)) throw new WebsiteError('route_collision', 'Redirect collides with a page or reserved namespace.');
    occupied.add(route);
    if (redirect.to.startsWith('/')) { const to = websitePath(redirect.to); if (![...routes.values()].includes(to) || to === route) throw new WebsiteError('invalid_redirect', 'Internal redirects must point directly to an existing page.'); }
    else websiteExternalUrl(redirect.to);
  }
  return routes;
};

/** Every website block resolves this one publication-scoped result. */
export const resolveWebsiteGallery = (site: Website, gallery: WebsiteGallery, mappings: readonly WebsitePublicationMapping[]): { href?: string; local: boolean; warning?: string } => {
  if (gallery.workspaceId !== site.workspaceId || !site.galleryPublicationIds.includes(gallery.publicationId)) throw new WebsiteError('foreign_reference', 'Gallery is outside the selected website pool.');
  const rule = gallery.destination ?? site.galleryDefault;
  const resolve = (destination: WebsiteDestination): string | undefined => {
    if (destination.mode === 'local') {
      if (gallery.premium || !gallery.publicAssetIds.length) throw new WebsiteError('local_not_public', 'Local galleries require a complete approved public selection.');
      return websitePath(`/galleries/${gallery.slug}`);
    }
    if (destination.mode === 'manual') return websiteExternalUrl(destination.url);
    if (destination.mode !== 'connected') throw new WebsiteError('invalid_destination', 'Unknown gallery destination.');
    const matches = mappings.filter(m => m.workspaceId === site.workspaceId && m.publicationId === gallery.publicationId && m.destinationId === destination.destinationId && m.accountId === destination.accountId && m.spaceId === destination.spaceId);
    if (matches.length > 1) throw new WebsiteError('ambiguous_destination', 'More than one exact publication mapping was supplied.');
    return matches[0] ? websiteExternalUrl(matches[0].publicUrl) : undefined;
  };
  let href = resolve(rule.destination), warning: string | undefined;
  if (!href) {
    if (rule.missing === 'fallback' && rule.fallback) { href = resolve(rule.fallback); warning = 'Configured fallback destination used.'; }
    else if (rule.missing === 'omit') return { local: false, warning: 'Unmapped gallery omitted.' };
    if (!href) throw new WebsiteError('missing_destination', 'The intended publication has no mapping in the selected destination/account/Space.');
  }
  const local = href.startsWith('/') || gallery.generateLocal === true;
  if (local && (gallery.premium || !gallery.publicAssetIds.length)) throw new WebsiteError('local_not_public', 'Protected galleries cannot be generated locally.');
  return { href, local, warning };
};
