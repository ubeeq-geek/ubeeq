import {websiteRoutes,websiteNamedGalleryPath,websitePath,WebsiteError,type Website,type WebsiteRedirect} from './websites.js';

/** Stable resource IDs, not names, connect a published URL to its current route. */
function resourcePaths(site:Website):Map<string,string> {
 const paths=new Map<string,string>(),routes=websiteRoutes({...site,redirects:[]});
 for(const page of site.pages)if(page.state==='ready')paths.set('page:'+page.id,routes.get(page.id)!);
 for(const gallery of site.namedGalleries??[])paths.set('gallery:'+gallery.id,websiteNamedGalleryPath(site,gallery));
 return paths;
}
/** Preserve published paths while leaving never-published draft paths out of history. */
export function websiteHistoricalRedirects(site:Website,previous:Website|undefined,published:readonly Website[]):WebsiteRedirect[] {
 const current=resourcePaths(site),occupied=new Set([...websiteRoutes({...site,redirects:[]}).values(),...current.values()]);
 const old=previous?resourcePaths(previous):new Map<string,string>(),moved=new Map<string,string>();
 for(const [id,path] of old){const next=current.get(id);if(next&&path!==next)moved.set(path,next);}
 const removed=new Set([...old].filter(([id])=>!current.has(id)).map(([,path])=>path));
 const result=new Map<string,WebsiteRedirect>();
 for(const redirect of site.redirects){
  const from=websitePath(redirect.from);
  if(result.has(from))throw new WebsiteError('route_collision','Redirect paths must be unique.');
  if(redirect.to.startsWith('/')&&removed.has(websitePath(redirect.to))&&previous?.redirects.some(r=>websitePath(r.from)===from&&r.to===redirect.to))continue;
  const to=redirect.to.startsWith('/')?moved.get(websitePath(redirect.to))??redirect.to:redirect.to;
  // Moving back to an older path restores the real page rather than a self redirect.
  if(occupied.has(from)&&previous?.redirects.some(r=>websitePath(r.from)===from))continue;
  result.set(from,{...redirect,from,to});
 }
 const retained=new Set<string>();
 // Callers supply releases newest first: a reused historical path belongs to its latest resource.
 for(const release of published){
  if(release.id!==site.id||release.workspaceId!==site.workspaceId)continue;
  const past=resourcePaths(release),targets=new Map<string,string>();
  for(const [id,from] of past){const to=current.get(id);if(to)targets.set(from,to);}
  const retain=(from:string,to:string)=>{if(retained.has(from))return;retained.add(from);if(from!=='/'&&from!==to&&!occupied.has(from))result.set(from,{from,to,status:301});};
  for(const [from,to] of targets)retain(from,to);
  // Older releases may already carry aliases whose original snapshots were retired.
  for(const alias of release.redirects){if(!alias.to.startsWith('/'))continue;const to=targets.get(websitePath(alias.to));if(to)retain(websitePath(alias.from),to);}
 }
 return [...result.values()];
}
