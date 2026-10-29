import type { ContentBlock } from './index.js';
import { WEBSITE_THEMES, WEBSITE_INTENTS, WEBSITE_PAGE_TEMPLATES, type WebsiteIntentId, type WebsiteThemeId, type WebsitePageTemplate } from './website-design.js';

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
  /** Top heading follows the page title unless customized; shown by default. */
  heading?: string; showHeading?: boolean;
  seoTitle?: string; socialAssetId?: string; layout?: 'reading' | 'wide';
  template?: WebsitePageTemplate; coverAssetId?: string; backgroundAssetId?: string;
  coverPosition?: {x:number;y:number}; backgroundPosition?: {x:number;y:number}; footerNavigation?: boolean;
  navigationOrder?:number; footerNavigationOrder?:number;
  /** Menu hierarchy overrides page hierarchy without changing routes. Null means top level. */
  navigationParentId?:string|null; footerNavigationParentId?:string|null;
}
export const websiteMenuParent = (page:WebsitePage,footer=false):string|undefined => {const value=footer?page.footerNavigationParentId:page.navigationParentId;return value===undefined?page.parentId:value??undefined;};
export const websiteMenuOrder = (page:WebsitePage,footer=false):number => (footer?page.footerNavigationOrder:page.navigationOrder)??page.order;
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
  creatorIdentityId?: string; creatorName?: string;
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
  /** Explicit public card copy and an independently approved public rendition. */
  description?: string; previewAssetId?: string;
  destination?: GalleryDestinationRule; generateLocal?: boolean; canonicalUrl?: string;
}
/** A stable named destination, independent of the page/block displaying it. */
export interface WebsiteNamedGallery {
  id: string; title: string; slug: string; parentId?: string;
  kind: 'works' | 'galleries'; access: 'free' | 'preview'; hostingTargetId?: string;
  publicationIds: readonly string[];
}
export const websiteNamedGalleryPath = (site: Pick<Website,'namedGalleries'>, gallery: WebsiteNamedGallery):string => {
  const parent=gallery.parentId?site.namedGalleries?.find(row=>row.id===gallery.parentId):undefined;
  return websitePath(`/galleries/collections/${parent?parent.slug+'/':''}${gallery.slug}`);
};
export interface WebsiteEmbedding {parentUrl?:string;sourceUrl?:string;responsive?:boolean;mode:'disabled'|'selected'|'any';origins:readonly string[];pageId:string;presentation:'full'|'content';height:number;}
export interface Website {
  id: string; workspaceId: string; creatorIdentityId: string; revision: number;
  /** Identities explicitly authorized to contribute public Works; ownership remains in workspaceId. */
  contributingCreatorIds?: readonly string[];
  /** Optional grants to editor members of connected identities, never ownership or export authority. */
  editingCreatorIds?: readonly string[];
  title: string; locale: string; homePageId: string;
  intent?: WebsiteIntentId;
  embedding?:WebsiteEmbedding;
  theme: { id: WebsiteThemeId; version: '1'; settings: { colorMode?: 'light' | 'dark' | 'system'; width?: 'reading' | 'wide'; footer?: string; logoAssetId?: string; faviconAssetId?: string; font?: 'system' | 'serif'; accentColor?: string; headerLayout?:'split'|'centered'|'stacked'; footerLayout?:'split'|'centered'|'minimal'; showWordmark?:boolean; showCopyright?:boolean; membershipUrl?:string; memberAccountUrl?:string; mailingListUrl?:string; bookingUrl?:string; clientGalleryUrl?:string; trailerUrl?:string; podcastFeedUrl?:string; sponsorshipUrl?:string; inquiryUrl?:string; ticketsUrl?:string; courseUrl?:string; storeUrl?:string; audioUrl?:string; releaseUrl?:string; merchandiseUrl?:string } };
  galleryDefault: GalleryDestinationRule; mediaMode: 'bundled' | 'linked';
  basePath: string; publicBaseUrl?: string; noindex?: boolean;
  pages: readonly WebsitePage[]; galleryPublicationIds: readonly string[];
  gallerySettings?: readonly WebsiteGallerySettings[];
  namedGalleries?: readonly WebsiteNamedGallery[];
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
/** Exact origins only: paths, credentials, wildcards and CSP syntax are never accepted. */
export const websiteEmbeddingOrigins=(values:readonly string[]):readonly string[]=>{
 if(!Array.isArray(values)||values.length>10)throw new WebsiteError('invalid_embedding','Choose up to 10 exact embedding origins.');
 const origins=values.map(value=>{if(typeof value!=='string'||/[\s;,*'"<>]/.test(value))throw new WebsiteError('invalid_embedding','Use complete origins such as https://www.example.com.');let url:URL;try{url=new URL(value);}catch{throw new WebsiteError('invalid_embedding','Use complete origins such as https://www.example.com.');}if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.pathname!=='/'||url.search||url.hash||!url.hostname||!/^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|\[[a-f0-9:]+\])$/i.test(url.hostname))throw new WebsiteError('invalid_embedding','Enter origins without paths, credentials, query strings or fragments.');return url.origin;});
 const unique=[...new Set(origins)].sort();if(unique.join(' ').length>650)throw new WebsiteError('invalid_embedding','The combined allowed origins must be at most 650 characters.');return unique;
};
export const websiteFrameAncestors=(embedding?:Pick<WebsiteEmbedding,'mode'|'origins'>):string=>{
 if(!embedding||embedding.mode==='disabled')return "'none'";
 if(embedding.mode==='any')return '*';
 if(embedding.mode!=='selected')throw new WebsiteError('invalid_embedding','Choose an embedding access option.');
 const origins=websiteEmbeddingOrigins(embedding.origins);if(!origins.length)throw new WebsiteError('invalid_embedding','Add at least one allowed embedding origin.');return origins.join(' ');
};
export const websiteEmbedCode=(site:Website,publicUrl:string):string=>{
 websiteRoutes(site);if(!site.embedding||site.embedding.mode==='disabled')throw new WebsiteError('embedding_disabled','Enable embedding and save settings first.');
 const base=new URL(websiteExternalUrl(publicUrl));if(base.search||base.hash||!base.pathname.endsWith('/'))throw new WebsiteError('invalid_url','Use the published website URL ending in a slash.');
 const route=websiteRoutes(site).get(site.embedding.pageId);if(!route)throw new WebsiteError('missing_page','Choose an available starting page.');
 const escape=(text:string)=>text.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
 const src=new URL('embed'+route.replace(/^\//,'/'),base).href;
 return `<iframe src="${escape(src)}" title="${escape(site.title)}" width="100%" height="${site.embedding.height}" style="border:0;max-width:100%${site.embedding.responsive?';height:80vh;min-height:320px':''}" loading="lazy" referrerpolicy="strict-origin-when-cross-origin"></iframe>${site.embedding.responsive?`<p><a href="${escape(new URL(route.replace(/^\//,''),base).href)}" target="_blank" rel="noopener noreferrer">Open full site</a></p>`:''}`;
};
export const websiteRoutes = (site: Website): ReadonlyMap<string, string> => {
  if (!site.id || !site.workspaceId || !site.creatorIdentityId || !Number.isSafeInteger(site.revision) || site.revision < 1 || !site.title?.trim() || !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(site.locale)) throw new WebsiteError('invalid_website', 'Website identity, revision, title and locale are required.');
  if(site.contributingCreatorIds!==undefined&&(!Array.isArray(site.contributingCreatorIds)||site.contributingCreatorIds.length>50||site.contributingCreatorIds.some(id=>typeof id!=='string'||! /^[a-zA-Z0-9_:-]{1,160}$/.test(id)||id===site.creatorIdentityId)||new Set(site.contributingCreatorIds).size!==site.contributingCreatorIds.length))throw new WebsiteError('invalid_contributors','Choose up to 50 distinct contributing creator identities.');
  if(site.editingCreatorIds!==undefined&&(!Array.isArray(site.editingCreatorIds)||site.editingCreatorIds.some(id=>!site.contributingCreatorIds?.includes(id))||new Set(site.editingCreatorIds).size!==site.editingCreatorIds.length))throw new WebsiteError('invalid_contributors','Website editors must be connected contributing identities.');
  if(site.embedding){const config=site.embedding;if(config.responsive!==undefined&&typeof config.responsive!=='boolean')throw new WebsiteError('invalid_embedding','Responsive embedding must be on or off.');for(const address of [config.parentUrl,config.sourceUrl])if(address!==undefined){if(typeof address!=='string'||address.length>2048)throw new WebsiteError('invalid_embedding','Enter a valid embedding URL.');if(!address)continue;const url=new URL(websiteExternalUrl(address));if(url.protocol!=='https:'||url.username||url.password||url.hash)throw new WebsiteError('invalid_embedding','Embedding associations require public HTTPS URLs without credentials or fragments.');}if(config.sourceUrl){const source=new URL(config.sourceUrl);if(source.search||!source.pathname.endsWith('/'))throw new WebsiteError('invalid_embedding','Use a source website base URL ending in a slash.');}if(config.parentUrl&&config.mode==='selected'&&!config.origins.includes(new URL(config.parentUrl).origin))throw new WebsiteError('invalid_embedding','Add the parent website origin to allowed embedding origins.');if(!['disabled','selected','any'].includes(config.mode)||!['full','content'].includes(config.presentation)||!Number.isInteger(config.height)||config.height<200||config.height>2000||config.mode!=='disabled'&&!site.pages.some(page=>page.id===config.pageId&&page.state==='ready'))throw new WebsiteError('invalid_embedding','Choose a Ready starting page, presentation and height between 200 and 2000 pixels.');websiteEmbeddingOrigins(config.origins);websiteFrameAncestors(config);}
  websitePath(site.basePath);
  if (site.publicBaseUrl) { const url = new URL(websiteExternalUrl(site.publicBaseUrl)); if (url.pathname !== '/' || url.search || url.hash) throw new WebsiteError('invalid_url', 'Public base URL must be an origin; configure the base path separately.'); }
  if(site.intent!==undefined&&!WEBSITE_INTENTS.some(intent=>intent.id===site.intent))throw new WebsiteError('invalid_intent','Choose a supported website purpose.');
  if (!WEBSITE_THEMES.some(theme=>theme.id===site.theme.id) || site.theme.version !== '1' || Object.keys(site.theme.settings).some(key => !['colorMode','width','footer','logoAssetId','faviconAssetId','font','accentColor','headerLayout','footerLayout','showWordmark','showCopyright','membershipUrl','memberAccountUrl','mailingListUrl','bookingUrl','clientGalleryUrl','trailerUrl','podcastFeedUrl','sponsorshipUrl','inquiryUrl','ticketsUrl','courseUrl','storeUrl','audioUrl','releaseUrl','merchandiseUrl'].includes(key)) || (site.theme.settings.colorMode && !['light','dark','system'].includes(site.theme.settings.colorMode)) || (site.theme.settings.width && !['reading','wide'].includes(site.theme.settings.width)) || (site.theme.settings.font && !['system','serif'].includes(site.theme.settings.font))) throw new WebsiteError('unsupported_theme', 'Unsupported theme or settings.');
  for(const key of ['membershipUrl','memberAccountUrl','mailingListUrl','bookingUrl','clientGalleryUrl','trailerUrl','podcastFeedUrl','sponsorshipUrl','inquiryUrl','ticketsUrl','courseUrl','storeUrl','audioUrl','releaseUrl','merchandiseUrl'] as const){const value=site.theme.settings[key];if(value!==undefined)websiteExternalUrl(value);}
  if(site.theme.settings.showCopyright!==undefined&&typeof site.theme.settings.showCopyright!=='boolean')throw new WebsiteError('invalid_theme','Choose whether to show the copyright notice.');
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
    if (setting.description!==undefined&&(typeof setting.description!=='string'||setting.description.length>5000)) throw new WebsiteError('invalid_gallery','Public gallery summaries must be 5,000 characters or fewer.');
    if (setting.previewAssetId!==undefined&&(typeof setting.previewAssetId!=='string'||! /^[a-zA-Z0-9_:-]{1,160}$/.test(setting.previewAssetId))) throw new WebsiteError('invalid_gallery','Choose a valid public preview image.');
    if (setting.destination) validateRule(setting.destination);
    if (setting.slug) { if(setting.slug.includes('/')) throw new WebsiteError('invalid_path','Gallery slug must be a single segment.'); websitePath(setting.slug); }
    if (setting.canonicalUrl) websiteExternalUrl(setting.canonicalUrl);
  }
  const named=site.namedGalleries??[];
  if(!Array.isArray(named)||named.length>100||new Set(named.map(g=>g.id)).size!==named.length)throw new WebsiteError('invalid_gallery','Use up to 100 uniquely identified website galleries.');
  const names=new Set<string>();
  for(const gallery of named){
    if(typeof gallery.id!=='string'||!/^[a-zA-Z0-9_:-]{1,160}$/.test(gallery.id)||typeof gallery.title!=='string'||!gallery.title.trim()||gallery.title.length>120||typeof gallery.slug!=='string'||!gallery.slug||gallery.slug.includes('/')||gallery.hostingTargetId!==undefined&&(typeof gallery.hostingTargetId!=='string'||!gallery.hostingTargetId||gallery.hostingTargetId.length>200)||!['works','galleries'].includes(gallery.kind)||!['free','preview'].includes(gallery.access)||!Array.isArray(gallery.publicationIds)||new Set(gallery.publicationIds).size!==gallery.publicationIds.length||gallery.publicationIds.some((id:string)=>!site.galleryPublicationIds.includes(id)))throw new WebsiteError('invalid_gallery','Name each gallery and select publications from this website.');
    const slug=websitePath(gallery.slug),identity=(gallery.parentId??'')+':'+slug;
    if(names.has(identity))throw new WebsiteError('invalid_gallery','Gallery paths must be unique within their parent.');names.add(identity);
    const parent=gallery.parentId?named.find(row=>row.id===gallery.parentId):undefined;
    if(gallery.parentId&&(!parent||parent.id===gallery.id||parent.parentId||parent.kind!=='galleries'||gallery.kind!=='works'))throw new WebsiteError('invalid_gallery','Galleries support two levels. A gallery of sub-galleries can contain only Work galleries.');
    if(gallery.kind==='galleries'&&gallery.publicationIds.length)throw new WebsiteError('invalid_gallery','Choose Works or sub-galleries for each gallery; mixed content is not supported yet.');
  }
  const pages = new Map(site.pages.map(page => [page.id, page]));
  if (pages.size !== site.pages.length || !site.pages.length || site.pages.filter(p => p.kind === 'home').length !== 1 || pages.get(site.homePageId)?.kind !== 'home') throw new WebsiteError('invalid_home', 'Exactly one Home page is required.');
  if (new Set(site.galleryPublicationIds).size !== site.galleryPublicationIds.length) throw new WebsiteError('duplicate_selection', 'Gallery publication selections must be unique.');
  for(const footer of [false,true]){const included=site.pages.filter(page=>footer?page.footerNavigation:page.navigation);const members=new Set(included.map(page=>page.id));for(const page of included){const parentId=websiteMenuParent(page,footer);if(parentId&&members.has(parentId)){const parent=pages.get(parentId)!;const grandparent=websiteMenuParent(parent,footer);if(parentId===page.id||grandparent&&members.has(grandparent))throw new WebsiteError('invalid_navigation','Navigation supports top-level items and one dropdown level.');}}}
  const routes = new Map<string, string>(), occupied = new Set<string>();
  for (const page of site.pages) {
    if (page.websiteId !== site.id || page.workspaceId !== site.workspaceId || !page.id || !page.documentId || !page.title?.trim() || !Number.isSafeInteger(page.revision) || page.revision < 1 || !Number.isFinite(page.order) || !['home','page','portfolio','update'].includes(page.kind) || !['draft','ready','archived'].includes(page.state)) throw new WebsiteError('invalid_page', 'Pages and documents must belong to this website and workspace.');
    if(page.heading!==undefined&&typeof page.heading!=='string'||page.showHeading!==undefined&&typeof page.showHeading!=='boolean')throw new WebsiteError('invalid_page','Choose a text heading and whether it is shown.');
    if(page.template&&!WEBSITE_PAGE_TEMPLATES.some(t=>t.id===page.template))throw new WebsiteError('invalid_template','Choose a supported page template.');
    for(const position of [page.coverPosition,page.backgroundPosition])if(position&&(!Number.isFinite(position.x)||!Number.isFinite(position.y)||position.x<0||position.x>1||position.y<0||position.y>1))throw new WebsiteError('invalid_position','Image positions must be between zero and one.');
    for(const id of [page.coverAssetId,page.backgroundAssetId])if(id&&(typeof id!=='string'||!/^[-a-zA-Z0-9_:]{1,160}$/.test(id)))throw new WebsiteError('invalid_media','Choose an image from the library.');
    if(page.footerNavigation!==undefined&&typeof page.footerNavigation!=='boolean')throw new WebsiteError('invalid_navigation','Choose whether this page appears in the footer.');
    for(const order of [page.navigationOrder,page.footerNavigationOrder])if(order!==undefined&&(!Number.isSafeInteger(order)||order<0))throw new WebsiteError('invalid_navigation','Menu order must be a non-negative integer.');
    for(const footer of [false,true]){const id=footer?page.footerNavigationParentId:page.navigationParentId;if(id!==undefined&&id!==null&&(typeof id!=='string'||!pages.has(id)||id===page.id))throw new WebsiteError('invalid_navigation','Choose another page in this website as the menu parent.');}
    if (page.canonicalUrl) websiteExternalUrl(page.canonicalUrl);
    if (page.kind === 'home' && (page.parentId || page.slug || page.state !== 'ready')) throw new WebsiteError('invalid_home', 'Home must be ready, without a parent or slug.');
    const parent = page.parentId ? pages.get(page.parentId) : undefined;
    if (page.parentId && (!parent || parent.id === page.id || parent.parentId || parent.kind === 'home' || parent.kind === 'update' || parent.state === 'archived')) throw new WebsiteError('invalid_hierarchy', 'A sub-page requires a top-level editorial parent; cycles and third levels are forbidden.');
    if (page.kind !== 'home' && (!page.slug || page.slug.includes('/'))) throw new WebsiteError('invalid_path', 'Each editorial slug must be one path segment.');
    if (page.kind === 'update' && page.parentId) throw new WebsiteError('invalid_hierarchy', 'Update routes cannot have an editorial parent.');
    const route = page.kind === 'home' ? '/' : websitePath(page.kind === 'update' ? `/updates/${page.slug}` : `${parent ? '/' + parent.slug : ''}/${page.slug}`);
    if (page.kind !== 'update' && route !== '/galleries/' && /^\/(galleries|updates|assets|page|embed)\//.test(route)) throw new WebsiteError('reserved_route', 'This route namespace is reserved for generated content.');
    if (occupied.has(route)) throw new WebsiteError('route_collision', `Duplicate normalized route: ${route}`);
    occupied.add(route); routes.set(page.id, route);
  }
  for(const gallery of named){const path=websiteNamedGalleryPath(site,gallery);if(occupied.has(path))throw new WebsiteError('route_collision','A named gallery conflicts with a page route.');occupied.add(path);}
  for (const redirect of site.redirects) {
    const route = websitePath(redirect.from);
    if (occupied.has(route) || route === '/' || /^\/(assets|galleries|updates|page|embed)\//.test(route) || ![301,308].includes(redirect.status)) throw new WebsiteError('route_collision', 'Redirect collides with a page or reserved namespace.');
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
