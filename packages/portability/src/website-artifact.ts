import { createHash } from 'node:crypto';
import { parse, type DefaultTreeAdapterMap } from 'parse5';
import { WebsiteError, websitePath, type Website, type WebsiteDependency, type WebsiteDocument, type WebsiteGallery, type WebsitePublicationMapping } from '@ubeeq/core';
import { renderStaticWebsite, STATIC_BLOCK_SUPPORT, type StaticWebsiteMedia } from '@ubeeq/ui';
import { parseContentBlocks, resolveWebsiteGallery, websiteRoutes, websiteExternalUrl } from '@ubeeq/core';

export interface WebsitePublicAsset {
  id: string; workspaceId: string; revision: number; checksum: string;
  mimeType: string; bytes?: Uint8Array; publicUrl?: string;
  alt: string; width?: number; height?: number;
  /** Attested by the trusted rendition/policy adapter, never copied from request JSON. */
  approvedPublic: boolean; metadataStripped: boolean;
}
export interface WebsiteSnapshot {
  copyrightYear?:number;
  creatorIdentities?:readonly {id:string;title:string}[];
  apiVersion: '1'; website: Website; documents: readonly WebsiteDocument[];
  galleries: readonly WebsiteGallery[]; mappings: readonly WebsitePublicationMapping[];
  assets: readonly WebsitePublicAsset[]; dependencies: readonly WebsiteDependency[];
}
export const websiteDigest = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([k,v]) => [k,stable(v)])) : value;
export const websiteFingerprint = (value: unknown) => websiteDigest(JSON.stringify(stable(value)));
const extension: Record<string, string> = {'image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/avif':'avif','image/gif':'gif','video/mp4':'mp4','video/webm':'webm','audio/mpeg':'mp3','audio/ogg':'ogg','audio/wav':'wav','application/pdf':'pdf','text/plain':'txt'};

/** Reject unknown blocks before the existing permissive import parser can omit them. */
export const normalizeWebsiteDocument = (document: WebsiteDocument): WebsiteDocument => {
  if (!document?.id || !document.workspaceId || !Number.isSafeInteger(document.revision) || document.revision < 1 || !Array.isArray(document.blocks)) throw new WebsiteError('invalid_document','Document identity, revision and blocks are required.');
  const blocks = parseContentBlocks(document.blocks, {unbounded:true, maxNodes:50000, maxDepth:64});
  const pending: unknown[] = [...document.blocks];
  let count = 0;
  while (pending.length) {
    const row = pending.pop() as Record<string, unknown>;
    if (++count > 5000 || !row || typeof row !== 'object' || typeof row.type !== 'string' || !Object.hasOwn(STATIC_BLOCK_SUPPORT,row.type)) throw new WebsiteError('unsupported_block','A required block has no static support declaration.');
    const children = row.children ?? row.blocks;
    if (children !== undefined && !Array.isArray(children)) throw new WebsiteError('invalid_document','Block children must be an array.');
    if (Array.isArray(children)) pending.push(...children);
    if (children && !['section','grouping','carousel'].includes(row.type)) throw new WebsiteError('unsupported_block','This block cannot contain child content in static output.');
  }
  return {...document, blocks};
};

/** Portable STORE ZIP with fixed DOS epoch, UTF-8 names and no platform metadata. */
export const createWebsiteZip = (files: ReadonlyMap<string, Uint8Array>): Uint8Array => {
  const local: Buffer[] = [], central: Buffer[] = []; let offset = 0;
  const crc = (bytes: Uint8Array) => { let value=0xffffffff; for (const byte of bytes) { value ^= byte; for(let i=0;i<8;i++) value=(value>>>1)^((value&1)?0xedb88320:0); } return (value^0xffffffff)>>>0; };
  if (files.size > 65535) throw new WebsiteError('quota_exceeded','ZIP entry limit exceeded.');
  for (const [name, bytes] of [...files].sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0)) {
    if (!/^[\p{L}\p{N}%_./-]+$/u.test(name) || name.startsWith('/') || name.split('/').some(p => !p || p === '.' || p === '..')) throw new WebsiteError('invalid_output_path','Unsafe artifact filename.');
    const filename=Buffer.from(name), checksum=crc(bytes), head=Buffer.alloc(30), directory=Buffer.alloc(46);
    head.writeUInt32LE(0x04034b50); head.writeUInt16LE(20,4); head.writeUInt16LE(0x800,6); head.writeUInt16LE(33,12);
    head.writeUInt32LE(checksum,14); head.writeUInt32LE(bytes.length,18); head.writeUInt32LE(bytes.length,22); head.writeUInt16LE(filename.length,26);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20,4); directory.writeUInt16LE(20,6); directory.writeUInt16LE(0x800,8); directory.writeUInt16LE(33,14);
    directory.writeUInt32LE(checksum,16); directory.writeUInt32LE(bytes.length,20); directory.writeUInt32LE(bytes.length,24); directory.writeUInt16LE(filename.length,28); directory.writeUInt32LE(offset,42);
    local.push(head,filename,Buffer.from(bytes)); central.push(directory,filename); offset+=head.length+filename.length+bytes.length;
    if (offset > 0xffffffff) throw new WebsiteError('quota_exceeded','ZIP size limit exceeded.');
  }
  const end=Buffer.alloc(22), directory=Buffer.concat(central);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.size,8); end.writeUInt16LE(files.size,10); end.writeUInt32LE(directory.length,12); end.writeUInt32LE(offset,16);
  return Buffer.concat([...local,directory,end]);
};

/** Inspect the actual generated files, including no-script links and fragments. */
export const validateWebsiteFiles = (site: Website, files: ReadonlyMap<string, Uint8Array>): void => {
  const base=websitePath(site.basePath).replace(/\/$/,''), origin='https://static.invalid';
  const ids=new Map<string, Set<string>>(), references: {file:string; value:string}[]=[];
  for (const [file, bytes] of files) {
    if (file.split('/').some(p => !p || p === '.' || p === '..') || file.startsWith('/') || file.includes('\\')) throw new WebsiteError('invalid_output_path','Unsafe generated path.');
    if (!file.endsWith('.html')) continue;
    const root=parse(Buffer.from(bytes).toString('utf8')), pending: DefaultTreeAdapterMap['node'][]=[root], found=new Set<string>(); ids.set(file,found);
    while(pending.length) {
      const node=pending.pop()!;
      if ('tagName' in node && ['script','iframe','object','embed','form'].includes(String(node.tagName))) throw new WebsiteError('unsafe_output','Active authored output is not allowed.');
      if ('attrs' in node) for (const attr of node.attrs as {name:string;value:string}[]) {
        if (attr.name.startsWith('on') || attr.name === 'style') throw new WebsiteError('unsafe_output','Executable attributes are not allowed.');
        if (attr.name === 'id') { if (found.has(attr.value)) throw new WebsiteError('duplicate_fragment','Duplicate generated fragment.'); found.add(attr.value); }
        if (['href','src','poster'].includes(attr.name)) references.push({file,value:attr.value});
      }
      if ('childNodes' in node) pending.push(...node.childNodes);
    }
  }
  for (const ref of references) {
    const pagePath=base+'/'+(ref.file === 'index.html' ? '' : ref.file.replace(/index\.html$/,''));
    const target=new URL(ref.value,origin+pagePath);
    if (target.origin !== origin) { websiteExternalUrl(ref.value,true); continue; }
    if (!(target.pathname === base+'/' || target.pathname.startsWith(base+'/'))) throw new WebsiteError('broken_link','Generated link escapes the hosting base path.');
    const path=decodeURIComponent(target.pathname.slice(base.length+1)), file=path.endsWith('/') || !path ? path+'index.html' : path;
    if (!files.has(file)) throw new WebsiteError('broken_link',`Missing generated link or asset: ${file}`);
    if (target.hash && !ids.get(file)?.has(decodeURIComponent(target.hash.slice(1)))) throw new WebsiteError('broken_fragment','Generated link points to a missing fragment.');
  }
};

export const validateWebsiteSnapshotBudget = (raw: WebsiteSnapshot, limits: {maxPages:number;maxAssets:number;maxBytes:number}) => {
  if(raw.copyrightYear!==undefined&&(!Number.isInteger(raw.copyrightYear)||raw.copyrightYear<1||raw.copyrightYear>9999))throw new WebsiteError('invalid_year','Copyright year must be a calendar year.');
  if (raw.apiVersion !== '1') throw new WebsiteError('unsupported_schema','Unsupported website snapshot version.');
  for (const limit of [limits.maxPages, limits.maxAssets, limits.maxBytes]) if (!Number.isSafeInteger(limit) || limit < 1) throw new WebsiteError('invalid_limits','Build limits must be positive integers.');
  if(raw.creatorIdentities&&(raw.creatorIdentities.length>51||new Set(raw.creatorIdentities.map(creator=>creator.id)).size!==raw.creatorIdentities.length||raw.creatorIdentities.some(creator=>![raw.website.creatorIdentityId,...raw.website.contributingCreatorIds??[]].includes(creator.id)||typeof creator.title!=='string'||!creator.title.trim()||creator.title.length>500)))throw new WebsiteError('invalid_contributors','Resolve only the connected public creator identities.');
  if (raw.website.pages.length > limits.maxPages || raw.assets.length > limits.maxAssets || raw.galleries.length > 1000) throw new WebsiteError('quota_exceeded','Website page, gallery or media quota exceeded.');
  // Bound the source projection before cloning it or allocating rendered output.
  let sourceBytes=Buffer.byteLength(JSON.stringify(raw.website));
  for(const value of [...raw.documents,...raw.galleries]) { sourceBytes+=Buffer.byteLength(JSON.stringify(value)); if(sourceBytes>limits.maxBytes) throw new WebsiteError('quota_exceeded','Website source projection exceeds the build byte budget.'); }
  for(const asset of raw.assets) { sourceBytes+=asset.bytes?.byteLength??0; if(sourceBytes>limits.maxBytes) throw new WebsiteError('quota_exceeded','Website source media exceeds the build byte budget.'); }
};

export const buildWebsiteArtifact = (raw: WebsiteSnapshot, limits: {maxPages:number;maxAssets:number;maxBytes:number}) => {
  validateWebsiteSnapshotBudget(raw,limits);
  const snapshot=structuredClone(raw), site=snapshot.website;
  const routes=websiteRoutes(site), base=websitePath(site.basePath).replace(/\/$/,''), media=new Map<string,StaticWebsiteMedia>(), files=new Map<string,Uint8Array>();
  const documents=new Map(snapshot.documents.map(doc => [doc.id,normalizeWebsiteDocument(doc)]));
  if (documents.size !== snapshot.documents.length || snapshot.documents.some(d => d.workspaceId !== site.workspaceId)) throw new WebsiteError('foreign_reference','Documents must be unique and workspace-scoped.');
  if (snapshot.galleries.some(g => g.workspaceId !== site.workspaceId) || new Set(snapshot.galleries.map(g=>g.publicationId)).size !== snapshot.galleries.length || site.galleryPublicationIds.some(id => !snapshot.galleries.some(g=>g.publicationId===id)) || snapshot.galleries.some(g=>!site.galleryPublicationIds.includes(g.publicationId))) throw new WebsiteError('foreign_reference','Resolve exactly the explicitly selected publication pool.');
  const galleries=snapshot.galleries.map(source => {
    const setting=site.gallerySettings?.find(s=>s.publicationId===source.publicationId);
    const g={...source,...(setting ? {title:setting.title??source.title,slug:setting.slug??source.slug,destination:setting.destination??source.destination,generateLocal:setting.generateLocal??source.generateLocal,canonicalUrl:setting.canonicalUrl??source.canonicalUrl} : {})};
    if(!g.slug || g.slug.includes('/')) throw new WebsiteError('invalid_path','Gallery slug must be a safe single segment.');
    if(g.canonicalUrl) websiteExternalUrl(g.canonicalUrl);
    return {...g,...resolveWebsiteGallery(site,g,snapshot.mappings)};
  });
  const needed=new Set<string>();
  for(const id of [site.theme.settings.logoAssetId,site.theme.settings.faviconAssetId,...site.pages.filter(p=>p.state==='ready').flatMap(p=>[p.socialAssetId,p.coverAssetId,p.backgroundAssetId])]) if(id) needed.add(id);
  const visit=(blocks: WebsiteDocument['blocks']) => { for (const b of blocks) { if (['image','video','audio','file','pdf_preview'].includes(b.type)) needed.add(b.fileId ?? b.assetId ?? ''); if (b.children) visit(b.children); } };
  for (const page of site.pages.filter(p=>p.state==='ready')) { const doc=documents.get(page.documentId); if(!doc) throw new WebsiteError('missing_document','A ready page has no resolved document.'); visit(doc.blocks); }
  for (const gallery of galleries) { if (gallery.href) gallery.previewAssetIds.forEach(id=>needed.add(id)); if(gallery.local) gallery.publicAssetIds.forEach(id=>needed.add(id)); }
  if (new Set(snapshot.assets.map(a=>a.id)).size !== snapshot.assets.length) throw new WebsiteError('invalid_media','Duplicate rendition identity.');
  let mediaBytes=0;
  for (const id of needed) {
    const asset=snapshot.assets.find(a=>a.id===id);
    if (!asset || asset.workspaceId !== site.workspaceId || asset.approvedPublic !== true || asset.metadataStripped !== true || !extension[asset.mimeType] || !/^[a-f0-9]{64}$/.test(asset.checksum) || !Number.isSafeInteger(asset.revision) || asset.revision < 1) throw new WebsiteError('media_not_public','Required media is not an approved, metadata-clean public rendition.');
    for(const n of [asset.width,asset.height]) if(n !== undefined && (!Number.isSafeInteger(n) || n<1)) throw new WebsiteError('invalid_media','Media dimensions must be positive integers.');
    let src:string;
    if (site.mediaMode === 'linked') { if(!asset.publicUrl) throw new WebsiteError('missing_media','Stable public media URL required.'); src=websiteExternalUrl(asset.publicUrl); }
    else {
      if (!asset.bytes || websiteDigest(asset.bytes)!==asset.checksum) throw new WebsiteError('invalid_media','Public rendition bytes are missing or have changed.');
      const path=`assets/${asset.checksum}.${extension[asset.mimeType]}`;
      if(!files.has(path)) { mediaBytes+=asset.bytes.length; if(mediaBytes>limits.maxBytes) throw new WebsiteError('quota_exceeded','Bundled media exceeds build byte quota.'); files.set(path,asset.bytes); }
      src=base+'/'+path;
    }
    media.set(id,{src,mimeType:asset.mimeType,alt:asset.alt,width:asset.width,height:asset.height});
  }
  const rendered=renderStaticWebsite({limits:{maxPages:limits.maxPages,maxBytes:limits.maxBytes-mediaBytes},apiVersion:'1',copyrightYear:snapshot.copyrightYear,website:site,routes,documents,galleries,media,creatorIdentities:snapshot.creatorIdentities});
  for (const [path,content] of rendered.files) { if(files.has(path)) throw new WebsiteError('route_collision','Generated file collision.'); files.set(path,new TextEncoder().encode(content)); }
  const bytes=[...files.values()].reduce((sum,b)=>sum+b.length,0), pages=[...files.keys()].filter(k=>k.endsWith('.html')).length;
  if(bytes>limits.maxBytes || pages>limits.maxPages) throw new WebsiteError('quota_exceeded','Generated website exceeds output limits.');
  validateWebsiteFiles(site,files);
  const zip=createWebsiteZip(files), digest=websiteDigest(zip);
  const dependencies: WebsiteDependency[]=[{kind:'website',id:site.id,revision:String(site.revision)},...snapshot.dependencies,
    ...snapshot.documents.map(d=>({kind:'document' as const,id:d.id,revision:String(d.revision)})),
    ...snapshot.galleries.map(g=>({kind:'publication' as const,id:g.publicationId,revision:String(g.revision)})),
    ...snapshot.assets.filter(a=>needed.has(a.id)).map(a=>({kind:'asset' as const,id:a.id,revision:`${a.revision}:${a.checksum}`}))];
  return {zip,files,digest,snapshotDigest:websiteFingerprint({...snapshot,assets:snapshot.assets.map(({bytes,...a})=>a)}),dependencies,
    warnings:[...rendered.warnings,...galleries.flatMap(g=>g.warning?[g.warning]:[])],report:{bytes,pages,media:media.size,files:files.size,checks:['safe-paths','required-media','internal-links','fragments','inert-html','quotas','sha256']}};
};
