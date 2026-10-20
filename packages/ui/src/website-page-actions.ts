import {websiteRoutes,type Website} from '@ubeeq/core';

/** Remove a page reference, retaining documents/assets that may be shared elsewhere. */
export function removeWebsitePage(site:Website,pageId:string,replacementHomeId?:string):Website {
  if(!site.pages.some(page=>page.id===pageId))throw new Error('This page is no longer available.');
  if(site.pages.length<2)throw new Error('Add another page before deleting the only page.');
  const replacingHome=site.homePageId===pageId;
  const home=replacingHome?site.pages.find(page=>page.id===replacementHomeId&&page.id!==pageId&&page.state==='ready'&&page.kind!=='update'):site.pages.find(page=>page.id===site.homePageId);
  if(!home)throw new Error('Choose a Ready page to become the homepage.');
  const oldRoutes=websiteRoutes({...site,redirects:[]});
  const pages=site.pages.filter(page=>page.id!==pageId).map(page=>{
    const next={...page};let changed=false;
    if(replacingHome&&page.id===home.id){next.kind='home';next.slug='';next.parentId=undefined;changed=true;}
    if(next.parentId===pageId||replacingHome&&next.parentId===home.id){next.parentId=undefined;changed=true;}
    if(next.navigationParentId===pageId){next.navigationParentId=null;changed=true;}
    if(next.footerNavigationParentId===pageId){next.footerNavigationParentId=null;changed=true;}
    if(changed)next.revision++;
    return next;
  });
  let next:Website={...site,pages,homePageId:home.id,redirects:[],...(site.embedding?.pageId===pageId?{embedding:{...site.embedding,pageId:home.id}}:{})};
  const routes=websiteRoutes(next),moved=new Map([...oldRoutes].filter(([id])=>id!==pageId).map(([id,path])=>[path,routes.get(id)!]));
  const removedPath=oldRoutes.get(pageId);
  next={...next,redirects:site.redirects.filter(redirect=>(redirect.to!==removedPath||replacingHome)&&!new Set(routes.values()).has(redirect.from)).map(redirect=>({...redirect,to:moved.get(redirect.to)??redirect.to}))};
  websiteRoutes(next);
  return next;
}
