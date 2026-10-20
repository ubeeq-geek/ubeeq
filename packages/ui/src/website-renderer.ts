import { websiteFrameAncestors, websiteMenuParent, websiteMenuOrder, WebsiteError, websiteExternalUrl, websitePath, type ContentBlock, type Website, type WebsiteDocument, type WebsiteGallery, type WebsitePage } from '@ubeeq/core';
import { websiteDesignCss } from './website-design-css.js';
import { parse, parseFragment, serialize } from 'parse5';
import { sanitizeInlineHtml, textToInlineHtml } from './block-content.js';

export const STATIC_BLOCK_SUPPORT = Object.freeze({
  section: 'render', heading: 'render', paragraph: 'render', image: 'public-media',
  video: 'public-media', audio: 'public-media', quote: 'render', divider: 'render',
  embed: 'accepted-link-fallback', file: 'public-media', link: 'render', credit: 'render',
  grouping: 'render', carousel: 'ordered-no-script', pdf_preview: 'public-download-link',
  html_fragment: 'reject', gallery_preview: 'render', premium_promotion: 'public-preview-only',
  selected_portfolio: 'render', gallery_list: 'static-pagination', update_list: 'static-pagination', page_link: 'render'
} satisfies Record<ContentBlock['type'], string>);

export interface StaticWebsiteMedia {
  src: string; mimeType: string; alt: string; width?: number; height?: number;
}
export interface StaticWebsiteGallery extends WebsiteGallery { href?: string; local: boolean; }
export interface StaticWebsiteInput {
  /** Calendar year pinned by the build adapter to keep exports deterministic. */
  copyrightYear?:number;
  creatorIdentities?:readonly {id:string;title:string}[];
  mailingList?: {signupUrl:string;submitUrl:string;consentText:string;offers:readonly {id:string;title:string}[]};
  limits?: { maxPages: number; maxBytes: number };
  apiVersion: '1'; website: Website; routes: ReadonlyMap<string, string>;
  documents: ReadonlyMap<string, WebsiteDocument>;
  galleries: readonly StaticWebsiteGallery[];
  media: ReadonlyMap<string, StaticWebsiteMedia>;
}
export interface RenderedWebsite {
  files: ReadonlyMap<string, string>; warnings: readonly string[];
}
export const escapeWebsiteHtml = (value: string): string => textToInlineHtml(String(value)).replace(/<br>/g, '\n');
const e = escapeWebsiteHtml;
const css = `:root{color-scheme:light;--color-canvas:#fafaf9;--color-text:#202321;--color-muted:#525b55;--color-action:#225e47;--color-border:#a8b2aa;--color-focus:#17623f;--width:72rem;font:18px/1.65 system-ui,sans-serif}*{box-sizing:border-box}body{margin:0;background:var(--color-canvas);color:var(--color-text)}a{color:var(--color-action);text-underline-offset:.2em}a:focus-visible,summary:focus-visible{outline:3px solid var(--color-focus);outline-offset:4px}header,main,footer{max-width:var(--width);margin:auto;padding:2rem clamp(1rem,4vw,3rem)}header{border-bottom:1px solid var(--color-border)}header>a{font-size:1.4rem;font-weight:700}nav ul{list-style:none;display:flex;flex-wrap:wrap;gap:1rem;padding:0}nav ul ul{display:block;padding-left:1rem}a[aria-current]{font-weight:700;text-decoration-thickness:3px}main{min-height:60vh}h1,h2,h3{line-height:1.2;overflow-wrap:anywhere}h1{font-size:clamp(2rem,6vw,3.5rem)}p,blockquote{max-width:70ch}img,video,audio{max-width:100%;height:auto}figure{margin:1.5rem 0}figcaption,.muted{color:var(--color-muted);font-size:.9rem}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,16rem),1fr));gap:2rem}.card{border-bottom:1px solid var(--color-border);padding-bottom:1rem}.card img{width:100%;object-fit:contain}.reading{--width:52rem}.site-logo{max-width:12rem;max-height:5rem;object-fit:contain}footer{border-top:1px solid var(--color-border)}.skip{position:absolute;top:-10rem;left:1rem}.skip:focus{top:1rem;background:var(--color-canvas);padding:1rem}blockquote{border-left:3px solid var(--color-border);padding-left:1rem;margin-left:0}hr{border:0;border-top:1px solid var(--color-border)}.dark{color-scheme:dark;--color-canvas:#181e1a;--color-text:#edf2ee;--color-muted:#b7c2b9;--color-action:#a3dfba;--color-border:#819687;--color-focus:#a3dfba}@media(prefers-color-scheme:dark){.system{color-scheme:dark;--color-canvas:#181e1a;--color-text:#edf2ee;--color-muted:#b7c2b9;--color-action:#a3dfba;--color-border:#819687;--color-focus:#a3dfba}}@media(max-width:40rem){header,main,footer{padding:1.25rem}nav ul{gap:.75rem}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto}}`;

/** Pure renderer: no catalogue, credential, network, clock, or storage access. */
export const renderStaticWebsite = (input: StaticWebsiteInput): RenderedWebsite => {
  if (input.apiVersion !== '1') throw new WebsiteError('unsupported_schema', 'Unsupported website snapshot version.');
  const { website: site, routes, documents, galleries, media } = input;
  const base = websitePath(site.basePath).replace(/\/$/, '');
  const url = (path: string) => base + path;
  const absolute = (path: string) => site.publicBaseUrl ? new URL(url(path), site.publicBaseUrl).href : undefined;
  const files = new Map<string, string>(), warnings: string[] = [], imagePositions=new Map<string,string>();
  const pages = site.pages.filter(p => p.state === 'ready');
  const limits = input.limits ?? { maxPages: 200, maxBytes: 50 * 1024 * 1024 };
  if (![limits.maxPages, limits.maxBytes].every(n => Number.isSafeInteger(n) && n > 0)) throw new WebsiteError('invalid_limits', 'Render limits must be positive integers.');
  let plannedPages = pages.length + galleries.filter(g => g.local).length + site.redirects.length + 1;
  if (plannedPages > limits.maxPages) throw new WebsiteError('quota_exceeded', 'Generated page limit exceeded.');
  let outputBytes = 0;
  const write = (name: string, content: string) => {
    const bytes = new TextEncoder().encode(content).byteLength;
    if (bytes > limits.maxBytes - outputBytes) throw new WebsiteError('quota_exceeded', 'Generated website byte limit exceeded.');
    outputBytes += bytes;
    files.set(name, content);
  };
  const pathFile = (path: string) => path === '/' ? 'index.html' : decodeURIComponent(path.slice(1)) + 'index.html';
  const add = (path: string, html: string) => {
    const name = pathFile(path);
    if (files.has(name)) throw new WebsiteError('route_collision', `Duplicate generated route: ${path}`);
    write(name, html);
  };
  const link = (value: string, contact = true): string => {
    if (value.startsWith('#')) {
      if (!/^#[a-zA-Z][a-zA-Z0-9_-]*$/.test(value)) throw new WebsiteError('invalid_fragment', 'Invalid fragment link.');
      return value;
    }
    if (value.startsWith('/') && !value.startsWith('//')) {
      const [path, fragment] = value.split('#');
      if (value.split('#').length > 2 || (fragment && !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(fragment))) throw new WebsiteError('invalid_fragment', 'Invalid fragment link.');
      return url(websitePath(path)) + (fragment ? '#' + fragment : '');
    }
    return websiteExternalUrl(value, contact);
  };
  const inline = (block: ContentBlock) => {
    const root = parseFragment(sanitizeInlineHtml(block.html ?? textToInlineHtml(block.quote ?? block.text ?? '')));
    const pending = [...root.childNodes];
    while (pending.length) {
      const node = pending.pop()!;
      if ('attrs' in node) for (const attr of node.attrs) if (attr.name === 'href') attr.value = link(attr.value);
      if ('childNodes' in node) pending.push(...node.childNodes);
    }
    return serialize(root);
  };
  const nav = (current: string, footer=false) => {
    const visible = pages.filter(p => (footer?(p.footerNavigation??false):p.navigation)).sort((a,b) => websiteMenuOrder(a,footer)-websiteMenuOrder(b,footer) || a.id.localeCompare(b.id, 'en'));
    const item = (p: WebsitePage) => `<a href="${e(url(routes.get(p.id)!))}"${routes.get(p.id) === current ? ' aria-current="page"' : ''}>${e(p.navigationLabel ?? p.title)}</a>`;
    const entries=visible.filter(p=>!websiteMenuParent(p,footer)||!visible.some(parent=>parent.id===websiteMenuParent(p,footer))).map(p=>{
      const children=visible.filter(child=>websiteMenuParent(child,footer)===p.id);
      return `<li>${children.length?`<details class="nav-dropdown"><summary>${e(p.navigationLabel??p.title)}</summary><ul><li>${item(p)}</li>${children.map(child=>`<li>${item(child)}</li>`).join('')}</ul></details>`:item(p)}</li>`;
    }).join('');
    const extra=footer?site.footerLinks:site.navigationLinks;
    return `<nav aria-label="${footer?'Footer':'Main'}"><ul>${entries}${(extra??[]).map(item=>`<li><a href="${e(websiteExternalUrl(item.url,true))}">${e(item.label)}</a></li>`).join('')}</ul></nav>`;
  };
  const shell = (title: string, body: string, path: string, meta: { heading?:string;showHeading?:boolean;description?: string; canonicalUrl?: string; noindex?: boolean; seoTitle?: string; socialAssetId?: string; layout?: 'reading'|'wide';template?:WebsitePage['template'];coverAssetId?:string;backgroundAssetId?:string;coverPosition?:WebsitePage['coverPosition'];backgroundPosition?:WebsitePage['backgroundPosition'] } = {}) => {
    const canonical = meta.canonicalUrl ?? absolute(path);
    const logo=site.theme.settings.logoAssetId?media.get(site.theme.settings.logoAssetId):undefined;
    const favicon=site.theme.settings.faviconAssetId?media.get(site.theme.settings.faviconAssetId):undefined;
    const social=meta.socialAssetId?media.get(meta.socialAssetId):undefined;
    for(const asset of [logo,favicon,social]) if(asset&&!asset.mimeType.startsWith('image/')) throw new WebsiteError('invalid_media','Logo, favicon and social previews must be public images.');
    const designImage=(id:string|undefined,position:{x:number;y:number}|undefined,cover:boolean)=>{
      if(!id)return '';const asset=media.get(id);if(!asset||!asset.mimeType.startsWith('image/'))throw new WebsiteError('missing_media','A page design image is unavailable.');
      const coordinate=(value:number|undefined)=>Number.isFinite(value)?Math.round(Math.max(0,Math.min(1,value!))*100):50;
      const x=coordinate(position?.x),y=coordinate(position?.y),name=`image-position-${x}-${y}`;imagePositions.set(name,`.${name}{object-position:${x}% ${y}%}`);
      return `<img class="${name}" src="${e(asset.src)}" alt="${cover?e(asset.alt):''}"${cover?' loading="eager"':''}>`;
    };
    const cover=designImage(meta.coverAssetId,meta.coverPosition,true),background=designImage(meta.backgroundAssetId,meta.backgroundPosition,false);
    const header=site.theme.settings.headerLayout??'split',footer=site.theme.settings.footerLayout??'split';
    const brand=(header!=='centered'&&logo?`<img class="site-logo" src="${e(logo.src)}" alt="${e(site.title)}">`:'')+(header==='centered'||!logo||site.theme.settings.showWordmark!==false?`<span class="site-wordmark">${e(site.title)}</span>`:'');
    const socialUrl=social?(site.publicBaseUrl?new URL(social.src,site.publicBaseUrl).href:social.src):undefined;
    return `<!doctype html><html lang="${e(site.locale)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(meta.seoTitle??title)} — ${e(site.title)}</title>${site.theme.settings.podcastFeedUrl?`<link rel="alternate" type="application/rss+xml" title="Public podcast feed" href="${e(websiteExternalUrl(site.theme.settings.podcastFeedUrl))}">`:''}${favicon?`<link rel="icon" href="${e(favicon.src)}">`:""}${socialUrl?`<meta property="og:image" content="${e(socialUrl)}">`:""}<meta property="og:title" content="${e(meta.seoTitle??title)}">${meta.description ? `<meta name="description" content="${e(meta.description)}">` : ''}${site.noindex || meta.noindex ? '<meta name="robots" content="noindex,nofollow">' : ''}${canonical ? `<link rel="canonical" href="${e(canonical)}">` : ''}<link rel="stylesheet" href="${e(url('/assets/theme.css'))}"></head><body class="theme-${e(site.theme.id)} ${e(site.theme.settings.colorMode ?? 'light')} ${site.theme.settings.width === 'reading' ? 'reading' : ''}"><a class="skip" href="#main">Skip to content</a><header class="site-header ${header}"><a class="site-brand" href="${e(url('/'))}">${brand}</a>${nav(path)}${site.intent==='photography'&&site.theme.settings.bookingUrl?`<a class="website-action primary" href="${e(websiteExternalUrl(site.theme.settings.bookingUrl))}">Book a session</a>`:site.intent==='music'&&site.theme.settings.releaseUrl?`<a class="website-action primary" href="${e(websiteExternalUrl(site.theme.settings.releaseUrl))}">Buy the release</a>`:site.theme.settings.membershipUrl?`<a class="website-action primary" href="${e(websiteExternalUrl(site.theme.settings.membershipUrl))}">Membership</a>`:''}${site.theme.settings.memberAccountUrl?`<a href="${e(websiteExternalUrl(site.theme.settings.memberAccountUrl))}">Member account</a>`:''}</header><main id="main" class="template-${e(meta.template??'standard')} ${meta.layout==='reading'?'reading':''} ${background?'has-background':''} ${cover?'has-cover':''} ${meta.showHeading===false?'no-page-heading':''}">${background?`<div class="page-background" aria-hidden="true">${background}</div>`:''}<div class="page-surface">${cover?`<figure class="page-cover">${cover}</figure>`:''}${meta.showHeading===false?'':`<div class="page-heading"><h1>${e(meta.heading?.trim()||title)}</h1></div>`}<div class="page-content">${body}</div></div></main><footer class="site-footer ${footer}"><div class="site-footer-text">${site.theme.settings.footer?`<p>${e(site.theme.settings.footer)}</p>`:''}${site.theme.settings.showCopyright!==false?`<p class="site-copyright">© ${input.copyrightYear===undefined?'':`${e(String(input.copyrightYear))} `}${e(site.title)}</p>`:''}</div>${nav(path,true)}</footer></body></html>`;
  };
  const image = (id: string, caption?: string, expected: 'image' | 'video' | 'audio' | 'file' = 'image', href?:string) => {
    const asset = media.get(id);
    if (!asset) throw new WebsiteError('missing_media', 'An approved public rendition is missing.');
    const source = e(asset.src);
    if (expected !== 'file' && !asset.mimeType.startsWith(expected + '/')) throw new WebsiteError('invalid_media', 'Rendition type does not match the block.');
    const content = expected === 'image' ? `<a href="${e(href??asset.src)}"><img src="${source}" alt="${e(asset.alt)}" loading="lazy"${asset.width ? ` width="${asset.width}"` : ''}${asset.height ? ` height="${asset.height}"` : ''}></a>`
      : expected === 'file' ? `<a href="${source}">${e(caption || 'Download public file')}</a>`
      : `<${expected} controls preload="metadata" src="${source}"><a href="${source}">Open ${expected}</a></${expected}>`;
    return `<figure>${content}${caption ? `<figcaption>${e(caption)}</figcaption>` : ''}</figure>`;
  };
  const card = (g: StaticWebsiteGallery, promotion = false) => !g.href ? '' : `<article class="card">${g.previewAssetIds[0] ? image(g.previewAssetIds[0],undefined,'image',g.href.startsWith('/')?url(g.href):websiteExternalUrl(g.href)) : ''}<h2><a href="${e(g.href.startsWith('/') ? url(g.href) : g.href)}">${e(g.title)}</a></h2>${g.creatorName?`<p class="work-creator">${e(g.creatorName)}</p>`:''}${g.description ? `<p>${e(g.description)}</p>` : ''}${g.premium?'<p class="gallery-access">Public preview · membership access</p>':''}${promotion ? '<p>View access options at the linked destination.</p>' : ''}</article>`;
  for (const page of pages) {
    const path = routes.get(page.id)!, doc = documents.get(page.documentId);
    if (!doc) throw new WebsiteError('missing_document', 'Page document was not resolved.');
    let blockNumber = 0;
    const extraPages: { path: string; title: string; body: () => string }[] = [];
    const renderBlocks = (blocks: readonly ContentBlock[]): string => blocks.map(block => {
      const index = ++blockNumber;
      if (!(block.type in STATIC_BLOCK_SUPPORT)) throw new WebsiteError('unsupported_block', `Unsupported static block: ${block.type}`);
      const children = () => renderBlocks(block.children ?? []);
      const refs = () => {
        const ids = block.data?.publicationIds;
        if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) throw new WebsiteError('invalid_block', 'Gallery blocks require publication IDs.');
        return ids.map(id => { const g = galleries.find(g => g.publicationId === id); if (!g) throw new WebsiteError('missing_publication', 'Block publication is not in the eligible website pool.'); return g; });
      };
      const paginated = (items: readonly string[],base=path,prefix='') => {
        const size = Number(block.data?.pageSize ?? 12);
        if (!Number.isSafeInteger(size) || size < 1 || size > 100) throw new WebsiteError('invalid_query', 'Page size must be 1–100.');
        if (!items.length) return prefix+(block.data?.empty === 'omit' ? '' : `<p>${e(String(block.data?.emptyMessage ?? 'No entries yet.'))}</p>`);
        const count = Math.ceil(items.length / size);
        if (count - 1 > limits.maxPages - plannedPages) throw new WebsiteError('quota_exceeded', 'Generated pagination exceeds the page limit.');
        plannedPages += count - 1;
        const listPath = (n: number) => n === 1 ? base : `${base}page/${index}/${n}/`;
        const content = (n: number) => `${prefix}<div class="grid">${items.slice((n-1)*size,n*size).join('')}</div>${count > 1 ? `<nav aria-label="List pages">${Array.from({length:count},(_,i) => `<a href="${e(url(listPath(i+1)))}"${n === i+1 ? ' aria-current="page"' : ''}>Page ${i+1}</a>`).join(' ')}</nav>` : ''}`;
        for (let n=2;n<=count;n++) extraPages.push({path:listPath(n),title:`${page.title} — Page ${n}`,body:()=>content(n)});
        return content(1);
      };
      switch (block.type) {
        case 'paragraph': return `<p>${inline(block)}</p>`;
        case 'heading': { const n = Math.max(2, Math.min(6, block.level ?? 2)); return `<h${n} id="heading-${index}">${inline(block)}</h${n}>`; }
        case 'quote': return `<blockquote>${inline(block)}${block.author ? `<cite>${e(block.author)}</cite>` : ''}</blockquote>`;
        case 'divider': return '<hr>';
        case 'section': {const variant=String(block.data?.presentation??'standard');if(!['standard','intro','callout','pricing','plan','faq','faq_item','screening','excerpt','bibliography','release','episode','episodes','creators'].includes(variant))throw new WebsiteError('invalid_block','Unknown section layout.');return variant==='faq_item'?`<details class="website-faq"><summary>${e(block.title??'Question')}</summary>${children()}</details>`:`<section class="section-${variant}">${block.title?`<h2>${e(block.title)}</h2>`:''}${children()}${variant==='creators'?`<ul class="website-creator-list">${(input.creatorIdentities??[]).map(identity=>`<li><h3>${e(identity.title)}</h3></li>`).join('')}</ul>`:''}</section>`;}
        case 'grouping': case 'carousel': return `<div class="grid">${children()}</div>`;
        case 'image': case 'video': case 'audio': return image(block.assetId ?? '', block.caption, block.type);
        case 'file': case 'pdf_preview': return image(block.fileId ?? block.assetId ?? '', block.label ?? block.caption, 'file');
        case 'link': {const action=block.data?.action,setting=action==='membership'?'membershipUrl':action==='account'?'memberAccountUrl':action==='mailing'?'mailingListUrl':action==='booking'?'bookingUrl':action==='clients'?'clientGalleryUrl':action==='trailer'?'trailerUrl':action==='inquiry'?'inquiryUrl':action==='tickets'?'ticketsUrl':action==='course'?'courseUrl':action==='store'?'storeUrl':action==='podcast_feed'?'podcastFeedUrl':action==='sponsorship'?'sponsorshipUrl':action==='audio'?'audioUrl':action==='release'?'releaseUrl':action==='merch'?'merchandiseUrl':undefined;const target=setting?site.theme.settings[setting]:block.url;if(!target&&setting)return '';
          if(action==='mailing'&&input.mailingList&&String(target)===input.mailingList.signupUrl){const mailing=input.mailingList;return `<form class="website-mailing-form" data-website-mailing="true" method="post" action="${e(link(mailing.submitUrl))}" accept-charset="UTF-8"><label>Email address<input type="email" name="email" autocomplete="email" maxlength="254" required></label>${mailing.offers.length?`<label>Free offer (optional)<select name="offerId"><option value="">Updates only</option>${mailing.offers.map(offer=>`<option value="${e(offer.id)}">${e(offer.title)}</option>`).join('')}</select></label>`:''}<input type="hidden" name="consentText" value="${e(mailing.consentText)}"><label class="website-mailing-consent"><input type="checkbox" name="consent" value="true" required><span>${e(mailing.consentText)}</span></label><button type="submit" class="website-action primary">${e(block.label??'Subscribe')}</button><p class="website-mailing-help">Check your inbox to confirm your email. Your subscription starts after confirmation.</p></form>`;}
          const appearance=block.data?.appearance??'text';if(!['text','primary','secondary'].includes(String(appearance)))throw new WebsiteError('invalid_block','Unknown link style.');return `<p><a class="website-action ${appearance}" href="${e(link(target??''))}">${e(block.label??block.title??'Link')}</a></p>`;}
        case 'credit': return `<p>${e(block.author ?? '')} ${inline(block)}${block.url ? ` <a href="${e(link(block.url))}">${e(block.label ?? 'Credit')}</a>` : ''}</p>`;
        case 'embed':
          if (block.data?.staticFallback !== 'link' || !block.url) throw new WebsiteError('unsupported_block', 'External embeds require an explicitly accepted link fallback.');
          warnings.push('External embed exported as a labelled link.');
          return `<p><a href="${e(websiteExternalUrl(block.url))}">${e(block.title ?? 'View external media')}</a> (external media)</p>`;
        case 'html_fragment': throw new WebsiteError('unsupported_block', 'Executable authored HTML is not supported in static exports; convert it to structured blocks.');
        case 'page_link': { const id = String(block.data?.pageId ?? ''), target = pages.find(p => p.id === id); if (!target) throw new WebsiteError('missing_page', 'Linked page is not included in this release.'); return `<p><a href="${e(url(routes.get(id)!))}">${e(block.label ?? target.title)}</a></p>`; }
        case 'gallery_preview': case 'premium_promotion': { const selected = refs(); if (selected.length !== 1) throw new WebsiteError('invalid_block', 'Preview blocks select exactly one publication.'); return card(selected[0], block.type === 'premium_promotion'); }
        case 'selected_portfolio': return `<div class="grid">${refs().map(g => card(g)).join('')}</div>`;
        case 'gallery_list': {
          let selected = galleries.filter(g => g.href);
          const tags = block.data?.tags, collections = block.data?.collectionIds, publications = block.data?.publicationIds,creators=block.data?.creatorIdentityIds;
          for (const filter of [tags, collections, publications,creators]) if (filter !== undefined && (!Array.isArray(filter) || filter.some(v => typeof v !== 'string'))) throw new WebsiteError('invalid_query', 'Query filters must be string arrays.');
          if (Array.isArray(tags)) selected = selected.filter(g => tags.every(t => g.tags.includes(t)));
          if (Array.isArray(collections) && collections.length) selected = selected.filter(g => collections.some(c => g.collectionIds.includes(c)));
          if (Array.isArray(publications) && publications.length) selected = selected.filter(g => publications.includes(g.publicationId));
          if(Array.isArray(creators)&&creators.length)selected=selected.filter(g=>creators.includes(g.creatorIdentityId??site.creatorIdentityId));
          const sort = block.data?.sort ?? 'newest';
          if (!['newest','oldest','title'].includes(String(sort))) throw new WebsiteError('invalid_query', 'Unsupported gallery sort.');
          selected.sort((a,b) => (sort === 'title' ? a.title.localeCompare(b.title,'en') : sort === 'oldest' ? a.date.localeCompare(b.date) : b.date.localeCompare(a.date)) || a.publicationId.localeCompare(b.publicationId,'en'));
          const max = Number(block.data?.maxResults ?? 1000);
          if (!Number.isSafeInteger(max) || max < 1 || max > 1000) throw new WebsiteError('invalid_query', 'Maximum results must be 1–1000.');
          selected=selected.slice(0,max);
          const identities=input.creatorIdentities?new Map(input.creatorIdentities.filter(creator=>!Array.isArray(creators)||!creators.length||creators.includes(creator.id)).map(creator=>[creator.id,creator.title])):new Map(selected.map(g=>[g.creatorIdentityId??site.creatorIdentityId,g.creatorName??'Creator']));
          if(identities.size<2)return paginated(selected.map(g=>card(g)));
          const creatorPaths=new Map<string,string>(),usedNames=new Set<string>();for(const [id,name] of identities){const base=name.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}_-]+/gu,'-').replace(/^-+|-+$/g,'').slice(0,70)||'creator';let slug=base,n=2;while(usedNames.has(slug))slug=base+'-'+n++;usedNames.add(slug);creatorPaths.set(id,`${path}creator/${index}/${encodeURIComponent(slug)}/`);}
          const filterPath=(id:string)=>creatorPaths.get(id)!;
          const filter=(active?:string)=>`<nav class="gallery-creator-filter" aria-label="Filter gallery by creator"><a href="${e(url(path))}"${!active?' aria-current="page"':''}>All creators</a> ${[...identities].map(([id,name])=>`<a href="${e(url(filterPath(id)))}"${active===id?' aria-current="page"':''}>${e(name)}</a>`).join(' ')}</nav>`;
          for(const [id,name] of identities){if(++plannedPages>limits.maxPages)throw new WebsiteError('quota_exceeded','Creator filters exceed the page limit.');const body=paginated(selected.filter(g=>(g.creatorIdentityId??site.creatorIdentityId)===id).map(g=>card(g)),filterPath(id),filter(id));extraPages.push({path:filterPath(id),title:page.title+' — '+name,body:()=>body});}
          return paginated(selected.map(g => card(g)),path,filter());
        }
        case 'update_list': return paginated(pages.filter(p => p.kind === 'update').sort((a,b) => (b.date ?? '').localeCompare(a.date ?? '') || a.id.localeCompare(b.id,'en')).map(p => `<article><h2><a href="${e(url(routes.get(p.id)!))}">${e(p.title)}</a></h2>${p.date ? `<time datetime="${e(p.date)}">${e(p.date)}</time>` : ''}<p>${e(p.excerpt ?? '')}</p></article>`));
      }
    }).join('');
    add(path, shell(page.title, renderBlocks(doc.blocks), path, page));
    for (const extra of extraPages) add(extra.path, shell(extra.title, extra.body(), extra.path,{...page,seoTitle:undefined,canonicalUrl:undefined}));
  }
  for (const g of galleries.filter(g => g.local)) {
    const path = websitePath(`/galleries/${g.slug}`);
    add(path, shell(g.title, `${g.creatorName?`<p class="work-creator">${e(g.creatorName)}</p>`:''}<p>${e(g.description ?? '')}</p><div class="grid">${g.publicAssetIds.map(id => image(id)).join('')}</div>`, path, { canonicalUrl: g.canonicalUrl }));
  }
  for (const redirect of site.redirects) {
    const path = websitePath(redirect.from), to = redirect.to.startsWith('/') ? url(websitePath(redirect.to)) : websiteExternalUrl(redirect.to);
    add(path, shell('Page moved', `<p><a href="${e(to)}">Continue to the new page</a></p>`,path,{noindex:true}));
    warnings.push('Portable redirects are HTML link pages, not HTTP 301/308 responses.');
  }
  write('404.html', shell('Page not found', `<p><a href="${e(url('/'))}">Return Home</a></p>`, '/404/', {noindex:true}));
  write('assets/theme.css', css+websiteDesignCss(site)+[...imagePositions.values()].join('')+(site.theme.settings.font==='serif'?'body{font-family:Georgia,serif}':'')+(site.theme.settings.accentColor?`body.light,body.dark,body.system{--color-action:${site.theme.settings.accentColor};--color-focus:${site.theme.settings.accentColor}}`:''));
  write('robots.txt', `User-agent: *\n${site.noindex ? 'Disallow: /' : 'Allow: /'}\n${site.publicBaseUrl ? `Sitemap: ${absolute('/sitemap.xml')}\n` : ''}`);
  write('redirects.json',JSON.stringify({apiVersion:'1',redirects:site.redirects.map(r=>({from:url(websitePath(r.from)),to:r.to.startsWith('/')?url(websitePath(r.to)):websiteExternalUrl(r.to),status:r.status}))},null,2)+'\n');
  const sitemapPaths = [...files.keys()].filter(name => name.endsWith('index.html')).map(name => name === 'index.html' ? '/' : '/' + name.slice(0,-10).split('/').map(encodeURIComponent).join('/')).filter(path => !pages.some(p => routes.get(p.id) === path && p.noindex) && !site.redirects.some(r => websitePath(r.from) === path));
  write('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${!site.noindex && site.publicBaseUrl ? sitemapPaths.map(path => `<url><loc>${e(absolute(path)!)}</loc></url>`).join('') : ''}</urlset>`);
  const ancestors=websiteFrameAncestors(site.embedding);
  write('embedding.json',JSON.stringify({apiVersion:'1',mode:site.embedding?.mode??'disabled',origins:site.embedding?.origins??[],frameAncestors:ancestors})+'\n');
  write('_headers',`${url('/*')}\n  Content-Security-Policy: frame-ancestors ${ancestors}\n`);
  if(site.embedding&&site.embedding.mode!=='disabled'){
    const pagesToEmbed=[...files].filter(([name])=>name.endsWith('.html'));if(pagesToEmbed.length*2>limits.maxPages)throw new WebsiteError('quota_exceeded','Embedding views exceed the generated page limit.');
    const destinations=new Map(pagesToEmbed.map(([name])=>{const route=name==='index.html'?'/':name.endsWith('/index.html')?'/'+name.slice(0,-10):'/'+name;return [url(route),url('/embed'+route)];}));
    for(const [name,html]of pagesToEmbed){
      const doc=parse(html),pending:any[]=[doc];
      const remove=(node:any)=>{if(node.parentNode)node.parentNode.childNodes=node.parentNode.childNodes.filter((child:any)=>child!==node);};
      while(pending.length){const node=pending.pop();if(node.tagName==='header'&&node.attrs?.some((a:any)=>a.name==='class'&&a.value.includes('site-header'))||node.tagName==='footer'&&node.attrs?.some((a:any)=>a.name==='class'&&a.value.includes('site-footer'))){if(site.embedding.presentation==='content'){remove(node);continue;}}
        if(node.attrs){for(const attr of node.attrs){if(attr.name==='href'&&destinations.has(attr.value))attr.value=destinations.get(attr.value);}
          if(node.tagName==='a'){const href=node.attrs.find((a:any)=>a.name==='href')?.value??'';if(/^https?:|^mailto:/i.test(href)){node.attrs=node.attrs.filter((a:any)=>!['target','rel'].includes(a.name));node.attrs.push({name:'target',value:'_blank'},{name:'rel',value:'noopener noreferrer'});}}
          if(node.tagName==='form'){node.attrs=node.attrs.filter((a:any)=>a.name!=='target');node.attrs.push({name:'target',value:'_blank'});}
        }
        if(node.tagName==='head'){node.childNodes.push({nodeName:'meta',tagName:'meta',attrs:[{name:'name',value:'robots'},{name:'content',value:'noindex,nofollow'}],namespaceURI:'http://www.w3.org/1999/xhtml',childNodes:[],parentNode:node});}
        if(node.childNodes)pending.push(...node.childNodes);
      }
      write('embed/'+name,serialize(doc));
    }
  }
  write('README.txt', `Static website\n\nServe this directory with a generic static HTTP server at ${websitePath(site.basePath)}.\nNo application runtime is required. Directory index files must be enabled.\nMedia mode: ${site.mediaMode}. ${site.mediaMode === 'linked' ? 'Public media depends on its configured delivery provider.' : 'Public media is bundled.'}\nExternal links and accepted embed links require their destinations to be available.\nRedirect pages provide links; configure HTTP redirects separately if required.\nDownloading this archive does not confirm a live deployment.\n\nEmbedding: ${site.embedding?.mode??'disabled'}. Set the HTTP response header Content-Security-Policy: frame-ancestors ${ancestors} on every HTML page. Netlify and Cloudflare Pages can use the included _headers file; SFTP/generic servers require host configuration. HTML meta tags do not enforce frame-ancestors. Do not add a conflicting X-Frame-Options header when allowing external embedding. Embedding requires a published URL; temporary previews are not shareable embed URLs.\n`);
  return { files, warnings };
};
