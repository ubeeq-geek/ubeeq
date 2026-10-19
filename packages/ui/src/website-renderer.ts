import { WebsiteError, websiteExternalUrl, websitePath, type ContentBlock, type Website, type WebsiteDocument, type WebsiteGallery, type WebsitePage } from '@ubeeq/core';
import { parseFragment, serialize } from 'parse5';
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
  const files = new Map<string, string>(), warnings: string[] = [];
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
  const nav = (current: string) => {
    const visible = pages.filter(p => p.navigation && p.kind !== 'update').sort((a,b) => a.order-b.order || a.id.localeCompare(b.id, 'en'));
    const item = (p: WebsitePage) => `<a href="${e(url(routes.get(p.id)!))}"${routes.get(p.id) === current ? ' aria-current="page"' : ''}>${e(p.navigationLabel ?? p.title)}</a>`;
    return `<nav aria-label="Main"><ul>${visible.filter(p => !p.parentId).map(p => `<li>${item(p)}${visible.some(child => child.parentId === p.id) ? `<ul>${visible.filter(child => child.parentId === p.id).map(child => `<li>${item(child)}</li>`).join('')}</ul>` : ''}</li>`).join('')}${(site.navigationLinks??[]).map(item=>`<li><a href="${e(websiteExternalUrl(item.url,true))}">${e(item.label)}</a></li>`).join('')}</ul></nav>`;
  };
  const shell = (title: string, body: string, path: string, meta: { description?: string; canonicalUrl?: string; noindex?: boolean; seoTitle?: string; socialAssetId?: string; layout?: 'reading'|'wide' } = {}) => {
    const canonical = meta.canonicalUrl ?? absolute(path);
    const logo=site.theme.settings.logoAssetId?media.get(site.theme.settings.logoAssetId):undefined;
    const favicon=site.theme.settings.faviconAssetId?media.get(site.theme.settings.faviconAssetId):undefined;
    const social=meta.socialAssetId?media.get(meta.socialAssetId):undefined;
    for(const asset of [logo,favicon,social]) if(asset&&!asset.mimeType.startsWith('image/')) throw new WebsiteError('invalid_media','Logo, favicon and social previews must be public images.');
    const socialUrl=social?(site.publicBaseUrl?new URL(social.src,site.publicBaseUrl).href:social.src):undefined;
    return `<!doctype html><html lang="${e(site.locale)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(meta.seoTitle??title)} — ${e(site.title)}</title>${favicon?`<link rel="icon" href="${e(favicon.src)}">`:""}${socialUrl?`<meta property="og:image" content="${e(socialUrl)}">`:""}<meta property="og:title" content="${e(meta.seoTitle??title)}">${meta.description ? `<meta name="description" content="${e(meta.description)}">` : ''}${site.noindex || meta.noindex ? '<meta name="robots" content="noindex,nofollow">' : ''}${canonical ? `<link rel="canonical" href="${e(canonical)}">` : ''}<link rel="stylesheet" href="${e(url('/assets/theme.css'))}"></head><body class="${e(site.theme.settings.colorMode ?? 'light')} ${site.theme.settings.width === 'reading' ? 'reading' : ''}"><a class="skip" href="#main">Skip to content</a><header><a href="${e(url('/'))}">${logo?`<img class="site-logo" src="${e(logo.src)}" alt="${e(site.title)}">`:e(site.title)}</a>${nav(path)}</header><main id="main"${meta.layout==='reading'?' class="reading"':''}><h1>${e(title)}</h1>${body}</main><footer>${e(site.theme.settings.footer ?? '')}${site.footerLinks?.length?`<nav aria-label="Footer"><ul>${site.footerLinks.map(item=>`<li><a href="${e(websiteExternalUrl(item.url,true))}">${e(item.label)}</a></li>`).join('')}</ul></nav>`:''}</footer></body></html>`;
  };
  const image = (id: string, caption?: string, expected: 'image' | 'video' | 'audio' | 'file' = 'image') => {
    const asset = media.get(id);
    if (!asset) throw new WebsiteError('missing_media', 'An approved public rendition is missing.');
    const source = e(asset.src);
    if (expected !== 'file' && !asset.mimeType.startsWith(expected + '/')) throw new WebsiteError('invalid_media', 'Rendition type does not match the block.');
    const content = expected === 'image' ? `<a href="${source}"><img src="${source}" alt="${e(asset.alt)}" loading="lazy"${asset.width ? ` width="${asset.width}"` : ''}${asset.height ? ` height="${asset.height}"` : ''}></a>`
      : expected === 'file' ? `<a href="${source}">${e(caption || 'Download public file')}</a>`
      : `<${expected} controls preload="metadata" src="${source}"><a href="${source}">Open ${expected}</a></${expected}>`;
    return `<figure>${content}${caption ? `<figcaption>${e(caption)}</figcaption>` : ''}</figure>`;
  };
  const card = (g: StaticWebsiteGallery, promotion = false) => !g.href ? '' : `<article class="card">${g.previewAssetIds[0] ? image(g.previewAssetIds[0]) : ''}<h2><a href="${e(g.href.startsWith('/') ? url(g.href) : g.href)}">${e(g.title)}</a></h2>${g.description ? `<p>${e(g.description)}</p>` : ''}${promotion ? '<p>View access options at the linked destination.</p>' : ''}</article>`;
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
      const paginated = (items: readonly string[]) => {
        const size = Number(block.data?.pageSize ?? 12);
        if (!Number.isSafeInteger(size) || size < 1 || size > 100) throw new WebsiteError('invalid_query', 'Page size must be 1–100.');
        if (!items.length) return block.data?.empty === 'omit' ? '' : `<p>${e(String(block.data?.emptyMessage ?? 'No entries yet.'))}</p>`;
        const count = Math.ceil(items.length / size);
        if (count - 1 > limits.maxPages - plannedPages) throw new WebsiteError('quota_exceeded', 'Generated pagination exceeds the page limit.');
        plannedPages += count - 1;
        const listPath = (n: number) => n === 1 ? path : `${path}page/${index}/${n}/`;
        const content = (n: number) => `<div class="grid">${items.slice((n-1)*size,n*size).join('')}</div>${count > 1 ? `<nav aria-label="List pages">${Array.from({length:count},(_,i) => `<a href="${e(url(listPath(i+1)))}"${n === i+1 ? ' aria-current="page"' : ''}>Page ${i+1}</a>`).join(' ')}</nav>` : ''}`;
        for (let n=2;n<=count;n++) extraPages.push({path:listPath(n),title:`${page.title} — Page ${n}`,body:()=>content(n)});
        return content(1);
      };
      switch (block.type) {
        case 'paragraph': return `<p>${inline(block)}</p>`;
        case 'heading': { const n = Math.max(2, Math.min(6, block.level ?? 2)); return `<h${n} id="heading-${index}">${inline(block)}</h${n}>`; }
        case 'quote': return `<blockquote>${inline(block)}${block.author ? `<cite>${e(block.author)}</cite>` : ''}</blockquote>`;
        case 'divider': return '<hr>';
        case 'section': return `<section>${block.title ? `<h2>${e(block.title)}</h2>` : ''}${children()}</section>`;
        case 'grouping': case 'carousel': return `<div class="grid">${children()}</div>`;
        case 'image': case 'video': case 'audio': return image(block.assetId ?? '', block.caption, block.type);
        case 'file': case 'pdf_preview': return image(block.fileId ?? block.assetId ?? '', block.label ?? block.caption, 'file');
        case 'link': return `<p><a href="${e(link(block.url ?? ''))}">${e(block.label ?? block.title ?? 'Link')}</a></p>`;
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
          const tags = block.data?.tags, collections = block.data?.collectionIds, publications = block.data?.publicationIds;
          for (const filter of [tags, collections, publications]) if (filter !== undefined && (!Array.isArray(filter) || filter.some(v => typeof v !== 'string'))) throw new WebsiteError('invalid_query', 'Query filters must be string arrays.');
          if (Array.isArray(tags)) selected = selected.filter(g => tags.every(t => g.tags.includes(t)));
          if (Array.isArray(collections) && collections.length) selected = selected.filter(g => collections.some(c => g.collectionIds.includes(c)));
          if (Array.isArray(publications) && publications.length) selected = selected.filter(g => publications.includes(g.publicationId));
          const sort = block.data?.sort ?? 'newest';
          if (!['newest','oldest','title'].includes(String(sort))) throw new WebsiteError('invalid_query', 'Unsupported gallery sort.');
          selected.sort((a,b) => (sort === 'title' ? a.title.localeCompare(b.title,'en') : sort === 'oldest' ? a.date.localeCompare(b.date) : b.date.localeCompare(a.date)) || a.publicationId.localeCompare(b.publicationId,'en'));
          const max = Number(block.data?.maxResults ?? 1000);
          if (!Number.isSafeInteger(max) || max < 1 || max > 1000) throw new WebsiteError('invalid_query', 'Maximum results must be 1–1000.');
          return paginated(selected.slice(0,max).map(g => card(g)));
        }
        case 'update_list': return paginated(pages.filter(p => p.kind === 'update').sort((a,b) => (b.date ?? '').localeCompare(a.date ?? '') || a.id.localeCompare(b.id,'en')).map(p => `<article><h2><a href="${e(url(routes.get(p.id)!))}">${e(p.title)}</a></h2>${p.date ? `<time datetime="${e(p.date)}">${e(p.date)}</time>` : ''}<p>${e(p.excerpt ?? '')}</p></article>`));
      }
    }).join('');
    add(path, shell(page.title, renderBlocks(doc.blocks), path, page));
    for (const extra of extraPages) add(extra.path, shell(extra.title, extra.body(), extra.path));
  }
  for (const g of galleries.filter(g => g.local)) {
    const path = websitePath(`/galleries/${g.slug}`);
    add(path, shell(g.title, `<p>${e(g.description ?? '')}</p><div class="grid">${g.publicAssetIds.map(id => image(id)).join('')}</div>`, path, { canonicalUrl: g.canonicalUrl }));
  }
  for (const redirect of site.redirects) {
    const path = websitePath(redirect.from), to = redirect.to.startsWith('/') ? url(websitePath(redirect.to)) : websiteExternalUrl(redirect.to);
    add(path, shell('Page moved', `<p><a href="${e(to)}">Continue to the new page</a></p>`,path,{noindex:true}));
    warnings.push('Portable redirects are HTML link pages, not HTTP 301/308 responses.');
  }
  write('404.html', shell('Page not found', `<p><a href="${e(url('/'))}">Return Home</a></p>`, '/404/', {noindex:true}));
  write('assets/theme.css', css+(site.theme.settings.font==='serif'?'body{font-family:Georgia,serif}':'')+(site.theme.settings.accentColor?`body.light,body.dark,body.system{--color-action:${site.theme.settings.accentColor};--color-focus:${site.theme.settings.accentColor}}`:''));
  write('robots.txt', `User-agent: *\n${site.noindex ? 'Disallow: /' : 'Allow: /'}\n${site.publicBaseUrl ? `Sitemap: ${absolute('/sitemap.xml')}\n` : ''}`);
  write('redirects.json',JSON.stringify({apiVersion:'1',redirects:site.redirects.map(r=>({from:url(websitePath(r.from)),to:r.to.startsWith('/')?url(websitePath(r.to)):websiteExternalUrl(r.to),status:r.status}))},null,2)+'\n');
  const sitemapPaths = [...files.keys()].filter(name => name.endsWith('index.html')).map(name => name === 'index.html' ? '/' : '/' + name.slice(0,-10).split('/').map(encodeURIComponent).join('/')).filter(path => !pages.some(p => routes.get(p.id) === path && p.noindex) && !site.redirects.some(r => websitePath(r.from) === path));
  write('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${!site.noindex && site.publicBaseUrl ? sitemapPaths.map(path => `<url><loc>${e(absolute(path)!)}</loc></url>`).join('') : ''}</urlset>`);
  write('README.txt', `Static website\n\nServe this directory with a generic static HTTP server at ${websitePath(site.basePath)}.\nNo application runtime is required. Directory index files must be enabled.\nMedia mode: ${site.mediaMode}. ${site.mediaMode === 'linked' ? 'Public media depends on its configured delivery provider.' : 'Public media is bundled.'}\nExternal links and accepted embed links require their destinations to be available.\nRedirect pages provide links; configure HTTP redirects separately if required.\nDownloading this archive does not confirm a live deployment.\n`);
  return { files, warnings };
};
