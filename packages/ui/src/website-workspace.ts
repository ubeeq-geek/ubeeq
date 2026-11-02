import {saveWebsitePreviewDrafts} from './website-preview-drafts.js';
import {attachWebsiteDragScroll} from './website-drag-scroll.js';
import {moveWebsiteGallery,removeWebsitePage} from './website-page-actions.js';
import {readWebsitePreviewArchive,websitePreviewHtml,saveWebsitePreview,websitePreviewLoadingHtml,notifyWebsitePreviewSaved,websitePreviewKey,type WebsitePreviewContext} from './website-preview.js';
import { websiteEmbedCode, websiteFrameAncestors, WEBSITE_THEMES, WEBSITE_INTENTS, WEBSITE_PAGE_TEMPLATES, websiteRoutes, websiteMenuParent, websiteMenuOrder, type WebsiteDestination, type WebsiteHostingTarget, type HostingCapabilities, type WebsitePage, type EntityId, type Website, type WebsiteDocument } from '@ubeeq/core';
export interface WebsiteCatalogueOption {workId?:string;id:string;title:string;premium?:boolean;preferLocal?:boolean;destination?:Extract<WebsiteDestination,{mode:'connected'}>;destinationLabel?:string;}
export interface WebsiteMediaOption {id:string;title:string;source?:string;}

export interface WebsiteWorkspaceClient {
  saveGalleryLink?(galleryId:string,id:string,url:string,expectedUrl:string):Promise<{url:string}>;
  galleryLinkSuggestions?(galleryId:string):Promise<readonly {label:string;url:string;detail:string;purchase?:boolean;id?:string;browseUrl?:string}[]>;
  pendingUploads?():boolean;
  mailingListStatus?():Promise<{enabled:boolean;emailAvailable:boolean;signupUrl:string;manageUrl:string}>;
  media?(query?:string):Promise<readonly WebsiteMediaOption[]>;
  uploadMedia?(file:File):Promise<WebsiteMediaOption>;
  mediaPreview?(id:string):Promise<string>;
  creators?():Promise<readonly {id:string;title:string}[]>;
  hostingConnections?():Promise<readonly {id:string;family:string;accountId:string;state:string}[]>;
  hostingConnectionAction?(action:string,body:Record<string,unknown>):Promise<any>;
  hostingChoices?():Promise<readonly {id:string;family:string;capabilities:HostingCapabilities}[]>;
  hostingHistory?():Promise<{targets:readonly WebsiteHostingTarget[];bindings?:readonly {id:string;revision:number;label:string;enabled:boolean;targetIds:readonly string[]}[];domains?:readonly {id:string;targetId:string;hostname:string;state:string;instructions:readonly string[]}[];attempts:readonly {id:string;targetId:string;state:string;generation:number;checkpoint?:{data?:Readonly<Record<string,string>>};errorCode?:string;verification?:{publicConfirmed:boolean;reasons:readonly string[]}}[]}>;
  createNativeTarget?(adapterId:string,label:string):Promise<void>;
  reviewBinding?(id:string,bindingRevision:number,websiteRevision:number):Promise<{planId:string;fingerprint:string;expiresAt:string}>;
  reviewPublication?(revision:number,targetIds:readonly string[]):Promise<{planId:string;fingerprint:string;expiresAt:string}>;
  publishWebsite?(planId:string,fingerprint:string,key:string):Promise<void>;
  hostingAction?(action:string,id:string,body?:unknown):Promise<void>;
  catalogue?(): Promise<readonly WebsiteCatalogueOption[]>;
  get(): Promise<Website>;
  save(website: Website, expectedRevision: number): Promise<Website>;
  document(id: string): Promise<{ document: WebsiteDocument; sharedBy: readonly { title: string }[] }>;
  saveDocument(document: WebsiteDocument, expectedRevision: number): Promise<WebsiteDocument>;
  requestBuild(revision: number, key: string): Promise<{ id: string; state: string }>;
  builds?(previewRevision?:number): Promise<readonly {id:string;state:string;websiteRevision:number;stale?:boolean}[]>;
  previewSite?(id:string):Promise<Blob>;
  previewPages?(id:string): Promise<readonly string[]>;
  build(id: string): Promise<{ id: string; state: string; errorCode?: string; warnings: readonly string[]; stale?: boolean }>;
  export(id: string): Promise<Blob>;
  /** Product downloads may use a short-lived private storage URL to avoid gateway response limits. */
  download?(id: string): Promise<void>;
  /** Returns an authorized generated HTML document. The iframe is always sandboxed. */
  preview(id: string,file?:string): Promise<string>;
}
export interface WebsiteWorkspaceOptions { hostingSetupUrl?:string; hostingDestinationSetupUrl?:(target:WebsiteHostingTarget)=>string; initialHostingTargetId?:string; hostingPlatformIcons?:Readonly<Partial<Record<string,{path:string;viewBox?:string}>>>; initialTab?:'Settings'|'Pages'|'Layout'|'Appearance'|'Galleries'|'Publishing'; studioName?:string; onBusyChange?:(busy:boolean)=>void; onUnsavedChangesChange?:(dirty:boolean)=>void; emptyHostingMessage?:string; formatDate?:(instant:string)=>string; previewPath?:string; exportEnabled?:boolean; destinationModes?: readonly ('local'|'manual'|'connected')[]; showAssetIds?: boolean; }
type PreviewClient=Pick<WebsiteWorkspaceClient,'get'|'builds'|'build'|'requestBuild'|'previewSite'>;
const prepareWebsitePreview=async(client:PreviewClient,pageId?:string,progress:(message:string)=>void=()=>{},closed:()=>boolean=()=>false,fallback=false)=>{
    const saved=await client.get(),selected=saved.pages.find(p=>p.id===(pageId??saved.homePageId)),page=fallback&&selected?.state!=='ready'?saved.pages.find(p=>p.id===saved.homePageId):selected;
    if(!page||page.state!=='ready')throw new Error('Save this page as Ready before previewing it.');
    let buildId:string|undefined;
    const candidates=await client.builds?.(saved.revision)??[];
    for(const candidate of candidates)if(candidate.state==='ready'&&candidate.websiteRevision===saved.revision){if(!(candidate.stale??(await client.build(candidate.id)).stale)){buildId=candidate.id;break;}}
    if(!buildId){
      const existing=candidates.find(b=>b.websiteRevision===saved.revision&&!['ready','failed','cancelled'].includes(b.state));
      const requested=existing??await client.requestBuild(saved.revision,globalThis.crypto.randomUUID());buildId=requested.id;
      const deadline=Date.now()+20*60*1000;
      for(;;){
        if(closed())throw new Error('The preview tab was closed.');
        const build=await client.build(buildId);
        if(build.state==='ready'){if(build.stale)throw new Error('Website sources changed while preparing the preview. Open a new preview.');break;}
        if(['failed','cancelled'].includes(build.state))throw new Error('Website preview could not be prepared'+(build.errorCode?' ('+build.errorCode+')':'')+'. Build a new candidate to retry.');
        if(Date.now()>deadline)throw new Error('This build is taking longer than expected. Its progress is available in Publishing.');
        progress(build.state==='queued'?'Your preview is queued. Preparing will begin shortly…':'Preparing your pages and images…');
        await new Promise(resolve=>setTimeout(resolve,1000));
      }
    }
    const route=websiteRoutes(saved).get(page.id);if(!route)throw new Error('This page is unavailable in the saved website.');
    if(!client.previewSite)throw new Error('Complete website previews are unavailable in this client.');
    progress('Loading your preview…');
    const files=await readWebsitePreviewArchive(await client.previewSite(buildId));

    const initial=route==='/'?'index.html':decodeURIComponent(route.slice(1))+'index.html';
    return {saved,buildId,files,initial};
};
const previewProviders=new Map<string,{channel:BroadcastChannel;client:PreviewClient;sourceUrl:string;id:string}>();
const registerPreviewProvider=(saved:Website,sourceUrl:string,client:PreviewClient)=>{
  if(typeof window==='undefined'||typeof BroadcastChannel==='undefined')return;
  const key=websitePreviewKey(saved),previous=previewProviders.get(key);
  if(previous){previous.client=client;previous.sourceUrl=sourceUrl;return;}
  const provider={channel:new BroadcastChannel(key+':requests'),client,sourceUrl,id:crypto.randomUUID()};
  const offers=new Map<string,{replyTo:string;pageId?:string;path?:string;expires:number}>();
  const send=(replyTo:string,requestId:string,type:string,extra:Record<string,unknown>={})=>{const reply=new BroadcastChannel(replyTo);reply.postMessage({type,requestId,...extra});reply.close();};
  provider.channel.onmessage=async event=>{
    const data=event.data;if(typeof data?.requestId!=='string'||!/^[a-f0-9-]{36}$/.test(data.requestId))return;
    if(data.type==='refresh-request'){
      if(typeof data.replyTo!=='string'||!/^ubeeq\.website-preview\.refresh:[a-f0-9-]{36}$/.test(data.replyTo)||data.pageId!==undefined&&(typeof data.pageId!=='string'||data.pageId.length>200)||data.path!==undefined&&(typeof data.path!=='string'||data.path.length>2000))return;
      for(const [id,offer]of offers)if(offer.expires<Date.now())offers.delete(id);
      if(offers.size>=50)return;offers.set(data.requestId,{replyTo:data.replyTo,pageId:data.pageId,path:data.path,expires:Date.now()+30000});
      send(data.replyTo,data.requestId,'offer',{providerId:provider.id});return;
    }
    if(data.type!=='refresh-accept'||data.providerId!==provider.id)return;
    const offer=offers.get(data.requestId);if(!offer||offer.expires<Date.now())return;offers.delete(data.requestId);
    const reply=(type:string,extra:Record<string,unknown>={})=>send(offer.replyTo,data.requestId,type,extra);
    try{
      reply('progress',{message:'Preparing the latest saved preview…'});
      const result=await prepareWebsitePreview(provider.client,offer.pageId,message=>reply('progress',{message}),undefined,true);
      if(websitePreviewKey(result.saved)!==key)throw Error('This website is no longer available in the editor.');
      const nextContext=makePreviewContext(result.saved,provider.sourceUrl,offer.replyTo);
      const initial=!offer.pageId&&offer.path?.endsWith('.html')&&Object.hasOwn(result.files,offer.path)?offer.path:result.initial;
      const id=await saveWebsitePreview(websitePreviewHtml(result.files,initial,nextContext));notifyWebsitePreviewSaved(result.saved);reply('ready',{id});
    }catch(error){reply('error',{message:error instanceof Error?error.message:'The latest preview could not be prepared. Try again.'});}
  };
  previewProviders.set(key,provider);
  if(previewProviders.size>30){const oldest=previewProviders.keys().next().value!;previewProviders.get(oldest)?.channel.close();previewProviders.delete(oldest);}
};
const makePreviewContext=(saved:Website,sourceUrl:string,refreshChannel='ubeeq.website-preview.refresh:'+crypto.randomUUID()):WebsitePreviewContext=>{
  const editor=new URL(sourceUrl);editor.searchParams.set('websiteId',saved.id);
  return {websiteKey:websitePreviewKey(saved),revision:saved.revision,refreshChannel,editorUrl:editor.href,pagePaths:Object.fromEntries([...websiteRoutes(saved)].map(([id,route])=>[id,route==='/'?'index.html':decodeURIComponent(route.slice(1))+'index.html']))};
};
export {notifyWebsitePreviewSaved} from './website-preview.js';
export const openWebsitePreview = async (client:PreviewClient,popup:Window,sourceUrl:string,pageId?:string,previewPath?:string):Promise<string> => {
  popup.opener=null;popup.document.open();popup.document.write(websitePreviewLoadingHtml());popup.document.close();
  const progress=(message:string)=>{const status=popup.document.getElementById('website-preview-status');if(status)status.textContent=message;};
  try{
    const {saved,buildId,files,initial}=await prepareWebsitePreview(client,pageId,progress,()=>popup.closed);
    registerPreviewProvider(saved,sourceUrl,client);
    const context=previewPath?makePreviewContext(saved,sourceUrl):undefined;
    const html=websitePreviewHtml(files,initial,context);notifyWebsitePreviewSaved(saved);
    if(popup.closed)return buildId;
    if(previewPath){const target=new URL(previewPath,sourceUrl);if(target.origin!==new URL(sourceUrl).origin)throw new Error('The preview page must use the same origin.');target.searchParams.set('id',await saveWebsitePreview(html));if(!popup.closed)popup.location.replace(target.href);}else{popup.document.open();popup.document.write(html);popup.document.close();}
    return buildId;
  }catch(error){if(!popup.closed)popup.document.body.textContent=error instanceof Error?error.message:'Unable to open preview.';throw error;}
};
export interface WebsiteGalleryLinkEditorProps {
  saveSuggestionUrl?:(id:string,url:string,expectedUrl:string)=>Promise<{url:string}>;
  loadSuggestions?:()=>Promise<readonly {label:string;url:string;detail:string;purchase?:boolean;id?:string;browseUrl?:string}[]>;
  heading:string; purchase:boolean; value:{label:string;url:string;priceText?:string}[];
  onChange:(value:{label:string;url:string;priceText?:string}[])=>void;
}
export interface WebsiteGalleryWorksProps {website:Website;galleryId:string;reviewBlocked:()=>string|undefined;}
export type MountWebsiteGalleryWorks=(host:HTMLElement,props:WebsiteGalleryWorksProps)=>(()=>void);
export type MountWebsiteGalleryLinkEditor=(host:HTMLElement,props:WebsiteGalleryLinkEditorProps)=>(()=>void);
/** Shared editor injection keeps the authoritative block format and existing editor. */
export const createWebsiteWorkspace = (root: HTMLElement, client: WebsiteWorkspaceClient, mountEditor: (host: HTMLElement, document: WebsiteDocument, onChange: (document: WebsiteDocument) => void) => (() => void), options: WebsiteWorkspaceOptions = {}, mountSettings?: (host:HTMLElement)=>(()=>void), mountLinks?:MountWebsiteGalleryLinkEditor, mountWorks?:MountWebsiteGalleryWorks) => {
  const d=root.ownerDocument;
  let site: Website, disposed=false, cleanupEditor: (()=>void)|undefined, cleanupSettings:(()=>void)|undefined, currentBuild:string|undefined,selectedPage:string|undefined,pageSelectorExpanded=true,renderGeneration=0;
  const cleanupLinks:(()=>void)[]=[];
  let editorFullscreenCleanup:(()=>void)|undefined,activeTab='Pages',prepareDraft=()=>{};
  const documentDrafts=new Map<string,WebsiteDocument>(),documentBaselines=new Map<string,string>();let savedSite='',reportedDirty=false,operations=0;
  const dirty=()=>Boolean(site&&(JSON.stringify(site)!==savedSite||[...documentDrafts].some(([id,doc])=>JSON.stringify(doc)!==documentBaselines.get(id))||Array.from(root.querySelectorAll<HTMLInputElement|HTMLTextAreaElement>('[data-website-draft-initial]')).some(input=>input.value!==input.dataset.websiteDraftInitial)));
  const updatePreviewButton=(button:HTMLButtonElement,value:boolean)=>{
    const label=value?'Save Changes & Preview':button.dataset.websitePreviewLabel!;
    if(button.dataset.websitePreviewPageTitle!==undefined){const name=label+' page '+button.dataset.websitePreviewPageTitle;button.setAttribute('aria-label',name);button.title=name;}
    else button.textContent=label;
  };
  const reportDirty=()=>{const value=dirty();for(const button of root.querySelectorAll<HTMLButtonElement>('[data-website-preview-label]'))updatePreviewButton(button,value);if(value!==reportedDirty){reportedDirty=value;options.onUnsavedChangesChange?.(value);}};
  const scheduleDirty=()=>queueMicrotask(()=>{if(!disposed)reportDirty();});root.addEventListener('input',scheduleDirty);root.addEventListener('change',scheduleDirty);

  let selectedHostingTarget=options.initialHostingTargetId??'',publishingSelectorExpanded=true;
  let selectedGallery='',galleryParentFilter='',galleryQuery='',gallerySelectorExpanded=true;
  let selectedLayout='Header',layoutSelectorExpanded=true,previewPending=false,publishingTimer:ReturnType<typeof setTimeout>|undefined;
  const stopPublishingPoll=()=>{if(publishingTimer)clearTimeout(publishingTimer);publishingTimer=undefined;};
  const element=<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string) => {const el=d.createElement(tag);if(text)el.textContent=text;return el;};
  const status=element('p'); status.setAttribute('role','status');
  const tabs=element('nav'), content=element('section'); tabs.setAttribute('aria-label','Website tools'); root.replaceChildren(tabs,status,content);
  const act=(fn:()=>Promise<void>)=>async()=>{operations++;options.onBusyChange?.(true);try{await fn();}catch(error){status.textContent=error instanceof Error?error.message:'Website operation failed.';}finally{operations--;if(!disposed){reportDirty();options.onBusyChange?.(operations>0);}}};
  const button=(label:string,fn:()=>Promise<void>)=>{const b=element('button',label);b.type='button';b.onclick=async()=>{b.setAttribute('aria-busy','true');try{await act(fn)();}finally{b.removeAttribute('aria-busy');}};return b;};
  const previewButton=(label:string,pageId:()=>string,pageTitle?:string)=>{const b=button(label,()=>previewPage(pageId()));b.dataset.websitePreviewLabel=label;if(pageTitle!==undefined)b.dataset.websitePreviewPageTitle=pageTitle;updatePreviewButton(b,dirty());return b;};
  const dialogs=new Map<HTMLDialogElement,()=>void>();
  const confirmAction=(title:string,description:string,action:string,run:()=>Promise<void>,fields?:HTMLElement)=>new Promise<void>(resolve=>{
    const dialog=element('dialog'),heading=element('h2',title),copy=element('p',description),error=element('p'),actions=element('div');heading.id='website-confirm-'+crypto.randomUUID();dialog.setAttribute('aria-labelledby',heading.id);dialog.className='website-confirm-dialog';error.setAttribute('role','alert');let pending=false,closed=false;const focused=d.activeElement as HTMLElement|null;
    const close=()=>{if(closed)return;closed=true;dialog.close();dialog.remove();dialogs.delete(dialog);focused?.focus();resolve();};
    const cancel=button('Cancel',async()=>close()),accept=button(action,async()=>{if(pending)return;pending=true;cancel.disabled=true;accept.disabled=true;error.textContent='';try{await run();close();}catch(e){error.textContent=e instanceof Error?e.message:'The operation could not be completed. Try again.';}finally{pending=false;cancel.disabled=false;accept.disabled=false;}});
    dialog.oncancel=event=>{event.preventDefault();if(!pending)close();};actions.append(cancel,accept);dialog.append(heading,copy,...(fields?[fields]:[]),error,actions);d.body.append(dialog);dialogs.set(dialog,close);dialog.showModal();cancel.focus();
  });
  const field=(parent:HTMLElement,label:string,value:string,change:(v:string)=>void)=>{const l=element('label',label),i=element('input');i.value=value;i.dataset.websiteDraftInitial=value;i.onchange=()=>change(i.value);l.append(i);parent.append(l);return i;};
  let mediaCache:WebsiteMediaOption[]|undefined,uploads=0;const imageObservers:IntersectionObserver[]=[];
  const library=async()=>mediaCache??(mediaCache=[...await client.media?.()??[]]);
  const mediaField=async(parent:HTMLElement,label:string,value:string|undefined,change:(id:string|undefined)=>void,position?:{x:number;y:number},move?:(p:{x:number;y:number})=>void)=>{
    const box=element('div');box.className='website-image-slot';box.append(element('h4',label),element('p','Choose an image from a public Work, or upload one for this website.'));
    const choices=await library(),select=element('select');select.setAttribute('aria-label',label+' image');
    const refresh=()=>{select.replaceChildren();const none=element('option','Choose an image…');none.value='';select.append(none);for(const image of (d.activeElement===select?choices:choices.filter(image=>image.id===value))){const option=element('option',image.title);option.value=image.id;select.append(option);}if(value&&!choices.some(image=>image.id===value)){const current=element('option','Current image');current.value=value;select.append(current);}select.value=value??'';};refresh();
    const preview=element('img');preview.alt=label+' preview';preview.hidden=!value;
    let chosen=value;
    const choose=async(id:string|undefined)=>{chosen=id;value=id;refresh();select.value=id??'';change(id);preview.hidden=!id;if(id&&client.mediaPreview){const url=await client.mediaPreview(id);if(chosen===id)preview.src=url;}};
    select.onfocus=refresh;select.onblur=refresh;select.onchange=act(()=>choose(select.value||undefined));box.append(select,preview);
    const browse=element('details'),summary=element('summary','Browse and drag library images'),tiles=element('div'),searchLabel=element('label','Search image library'),search=element('input'),count=element('p');tiles.className='website-image-library';search.type='search';searchLabel.append(search);browse.append(summary,searchLabel,count,tiles);
    let observer:IntersectionObserver|undefined;
    const renderLibrary=()=>{observer?.disconnect();tiles.replaceChildren();const matches=choices.filter(image=>image.title.toLowerCase().includes(search.value.toLowerCase()));count.textContent=`${Math.min(matches.length,60)} of ${matches.length} images. Search to narrow the list.`;
      if(client.mediaPreview&&typeof IntersectionObserver!=='undefined'){observer=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting){const img=entry.target as HTMLImageElement;observer?.unobserve(img);void client.mediaPreview!(img.dataset.id!).then(url=>img.src=url).catch(()=>img.hidden=true);}},{root:tiles});imageObservers.push(observer);}
      for(const image of matches.slice(0,60)){const b=button(image.title,()=>choose(image.id));b.draggable=true;b.ondragstart=e=>e.dataTransfer?.setData('application/x-website-image',image.id);if(client.mediaPreview){const thumb=element('img');thumb.alt='';thumb.dataset.id=image.id;thumb.loading='lazy';b.prepend(thumb);if(observer)observer.observe(thumb);else void client.mediaPreview(image.id).then(url=>thumb.src=url).catch(()=>thumb.hidden=true);}tiles.append(b);}
    };let searchGeneration=0,searchTimer:ReturnType<typeof setTimeout>|undefined;search.oninput=()=>{renderLibrary();const generation=++searchGeneration;if(searchTimer)clearTimeout(searchTimer);if(client.media)searchTimer=setTimeout(()=>{void client.media!(search.value).then(results=>{if(disposed||generation!==searchGeneration||!d.contains(box))return;for(const image of results)if(!choices.some(current=>current.id===image.id))choices.push(image);renderLibrary();}).catch(error=>status.textContent=String(error));},250);};browse.ontoggle=()=>{if(browse.open)renderLibrary();else observer?.disconnect();};box.append(browse);
    const upload=async(file:File)=>{if(!client.uploadMedia)throw new Error('Image uploads are unavailable.');if(file.size>10*1024*1024)throw new Error('Choose an image up to 10 MiB.');uploads++;box.setAttribute('aria-busy','true');try{const image=await client.uploadMedia(file);if(!choices.some(i=>i.id===image.id)){choices.push(image);if(browse.open)renderLibrary();}refresh();await choose(image.id);status.textContent='Image added. Save the page or appearance settings to keep its placement.';}finally{uploads--;box.removeAttribute('aria-busy');}};
    if(client.uploadMedia){const labelEl=element('label','Upload or drop an image'),file=element('input');file.type='file';file.accept='image/png,image/jpeg,image/webp,image/gif,image/avif';file.onchange=act(async()=>{try{if(file.files?.[0])await upload(file.files[0]);}finally{file.value='';}});labelEl.append(file);box.append(labelEl);}
    box.ondragover=e=>{e.preventDefault();box.classList.add('drag-over');};box.ondragleave=()=>box.classList.remove('drag-over');
    box.ondrop=e=>{e.preventDefault();box.classList.remove('drag-over');void act(async()=>{const id=e.dataTransfer?.getData('application/x-website-image');if(id){if(!choices.some(i=>i.id===id))throw new Error('Choose an image from this website library.');await choose(id);}else if(e.dataTransfer?.files?.[0])await upload(e.dataTransfer.files[0]);})().catch(()=>{});};
    box.append(button('Remove '+label.toLowerCase(),()=>choose(undefined)));
    if(move){let framing=position??{x:.5,y:.5};preview.style.objectPosition=`${framing.x*100}% ${framing.y*100}%`;for(const axis of ['x','y'] as const){const l=element('label',label+(axis==='x'?' horizontal position':' vertical position')),range=element('input');range.type='range';range.min='0';range.max='1';range.step='.01';range.value=String(framing[axis]);range.oninput=()=>{framing={...framing,[axis]:Number(range.value)};move(framing);preview.style.objectPosition=`${framing.x*100}% ${framing.y*100}%`;};l.append(range);box.append(l);}}
    parent.append(box);if(value&&client.mediaPreview)void client.mediaPreview(value).then(url=>preview.src=url).catch(error=>{status.textContent=String(error);});
  };
  const save=async()=>{if(uploads||client.pendingUploads?.())throw new Error('Wait for image uploads to finish before saving.');const expected=site.revision;site=await client.save({...site,revision:expected+1},expected);savedSite=JSON.stringify(site);notifyWebsitePreviewSaved(site);for(const input of Array.from(root.querySelectorAll<HTMLInputElement|HTMLTextAreaElement>('[data-website-draft-initial]')))input.dataset.websiteDraftInitial=input.value;reportDirty();status.textContent=`Website revision ${site.revision} saved. Build a new candidate to update the export.`;};
  const win=d.defaultView;let measureFrame=0;
  const measurePages=()=>{const selector=root.querySelector<HTMLElement>('.website-page-selector');if(!selector||selector.hidden||!win)return;const top=Math.max(0,selector.getBoundingClientRect().top);selector.style.setProperty('--website-selector-height',`${Math.max(160,win.innerHeight-top-24)}px`);const first=selector.querySelector<HTMLElement>('button');if(first)selector.parentElement?.style.setProperty('--website-selector-first-center',`${first.getBoundingClientRect().top-selector.getBoundingClientRect().top+selector.scrollTop+first.offsetHeight/2}px`);};
  const scheduleMeasure=()=>{if(win&&!measureFrame)measureFrame=win.requestAnimationFrame(()=>{measureFrame=0;measurePages();});};win?.addEventListener('resize',scheduleMeasure);win?.addEventListener('scroll',scheduleMeasure,true);
  const previewPage=async(pageId:string)=>{
    if(previewPending)throw new Error('A website preview is already opening.');
    const popup=win?.open('about:blank','_blank');if(!popup)throw new Error('Allow pop-ups to open this preview in a new tab.');previewPending=true;
    try{
      if(dirty()){
        if(uploads||client.pendingUploads?.())throw new Error('Wait for image uploads to finish before saving.');
        prepareDraft();
        status.textContent='Saving changes before opening preview…';
        const wasInert=root.inert;root.inert=true;
        try{
          await saveWebsitePreviewDrafts(documentDrafts,documentBaselines,(doc,revision)=>client.saveDocument(doc,revision));
          await save();await show(activeTab);
        }catch(error){await show(activeTab);throw error;}finally{root.inert=wasInert;}
      }
      currentBuild=await openWebsitePreview(client,popup,win!.location.href,pageId,options.previewPath);status.textContent='Preview opened in a new tab using saved changes.';
    }catch(error){popup.close();throw error;}finally{previewPending=false;reportDirty();}
  };
  const show=async(tab:string)=>{
    activeTab=tab;prepareDraft=()=>{};const generation=++renderGeneration;editorFullscreenCleanup?.();stopPublishingPoll();
    for(const choice of Array.from(tabs.querySelectorAll('button')))choice.setAttribute('aria-pressed',String(choice.dataset.websiteTool===tab));
    for(const cleanup of cleanupLinks.splice(0))cleanup();
    cleanupEditor?.();cleanupEditor=undefined;cleanupSettings?.();cleanupSettings=undefined;for(const observer of imageObservers)observer.disconnect();imageObservers.length=0;content.replaceChildren(element('h2',tab));
    if(tab==='Settings'){
      const settings=element('div');settings.className='website-site-settings';settings.append(element('p','Site-wide settings for this website.'));
      const name=field(settings,'Site name',site.title,value=>site={...site,title:value});
      const purposeLabel=element('label','Website purpose'),purpose=element('select');purpose.setAttribute('aria-label','Website purpose');for(const item of WEBSITE_INTENTS){const option=element('option',item.title);option.value=item.id;purpose.append(option);}purpose.value=site.intent??'portfolio';purpose.onchange=()=>{site={...site,intent:purpose.value as NonNullable<Website['intent']>};};purposeLabel.append(purpose);settings.append(purposeLabel,element('p','Purpose suggests starter content. Changing it here preserves existing pages and content; visual style is chosen separately in Appearance.'));
      const saveSettings=button('Save settings',async()=>{if(!site.title.trim())throw new Error('Enter a website name.');site={...site,title:site.title.trim()};await save();name.value=site.title;refreshEmbedding();});content.append(settings);
      const embeddingDetails=element('details'),embeddingSummary=element('summary','Embedding'),embedding=element('div');embeddingDetails.className='website-embedding-disclosure';embeddingDetails.append(embeddingSummary);embedding.className='website-embedding-settings';embedding.append(element('p','Allow other websites to display this published website in an iframe. Save settings and publish a new release to apply changes.'));
      const defaults=()=>({mode:'disabled' as const,origins:[] as string[],pageId:site.homePageId,presentation:'full' as const,height:800});
      const change=(patch:Partial<NonNullable<Website['embedding']>>)=>{site={...site,embedding:{...(site.embedding??defaults()),...patch}};refreshEmbedding();};
      const optionField=(label:string,choices:readonly {value:string;label:string}[],value:string,onchange:(value:string)=>void)=>{const row=element('label',label),input=element('select');input.setAttribute('aria-label',label);for(const choice of choices){const option=element('option',choice.label);option.value=choice.value;input.append(option);}input.value=value;input.onchange=()=>onchange(input.value);row.append(input);embedding.append(row);return input;};
      const access=optionField('Allow embedding',[{value:'disabled',label:'Off'},{value:'selected',label:'Selected domains'},{value:'any',label:'Any website'}],site.embedding?.mode??'disabled',value=>change({mode:value as NonNullable<Website['embedding']>['mode']}));
      const originsRow=element('label','Allowed website origins (one per line)'),origins=element('textarea');origins.setAttribute('aria-label','Allowed website origins (one per line)');origins.placeholder='https://www.example.com';origins.value=site.embedding?.origins.join('\n')??'';origins.oninput=()=>change({origins:origins.value.split(/\n/).map(v=>v.trim()).filter(Boolean)});originsRow.append(origins);embedding.append(originsRow,element('p','Use exact origins including https:// and any port. Subdomains such as www.example.com are separate entries. Up to 10 origins; no wildcards or page paths.'));
      const start=optionField('Embedding starting page',site.pages.filter(page=>page.state==='ready').map(page=>({value:page.id,label:page.title})),site.embedding?.pageId??site.homePageId,value=>change({pageId:value}));
      const presentation=optionField('Embedding presentation',[{value:'full',label:'Full website'},{value:'content',label:'Content only — hide header and footer'}],site.embedding?.presentation??'full',value=>change({presentation:value as 'full'|'content'}));
      const height=field(embedding,'Iframe height (pixels)',String(site.embedding?.height??800),value=>change({height:Number(value)}));height.type='number';height.min='200';height.max='2000';
      const addressRow=element('label','Published website URL'),address=element('input');address.type='url';address.setAttribute('aria-label','Published website URL');address.placeholder='https://www.example.com/portfolio/';address.value=site.embedding?.sourceUrl??(site.publicBaseUrl?new URL(site.basePath,site.publicBaseUrl).href:'');address.oninput=()=>change({sourceUrl:address.value||undefined});addressRow.append(address);embedding.append(addressRow);
      const parent=field(embedding,'Parent page URL (for example, a Hostinger Builder page)',site.embedding?.parentUrl??'',value=>change({parentUrl:value||undefined}));parent.type='url';
      const responsiveRow=element('label','Use viewport-sized iframe with an Open full site link'),responsive=element('input');responsive.type='checkbox';responsive.checked=site.embedding?.responsive===true;responsive.onchange=()=>change({responsive:responsive.checked});responsiveRow.append(responsive);embedding.append(responsiveRow,element('p','For Hostinger Website Builder, paste the embed once and publish the parent page in Builder. Future releases update the existing source hosting destination; they do not edit Builder. Parent embed status is not verified. Allow the exact parent origin above and configure its Builder element for full width. Login and checkout may require the full-site link.'));
      const codeRow=element('label','Iframe embed code'),code=element('textarea');code.setAttribute('aria-label','Iframe embed code');code.readOnly=true;code.rows=5;codeRow.append(code);embedding.append(codeRow);
      const instructions=element('p'),copy=button('Copy embed code',async()=>{if(dirty())throw new Error('Save your website settings before copying embed code.');if(!code.value)throw new Error('Enter the published website URL and valid embedding settings.');if(!win?.navigator.clipboard){code.focus();code.select();status.textContent='Embed code selected. Copy it using your browser.';return;}await win.navigator.clipboard.writeText(code.value);status.textContent='Embed code copied. Publish the saved website settings before using it.';});embedding.append(copy,instructions,element('p','Embedding uses a published URL, including its hosting subdirectory. Temporary preview URLs cannot be embedded. Platform account, signup and checkout links open separately. Fixed height uses normal iframe scrolling; automatic height adjustment is not included.'));
      const refreshEmbedding=()=>{const enabled=(site.embedding?.mode??'disabled')!=='disabled';originsRow.hidden=site.embedding?.mode!=='selected';start.disabled=presentation.disabled=height.disabled=address.disabled=!enabled;code.value='';copy.disabled=!enabled;try{if(enabled&&address.value)code.value=websiteEmbedCode(site,address.value);instructions.textContent='HTTP response header: Content-Security-Policy: frame-ancestors '+websiteFrameAncestors(site.embedding)+'. Managed hosting applies this policy after deployment. Netlify/Cloudflare use the generated _headers file; other hosts need server configuration.';}catch(error){instructions.textContent=error instanceof Error?error.message:'Review embedding settings.';copy.disabled=true;}reportDirty();};
      if(client.mailingListStatus){const mailing=element('section');mailing.className='website-mailing-setup';mailing.append(element('h3','Mailing-list signup'),element('p','Checking signup setup…'));settings.append(mailing);
        void client.mailingListStatus().then(info=>{if(disposed||renderGeneration!==generation)return;mailing.replaceChildren(element('h3','Mailing-list signup'),element('p',info.enabled?'Visitors can enter their email and submit directly on the website. Confirmation and offer delivery are handled by the platform.':'Public signup is not enabled yet. Enable the mailing list to show the email input, opt-in and submit button directly on the website.'));if(!info.emailAvailable)mailing.append(element('p','Email delivery must also be configured before visitors can confirm a signup.'));
          const manage=element('a','Manage mailing list and offers ↗');manage.href=info.manageUrl;manage.target='_blank';manage.rel='noopener noreferrer';mailing.append(manage);
          if(site.theme.settings.mailingListUrl!==info.signupUrl){const explanation=element('p','The saved signup link differs from the current application address. Use the current address, then save settings.');mailing.append(explanation,button('Use current application address',async()=>{site={...site,theme:{...site.theme,settings:{...site.theme.settings,mailingListUrl:info.signupUrl}}};reportDirty();explanation.textContent='Current signup address selected. Save settings to apply it.';}));}
        }).catch(()=>{if(!disposed&&renderGeneration===generation)mailing.replaceChildren(element('h3','Mailing-list signup'),element('p','Review mailing-list setup before publishing a signup form.'));});
      }
      embeddingDetails.append(embedding);settings.append(embeddingDetails,saveSettings);refreshEmbedding();
      if(client.hostingHistory)void client.hostingHistory().then(history=>{if(disposed||renderGeneration!==generation)return;const targets=history.targets.filter(target=>target.serving==='active');if(targets.length){const choice=optionField('Published hosting destination',[{value:'',label:'Custom published URL'},...targets.map(target=>({value:target.publicUrl,label:target.label}))],targets.some(target=>target.publicUrl===address.value)?address.value:'',value=>{address.value=value;change({sourceUrl:value||undefined});});addressRow.before(choice.parentElement!);refreshEmbedding();}}).catch(()=>{});
      if(mountSettings){const host=element('div');host.className='website-creator-access';content.append(host);cleanupSettings=mountSettings(host);}
    }
    if(tab==='Publishing'&&client.hostingHistory){
      let history=await client.hostingHistory();if(disposed||renderGeneration!==generation)return;
      const labels:Record<string,string>={aws:'Managed hosting',native:'Configured server',netlify:'Netlify','cloudflare-pages':'Cloudflare Pages',sftp:'SFTP server',hostinger:'Hostinger'};
      const workspace=element('div'),selector=element('nav'),divider=element('div'),handle=element('div'),surface=element('div');
      workspace.className='website-page-workspace website-publishing-workspace'+(publishingSelectorExpanded?'':' website-pages-collapsed');selector.className='website-page-selector';selector.id='website-publish-destinations-'+site.id;selector.setAttribute('aria-label','Website publishing destinations');selector.hidden=!publishingSelectorExpanded;surface.className='website-publishing-detail';
      const icon=(family:string)=>{const definition=options.hostingPlatformIcons?.[family];if(!definition)return undefined;const svg=d.createElementNS('http://www.w3.org/2000/svg','svg'),path=d.createElementNS('http://www.w3.org/2000/svg','path');svg.setAttribute('viewBox',definition.viewBox??'0 0 24 24');svg.setAttribute('aria-hidden','true');path.setAttribute('d',definition.path);svg.append(path);return svg;};
      const setupLink=(label:string,target?:WebsiteHostingTarget)=>{const url=target&&options.hostingDestinationSetupUrl?options.hostingDestinationSetupUrl(target):options.hostingSetupUrl;if(!url)return undefined;const link=element('a',label+' ↗');link.href=url;link.target='_blank';link.rel='noopener noreferrer';link.className='website-publishing-setup-link';link.setAttribute('aria-label',label+' (opens in a new tab)');return link;};
      const setup=setupLink('Manage destinations in Integrations');if(setup)content.append(setup);
      if(!history.targets.length){content.append(element('p','No publishing destinations are connected to this website. Set up a destination in Integrations, then refresh this page.'),button('Refresh destinations',async()=>show('Publishing')));}
      else{
        if(!history.targets.some(target=>target.id===selectedHostingTarget))selectedHostingTarget=history.targets[0].id;
        const collapse=button('',async()=>{publishingSelectorExpanded=!publishingSelectorExpanded;workspace.classList.toggle('website-pages-collapsed',!publishingSelectorExpanded);selector.hidden=!publishingSelectorExpanded;refreshHandle();});collapse.className='website-page-toggle';collapse.setAttribute('aria-controls',selector.id);
        const refreshHandle=()=>{collapse.setAttribute('aria-label',publishingSelectorExpanded?'Collapse destination selector':'Expand destination selector');collapse.setAttribute('aria-expanded',String(publishingSelectorExpanded));collapse.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="'+(publishingSelectorExpanded?'m15 18-6-6 6-6':'m9 18 6-6-6-6')+'"/></svg>';};refreshHandle();divider.className='website-page-divider';handle.className='website-page-handle-viewport';handle.append(collapse);divider.append(handle);workspace.append(selector,divider,surface);content.append(workspace);
        const pendingStates=['queued','generating','uploading','activating','verifying','unknown'];
        const latestAttempt=(targetId:string)=>history.attempts.filter(attempt=>attempt.targetId===targetId).sort((a,b)=>b.generation-a.generation)[0];
        const expired=(target:WebsiteHostingTarget,attempt:typeof history.attempts[number]|undefined)=>!!attempt&&target.family==='hostinger'&&pendingStates.includes(attempt.state)&&Date.now()-Date.parse(attempt.checkpoint?.data?.requestedAt??attempt.checkpoint?.data?.uploadStartedAt??attempt.checkpoint?.data?.hostingerPreparingAt??'')>900000;
        const anyPending=()=>history.targets.some(target=>{const attempt=latestAttempt(target.id);return !!attempt&&pendingStates.includes(attempt.state)&&!expired(target,attempt);});
        let reviewRequest=false;
        const describe=(target:WebsiteHostingTarget)=>{const attempt=latestAttempt(target.id);return expired(target,attempt)?'Needs attention':attempt&&pendingStates.includes(attempt.state)?({queued:'Queued',generating:'Preparing release',uploading:'Uploading',activating:'Publishing',verifying:'Verifying',unknown:'Needs verification'} as Record<string,string>)[attempt.state]:attempt&&['failed','reconnect_required'].includes(attempt.state)?'Needs attention':target.serving==='active'?'Published':target.serving==='suspended'?'Suspended':'Not published';};
        let progress:HTMLElement,spinner:HTMLElement,progressHeading:HTMLElement,progressDetail:HTMLElement,attemptRows:HTMLElement,review:HTMLButtonElement;
        const updateProgress=()=>{
          const target=history.targets.find(target=>target.id===selectedHostingTarget);if(!target)return;
          const attempt=latestAttempt(target.id),pending=!!attempt&&pendingStates.includes(attempt.state),failed=!!attempt&&['failed','reconnect_required'].includes(attempt.state);
          progress.hidden=!attempt;spinner.hidden=!pending||expired(target,attempt);progress.dataset.state=expired(target,attempt)?'attention':pending?'pending':failed?'attention':'complete';
          progressHeading.textContent=describe(target);
          progressDetail.textContent=expired(target,attempt)?'Hostinger did not confirm this release within fifteen minutes. Automatic checks have stopped. Reconcile or cancel the recorded attempt before submitting another release.':pending?`Your approved release for ${target.label} is ${attempt!.state==='queued'?'waiting to publish':'in progress'}. Status updates automatically; later edits stay out of this release.`:failed?`This destination needs attention${attempt!.errorCode?' ('+attempt!.errorCode+')':''}. Review the release history below.`:target.serving==='active'?'The approved release is published at this destination.':'No release is currently publishing to this destination.';
          review.disabled=reviewRequest||pending||!client.reviewPublication||!client.publishWebsite;
          for(const choice of Array.from(selector.querySelectorAll<HTMLButtonElement>('button[data-target-id]'))){const target=history.targets.find(target=>target.id===choice.dataset.targetId);if(target){choice.setAttribute('aria-pressed',String(target.id===selectedHostingTarget));choice.querySelector('[data-destination-status]')!.textContent=describe(target);}}
        };
        const renderAttempts=()=>{
          attemptRows.replaceChildren();const attempts=history.attempts.filter(attempt=>attempt.targetId===selectedHostingTarget).sort((a,b)=>b.generation-a.generation);
          if(!attempts.length){attemptRows.append(element('p','No releases have been submitted to this destination yet.'));return;}
          const table=element('table'),head=element('thead'),headers=element('tr'),body=element('tbody');table.className='website-publishing-history';table.setAttribute('aria-label','Release history for selected destination');
          for(const label of ['Release','Status','Verification','Actions'])headers.append(element('th',label));head.append(headers);
          for(const attempt of attempts){const target=history.targets.find(target=>target.id===attempt.targetId)!;const current=target.activeAttemptId?target.activeAttemptId===attempt.id:target.activeGeneration===attempt.generation;const row=element('tr'),actions=element('td'),actionGroup=element('div');actionGroup.className='website-publishing-row-actions';row.append(element('td','Generation '+attempt.generation),element('td',attempt.state+(!['published','unpublished'].includes(attempt.state)&&attempt.errorCode?' · '+attempt.errorCode:'')),element('td',attempt.verification?(attempt.verification.publicConfirmed?'Public release verified':attempt.verification.reasons.join(', ')||'Pending'):'Not yet verified'));
            if(client.hostingAction){
              if(attempt===attempts[0]&&['failed','reconnect_required'].includes(attempt.state))actionGroup.append(button('Retry deployment',async()=>{await client.hostingAction!('retry',attempt.id,{idempotencyKey:crypto.randomUUID()});await show('Publishing');}));
              if(['unknown','verifying'].includes(attempt.state))actionGroup.append(button('Reconcile status',async()=>{await client.hostingAction!('reconcile',attempt.id);await show('Publishing');}));
              if(['queued','generating','uploading'].includes(attempt.state))actionGroup.append(button('Cancel deployment',async()=>{await client.hostingAction!('cancel',attempt.id);await show('Publishing');}));
              if(attempt.state==='published'&&!current&&target.capabilities.rollback!=='unsupported')actionGroup.append(button('Restore release',async()=>{const target=history.targets.find(target=>target.id===attempt.targetId)!;const key=crypto.randomUUID();await confirmAction('Restore '+target.label+'?','This replaces the content at '+target.publicUrl+' with generation '+attempt.generation+'. Later saved edits remain in the editor.','Restore release',async()=>{await client.hostingAction!('rollback',target.id,{attemptId:attempt.id,idempotencyKey:key});await show('Publishing');});}));
            }
            if(current)actions.append(element('span','Current release'));else if(actionGroup.childElementCount)actions.append(actionGroup);else actions.append(element('span','—'));
            row.append(actions);body.append(row);
          }
          table.append(head,body);const scroll=element('div');scroll.className='website-publishing-history-scroll';scroll.append(table);attemptRows.append(scroll);
        };
        const renderSelected=()=>{
          const target=history.targets.find(target=>target.id===selectedHostingTarget)!;surface.replaceChildren();
          const header=element('header'),identity=element('div'),title=element('h3',labels[target.family]??target.family),mark=icon(target.family);header.className='website-publishing-heading';identity.className='website-publishing-identity';if(mark)identity.append(mark);identity.append(title);header.append(identity,element('span',target.label));surface.append(header);
          const publicLink=element('a',target.publicUrl+' ↗');publicLink.href=target.publicUrl;publicLink.target='_blank';publicLink.rel='noopener noreferrer';surface.append(publicLink);
          progress=element('div');spinner=element('span');const message=element('div');progressHeading=element('strong');progressDetail=element('p');progress.className='website-publish-progress';progress.setAttribute('role','status');progress.setAttribute('aria-live','polite');spinner.className='website-publish-spinner';spinner.setAttribute('aria-hidden','true');message.append(progressHeading,progressDetail);progress.append(spinner,message);surface.append(progress);
          const release=element('section');release.className='website-publishing-release';release.append(element('h4','Publish a release'),element('p','Review saved revision '+site.revision+' for '+target.label+'. This action publishes only to this selected destination. Later draft edits are excluded.'));
          review=button('Review and publish release',async()=>{
            if(reviewRequest)return;reviewRequest=true;updateProgress();try{
            const id=target.id,plan=await client.reviewPublication!(site.revision,[id]);if(disposed||renderGeneration!==generation||selectedHostingTarget!==id)return;
            const approvalKey=crypto.randomUUID();await confirmAction('Publish '+site.title+' to '+target.label+'?',`Saved revision ${site.revision}. Later draft edits are excluded.\nDestination: ${target.publicUrl}\nReview expires ${options.formatDate?.(plan.expiresAt)??new Date(plan.expiresAt).toLocaleString(undefined,{timeZoneName:'short'})}.\nThis replaces the selected destination’s hosted website. Staged external deploy URLs can be public.`,'Publish approved release',async()=>{await client.publishWebsite!(plan.planId,plan.fingerprint,approvalKey);status.textContent='';await show('Publishing');});
            }finally{reviewRequest=false;if(!disposed&&renderGeneration===generation)updateProgress();}
          });review.className='website-publishing-review';release.append(review,button('Refresh publishing status',async()=>show('Publishing')));surface.append(release);
          const management=element('details');management.className='website-publishing-actions';management.append(element('summary','More actions'));
          const manage=setupLink('Manage destination in Integrations',target);if(manage)management.append(manage);
          if(target.servingRemovalRequired)surface.append(element('p','This destination requires serving removal. Removal has not yet been confirmed.'));
          if(client.hostingAction&&target.serving==='suspended'&&target.capabilities.emergencySuspension&&target.activeGeneration>0)management.append(button('Resume eligible serving',async()=>{await client.hostingAction!('resume',target.id);await show('Publishing');}));
          if(client.hostingAction&&target.capabilities.unpublish==='confirmed')management.append(button('Unpublish destination',async()=>{const key=crypto.randomUUID();await confirmAction('Unpublish '+target.label+'?','This removes '+target.publicUrl+' from public view. Other destinations stay published. A retained release can be published again.','Unpublish website',async()=>{await client.hostingAction!('unpublish',target.id,{idempotencyKey:key});await show('Publishing');});}));
          else management.append(element('p','To remove this live website, use the hosting provider.'));
          surface.append(management);
          const domains=history.domains?.filter(domain=>domain.targetId===target.id)??[];if(domains.length){const list=element('section');list.append(element('h4','Custom domains'));for(const domain of domains)list.append(element('p',domain.hostname+' · '+domain.state));surface.append(list);}
          const releases=element('section');releases.className='website-publishing-releases';releases.append(element('h4','Release history'));attemptRows=element('div');releases.append(attemptRows);surface.append(releases);updateProgress();renderAttempts();
        };
        for(const target of history.targets){const choice=button('',async()=>{selectedHostingTarget=target.id;renderSelected();});choice.className='website-page-choice website-publishing-destination';choice.dataset.targetId=target.id;const identity=element('span'),mark=icon(target.family);identity.className='website-publishing-identity';if(mark)identity.append(mark);identity.append(element('strong',labels[target.family]??target.family));const state=element('span',describe(target));state.dataset.destinationStatus='';choice.append(identity,element('span',target.label),state);selector.append(choice);}
        renderSelected();
        const poll=()=>{publishingTimer=setTimeout(async()=>{publishingTimer=undefined;if(disposed||renderGeneration!==generation)return;if(d.hidden){poll();return;}try{const latest=await client.hostingHistory!();if(disposed||renderGeneration!==generation)return;history=latest;if(!history.targets.some(target=>target.id===selectedHostingTarget)){await show('Publishing');return;}updateProgress();renderAttempts();if(anyPending())poll();}catch{if(!disposed&&renderGeneration===generation){progressDetail.textContent='Waiting for a status update. We’ll check again automatically.';poll();}}},5000);};if(anyPending())poll();
      }
    }
    if(tab==='Pages') {
      if(!selectedPage||!['new','redirects',...site.pages.map(p=>p.id)].includes(selectedPage))selectedPage=site.homePageId;
      const workspace=element('div'),selector=element('nav'),divider=element('div'),handle=element('div'),surface=element('div');
      workspace.className='website-page-workspace'+(pageSelectorExpanded?'':' website-pages-collapsed');selector.className='website-page-selector';selector.id='website-pages-'+site.id;selector.setAttribute('aria-label','Website pages');selector.tabIndex=0;selector.hidden=!pageSelectorExpanded;surface.className='website-page-surface';
      for(const page of [...site.pages].sort((a,b)=>a.order-b.order)){
        const choice=button(page.title,async()=>{selectedPage=page.id;await show('Pages');});choice.className='website-page-choice';choice.dataset.child=String(!!page.parentId);choice.setAttribute('aria-pressed',String(selectedPage===page.id));if(page.id===site.homePageId){const icon=d.createElementNS('http://www.w3.org/2000/svg','svg'),path=d.createElementNS('http://www.w3.org/2000/svg','path');icon.setAttribute('viewBox','0 0 24 24');icon.setAttribute('aria-hidden','true');icon.classList.add('website-home-icon');path.setAttribute('d','M3 10 12 3l9 7v11h-6v-7H9v7H3Z');icon.append(path);choice.prepend(icon);choice.setAttribute('aria-label',page.title+' · Homepage');}
        const pageRow=element('div');pageRow.className='website-page-selector-row';
        const remove=button('',async()=>{
          const home=page.id===site.homePageId,fields=element('div');let replacement:string|undefined;
          if(home){const label=element('label','Replacement homepage'),select=element('select');select.setAttribute('aria-label','Replacement homepage');const placeholder=element('option','Choose a Ready page');placeholder.value='';select.append(placeholder);for(const candidate of site.pages.filter(candidate=>candidate.id!==page.id&&candidate.state==='ready'&&candidate.kind!=='update')){const option=element('option',candidate.title);option.value=candidate.id;select.append(option);}select.onchange=()=>replacement=select.value;label.append(select);fields.append(label);}
          await confirmAction('Delete page “'+page.title+'”?','This removes the page and its navigation entries from '+site.title+'. Child pages become top-level pages. Shared content and images are retained. Links in other page content may need updating. Unsaved content for this page will be discarded. The published website changes after you publish again. This action cannot be undone.','Delete page',async()=>{
            if(uploads||client.pendingUploads?.())throw new Error('Wait for image uploads to finish before deleting a page.');
            const draft=removeWebsitePage(site,page.id,replacement),baseline=JSON.parse(savedSite) as Website,expected=baseline.revision;
            const saved=await client.save({...removeWebsitePage(baseline,page.id,replacement),revision:expected+1},expected);
            site={...draft,revision:saved.revision};savedSite=JSON.stringify(saved);notifyWebsitePreviewSaved(saved);
            if(!site.pages.some(candidate=>candidate.documentId===page.documentId)){documentDrafts.delete(page.documentId);documentBaselines.delete(page.documentId);}
            if(selectedPage===page.id)selectedPage=site.homePageId;
            status.textContent='Page “'+page.title+'” deleted. Publish again to update the live website.';reportDirty();await show('Pages');
          },home?fields:undefined);
        });remove.className='website-page-delete';remove.setAttribute('aria-label','Delete page '+page.title);remove.title=site.pages.length===1?'Add another page before deleting the only page.':'Delete page '+page.title;remove.disabled=site.pages.length===1;
        const trash=d.createElementNS('http://www.w3.org/2000/svg','svg'),trashPath=d.createElementNS('http://www.w3.org/2000/svg','path');trash.setAttribute('viewBox','0 0 24 24');trash.setAttribute('fill','none');trash.setAttribute('stroke','currentColor');trash.setAttribute('stroke-width','1.8');trash.setAttribute('aria-hidden','true');trashPath.setAttribute('d','M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7');trash.append(trashPath);remove.append(trash);
        const preview=previewButton('Preview',()=>page.id,page.title);preview.textContent='';preview.className='website-page-preview website-page-delete';
        const eye=d.createElementNS('http://www.w3.org/2000/svg','svg');eye.setAttribute('viewBox','0 0 24 24');eye.setAttribute('fill','none');eye.setAttribute('stroke','currentColor');eye.setAttribute('stroke-width','1.8');eye.setAttribute('aria-hidden','true');const eyePath=d.createElementNS('http://www.w3.org/2000/svg','path');eyePath.setAttribute('d','M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z');const pupil=d.createElementNS('http://www.w3.org/2000/svg','circle');pupil.setAttribute('cx','12');pupil.setAttribute('cy','12');pupil.setAttribute('r','3');eye.append(eyePath,pupil);preview.append(eye);pageRow.append(choice,preview,remove);selector.append(pageRow);
      }
      const pageActions=element('div'),newPage=button('New page',async()=>{selectedPage='new';await show('Pages');}),redirect=button('Add a redirect',async()=>{selectedPage='redirects';await show('Pages');});pageActions.className='website-page-selector-actions';newPage.className='website-selector-action website-selector-action-primary';redirect.className='website-selector-action website-selector-action-secondary';for(const [action,symbol] of [[newPage,'+'],[redirect,'↪']] as const){const icon=element('span',symbol);icon.setAttribute('aria-hidden','true');action.prepend(icon);}pageActions.append(newPage,redirect);selector.append(pageActions);
      divider.className='website-page-divider';handle.className='website-page-handle-viewport';const toggle=button('',async()=>{pageSelectorExpanded=!pageSelectorExpanded;workspace.classList.toggle('website-pages-collapsed',!pageSelectorExpanded);selector.hidden=!pageSelectorExpanded;updateToggle();measurePages();});toggle.className='website-page-toggle';toggle.setAttribute('aria-controls',selector.id);
      const updateToggle=()=>{toggle.setAttribute('aria-label',pageSelectorExpanded?'Collapse page selector':'Expand page selector');toggle.setAttribute('aria-expanded',String(pageSelectorExpanded));const svg=d.createElementNS('http://www.w3.org/2000/svg','svg'),path=d.createElementNS('http://www.w3.org/2000/svg','path');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('fill','none');svg.setAttribute('stroke','currentColor');svg.setAttribute('stroke-width','2');svg.setAttribute('aria-hidden','true');path.setAttribute('d',pageSelectorExpanded?'m15 18-6-6 6-6':'m9 18 6-6-6-6');svg.append(path);toggle.replaceChildren(svg);};updateToggle();handle.append(toggle);divider.append(handle);workspace.append(selector,divider,surface);content.append(workspace);
      for(const p of site.pages.filter(page=>page.id===selectedPage)) {
        const row=element('div');row.className='website-page-settings-fields';
        const editPage=(patch:Partial<typeof p>)=>{site={...site,pages:site.pages.map(next=>next.id===p.id?{...next,...patch,revision:next.revision+1}:next)};};
        const heading=element('div'),headingFields=element('div'),pageContent=element('div'),settings=element('div');
        heading.className='portable-section-heading website-page-block-heading';headingFields.className='website-page-heading-fields';
        pageContent.className='website-page-main-content';pageContent.id='website-page-content-'+p.id;settings.id='website-page-settings-'+p.id;settings.className='website-page-settings';settings.hidden=true;
        const collapse=button('',async()=>{pageContent.hidden=!pageContent.hidden;collapse.setAttribute('aria-expanded',String(!pageContent.hidden));collapseMark.textContent=pageContent.hidden?'▸':'▾';});collapse.className='portable-section-collapse';collapse.setAttribute('aria-expanded','true');collapse.setAttribute('aria-controls',pageContent.id);
        const collapseMark=element('span','▾');collapseMark.setAttribute('aria-hidden','true');const pageIcon=d.createElementNS('http://www.w3.org/2000/svg','svg'),pageIconPath=d.createElementNS('http://www.w3.org/2000/svg','path');pageIcon.classList.add('portable-block-type-icon');pageIcon.setAttribute('viewBox','0 0 24 24');pageIcon.setAttribute('fill','none');pageIcon.setAttribute('stroke','currentColor');pageIcon.setAttribute('stroke-width','1.8');pageIcon.setAttribute('stroke-linejoin','round');pageIcon.setAttribute('aria-hidden','true');pageIconPath.setAttribute('d','M5 3h9l5 5v13H5ZM14 3v6h5M9 13h6M9 17h6');pageIcon.append(pageIconPath);collapse.append(collapseMark,pageIcon,d.createTextNode('Page: Main Content Area'));
        const edit=button('',async()=>{settings.hidden=!settings.hidden;edit.setAttribute('aria-expanded',String(!settings.hidden));settingsMark.textContent=settings.hidden?'▾':'▴';});edit.className='portable-section-more';edit.setAttribute('aria-label','Page settings');edit.setAttribute('aria-controls',settings.id);edit.setAttribute('aria-expanded','false');
        const gear=element('span','⚙'),settingsMark=element('span','▾');gear.setAttribute('aria-hidden','true');settingsMark.setAttribute('aria-hidden','true');edit.append(gear,d.createTextNode(' Settings '),settingsMark);
        const helpPanel=element('div','Add and arrange content blocks. Insert an existing Work image or upload an image directly here.');helpPanel.id='website-page-help-'+p.id;helpPanel.className='website-page-content-help';helpPanel.hidden=true;helpPanel.setAttribute('role','region');helpPanel.setAttribute('aria-label','Page content help');
        const help=button('',async()=>{helpPanel.hidden=!helpPanel.hidden;help.setAttribute('aria-expanded',String(!helpPanel.hidden));});help.className='website-page-help-toggle';help.setAttribute('aria-label','Page content help');help.title='Page content help';help.setAttribute('aria-expanded','false');help.setAttribute('aria-controls',helpPanel.id);
        const helpIcon=d.createElementNS('http://www.w3.org/2000/svg','svg'),helpCircle=d.createElementNS('http://www.w3.org/2000/svg','circle'),helpPath=d.createElementNS('http://www.w3.org/2000/svg','path');helpIcon.setAttribute('viewBox','0 0 24 24');helpIcon.setAttribute('fill','none');helpIcon.setAttribute('stroke','currentColor');helpIcon.setAttribute('stroke-width','1.8');helpIcon.setAttribute('stroke-linecap','round');helpIcon.setAttribute('aria-hidden','true');helpCircle.setAttribute('cx','12');helpCircle.setAttribute('cy','12');helpCircle.setAttribute('r','9');helpPath.setAttribute('d','M9.5 9a2.5 2.5 0 0 1 5 .5c0 1.5-2.5 2-2.5 3.5M12 16h.01');helpIcon.append(helpCircle,helpPath);help.append(helpIcon);
        const dismissHelp=(event:KeyboardEvent)=>{if(event.key==='Escape'&&!helpPanel.hidden){event.preventDefault();event.stopPropagation();helpPanel.hidden=true;help.setAttribute('aria-expanded','false');help.focus();}};help.addEventListener('keydown',dismissHelp);helpPanel.addEventListener('keydown',dismissHelp);
        let fullscreenDialog:HTMLDialogElement|undefined;
        const openEditorOverlay=()=>{
          const parent=surface.parentNode!,next=surface.nextSibling,dialog=element('dialog');dialog.className='website-editor-fullscreen-dialog';dialog.setAttribute('aria-label','Full screen page editor');
          const close=()=>{if(dialog.open)dialog.close();parent.insertBefore(surface,next);dialog.remove();dialogs.delete(dialog);fullscreenDialog=undefined;editorFullscreenCleanup=undefined;updateFullscreen();if(!disposed)fullscreen.focus();};
          dialog.oncancel=event=>{event.preventDefault();close();};fullscreenDialog=dialog;editorFullscreenCleanup=close;dialogs.set(dialog,close);dialog.append(surface);root.append(dialog);dialog.showModal();updateFullscreen();fullscreen.focus();
        };
        const fullscreen=button('',async()=>{if(fullscreenDialog?.open){editorFullscreenCleanup?.();return;}if(d.fullscreenElement===surface){await d.exitFullscreen();return;}try{if(!d.fullscreenEnabled||!surface.requestFullscreen){openEditorOverlay();return;}await surface.requestFullscreen();}catch{openEditorOverlay();}});fullscreen.className='website-page-fullscreen-toggle';fullscreen.setAttribute('aria-label','Full screen editor');fullscreen.title='Full screen editor';fullscreen.setAttribute('aria-pressed','false');
        const fullscreenIcon=d.createElementNS('http://www.w3.org/2000/svg','svg'),fullscreenPath=d.createElementNS('http://www.w3.org/2000/svg','path');fullscreenIcon.setAttribute('viewBox','0 0 24 24');fullscreenIcon.setAttribute('fill','none');fullscreenIcon.setAttribute('stroke','currentColor');fullscreenIcon.setAttribute('stroke-width','1.8');fullscreenIcon.setAttribute('stroke-linecap','round');fullscreenIcon.setAttribute('aria-hidden','true');fullscreenIcon.append(fullscreenPath);fullscreen.append(fullscreenIcon);
        const updateFullscreen=()=>{const active=d.fullscreenElement===surface||!!fullscreenDialog?.open;fullscreen.setAttribute('aria-pressed',String(active));fullscreen.setAttribute('aria-label',active?'Exit full screen editor':'Full screen editor');fullscreen.title=active?'Exit full screen editor':'Full screen editor';fullscreenPath.setAttribute('d',active?'M3 8h5V3m8 0v5h5M8 21v-5H3m18 0h-5v5':'M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5');};surface.onfullscreenchange=updateFullscreen;updateFullscreen();
        heading.append(collapse,edit,help,fullscreen,previewButton('Preview in new tab',()=>p.id));row.append(headingFields);settings.append(row);surface.append(heading,helpPanel,settings,pageContent);
        field(headingFields,'Page title',p.title,v=>{editPage({title:v});topHeading.placeholder=v;});
        const topHeading=field(headingFields,'Top heading',p.heading??'',v=>editPage({heading:v.trim()?v:undefined}));topHeading.placeholder=p.title;
        headingFields.append(element('p','Leave the top heading blank to use the page title. Save page to keep these changes.'));
        const headingLabel=element('label','Show heading at the top of the page'),showHeading=element('input');headingLabel.className='website-page-heading-toggle';showHeading.type='checkbox';showHeading.checked=p.showHeading!==false;showHeading.onchange=()=>{editPage({showHeading:showHeading.checked});topHeading.disabled=!showHeading.checked;};topHeading.disabled=p.showHeading===false;headingLabel.prepend(showHeading);headingFields.append(headingLabel);
        field(row,'Search title',p.seoTitle??'',v=>editPage({seoTitle:v||undefined}));
        field(row,'Search description',p.description??'',v=>editPage({description:v||undefined}));
        field(row,'Canonical URL (optional)',p.canonicalUrl??'',v=>editPage({canonicalUrl:v||undefined}));
        if(options.showAssetIds!==false)field(row,'Social preview asset ID (optional)',p.socialAssetId??'',v=>editPage({socialAssetId:v||undefined}));
        const design=element('details');design.className='website-page-design';design.append(element('summary','Page template and images'));
        const templates=element('div');templates.className='website-template-grid';
        for(const template of WEBSITE_PAGE_TEMPLATES){const choice=button(template.title,async()=>{status.textContent='Page template changed. Save page settings to keep this layout.';editPage({template:template.id,layout:template.id==='gallery'?'wide':p.layout});for(const b of Array.from(templates.querySelectorAll('button')))b.setAttribute('aria-pressed',String(b===choice));});choice.setAttribute('aria-pressed',String((p.template??'standard')===template.id));choice.className='website-template-choice';choice.append(element('small',template.description));templates.append(choice);}design.append(templates);
        if(client.media){await mediaField(design,'Cover',p.coverAssetId,id=>editPage({coverAssetId:id}),p.coverPosition,position=>editPage({coverPosition:position}));await mediaField(design,'Background',p.backgroundAssetId,id=>editPage({backgroundAssetId:id}),p.backgroundPosition,position=>editPage({backgroundPosition:position}));}row.append(design);
        if(p.kind==='update') field(row,'Update date',p.date??'',v=>editPage({date:v||undefined}));
        if(p.kind!=='home') {const state=element('select');state.setAttribute('aria-label','Page lifecycle');for(const value of ['draft','ready','archived']){const option=element('option',value);option.value=value;state.append(option);}state.value=p.state;state.onchange=()=>editPage({state:state.value as typeof p.state});row.append(state);}
        row.append(button('Duplicate document for this page',async()=>{const source=await client.document(p.documentId),id=globalThis.crypto.randomUUID();await client.saveDocument({...documentDrafts.get(p.documentId)??source.document,id,revision:1},0);editPage({documentId:id});await save();await show('Pages');}));
        const openContent=async()=>{
          const result=await client.document(p.documentId);if(disposed||renderGeneration!==generation)return;const editor=element('div');editor.className='website-page-content-editor';documentBaselines.set(p.documentId,JSON.stringify(result.document));let doc=documentDrafts.get(p.documentId)??result.document;
          if(result.sharedBy.length>1)pageContent.append(element('p',`This content is shared by: ${result.sharedBy.map(page=>page.title).join(', ')}. Duplicate the document in Page settings to edit this page independently.`));pageContent.append(editor);
          const mount=()=>{cleanupEditor?.();cleanupEditor=mountEditor(editor,doc,next=>{doc=next;documentDrafts.set(doc.id,doc);reportDirty();});};mount();
          let saving=false;const savePage=button('Save page',async()=>{if(saving)return;if(uploads||client.pendingUploads?.())throw new Error('Wait for image uploads to finish before saving.');saving=true;savePage.disabled=true;try{if(documentDrafts.has(doc.id)){doc=await client.saveDocument({...doc,revision:doc.revision+1},doc.revision);documentDrafts.delete(doc.id);mount();}await save();status.textContent='Page content and settings saved.';await show('Pages');}finally{saving=false;savePage.disabled=false;}});pageContent.append(savePage);

        };
        if(p.kind!=='home') {
          field(row,'Path segment',p.slug,v=>{site={...site,pages:site.pages.map(next=>next.id===p.id?{...next,slug:v,revision:next.revision+1}:next)};});
          const label=element('label','Parent'),select=element('select');
          for(const candidate of [{id:'',title:'Top level'},...site.pages.filter(x=>x.kind!=='home'&&x.kind!=='update'&&!x.parentId&&x.id!==p.id)]) {const option=element('option',candidate.title);option.value=candidate.id;select.append(option);}
          select.value=p.parentId??'';select.onchange=()=>{site={...site,pages:site.pages.map(next=>next.id===p.id?{...next,parentId:select.value||undefined,revision:next.revision+1}:next)};};label.append(select);row.append(label);
        }
        const label=element('label','Show in top navigation'),check=element('input');check.type='checkbox';check.checked=p.navigation;check.onchange=()=>{site={...site,pages:site.pages.map(next=>next.id===p.id?{...next,navigation:check.checked,revision:next.revision+1}:next)};};label.append(check);row.append(label);
        const footerLabel=element('label','Show in footer navigation'),footerCheck=element('input');footerCheck.type='checkbox';footerCheck.checked=p.footerNavigation??false;footerCheck.onchange=()=>editPage({footerNavigation:footerCheck.checked});footerLabel.append(footerCheck);row.append(footerLabel);
        row.append(button('Move up',async()=>{const ordered=[...site.pages].sort((a,b)=>a.order-b.order);const i=ordered.findIndex(x=>x.id===p.id);if(i>0)[ordered[i],ordered[i-1]]=[ordered[i-1],ordered[i]];site={...site,pages:ordered.map((p,i)=>({...p,order:i,revision:p.revision+1}))};await save();await show('Pages');}));await openContent();if(disposed||renderGeneration!==generation)return;
      }
      if(selectedPage==='redirects'){
      surface.append(element('p','Previously published page and collection-gallery paths redirect automatically after a path change. Redirects take effect with your next website publication.'));
      const redirects=element('label','Redirects: one previous path => current path or external URL per line'),text=element('textarea');
      text.value=site.redirects.map(r=>r.from+' => '+r.to).join('\n');text.dataset.websiteDraftInitial=text.value;
      prepareDraft=()=>{site={...site,redirects:text.value.split('\n').filter(s=>s.trim()).map(line=>{const [from,to,...extra]=line.split('=>').map(s=>s.trim());if(!from||!to||extra.length)throw new Error('Redirects require previous path => destination.');return {from,to,status:301 as const};})};};
      redirects.append(text);surface.append(redirects,button('Save redirects',async()=>{prepareDraft();await save();}));

      }
      if(selectedPage==='new'){surface.append(element('h2','New page'));
      const add=element('div');let title='',slug='',kind:'page'|'portfolio'|'update'='page',template:Website['pages'][number]['template']='standard';field(add,'New page title','',v=>title=v);field(add,'New page path','',v=>slug=v);prepareDraft=()=>{if(title||slug)throw new Error('Add the new page before previewing your changes.');};
      const select=element('select');select.setAttribute('aria-label','Page kind');for(const k of ['page','portfolio','update'] as const){const o=element('option',k);o.value=k;select.append(o);}select.onchange=()=>kind=select.value as typeof kind;add.append(select);
      const templateSelect=element('select');templateSelect.setAttribute('aria-label','New page template');for(const t of WEBSITE_PAGE_TEMPLATES){const o=element('option',t.title);o.value=t.id;templateSelect.append(o);}templateSelect.onchange=()=>template=templateSelect.value as typeof template;add.append(templateSelect);
      add.append(button('Add page',async()=>{if(!title.trim()||!slug.trim())throw new Error('Page title and path are required.');const id=globalThis.crypto.randomUUID(),documentId=globalThis.crypto.randomUUID();await client.saveDocument({id:documentId,workspaceId:site.workspaceId,revision:1,blocks:template==='gallery'?[{type:'gallery_list',id:globalThis.crypto.randomUUID() as EntityId,data:{sort:'newest',pageSize:12,websiteGalleryId:site.namedGalleries?.[0]?.id}}]:[{type:'paragraph',id:globalThis.crypto.randomUUID() as EntityId,text:template==='profile'?'Introduce yourself and your work.':'Add your page content here.'}]},0);site={...site,pages:[...site.pages,{id,documentId,websiteId:site.id,workspaceId:site.workspaceId,revision:1,kind,title,slug,template,order:site.pages.length,state:'ready',navigation:true,footerNavigation:false}]};selectedPage=id;await save();await show('Pages');}));surface.append(add);}
    }
    if(tab==='Appearance') {
      content.append(element('p','Visual styles apply to every website purpose. Changing style preserves your pages and content.'));

      const themes=element('div');themes.className='website-theme-grid';
      for(const theme of WEBSITE_THEMES){const choice=button(theme.title,async()=>{site={...site,theme:{...site.theme,id:theme.id}};status.textContent='Theme selected. Save appearance to keep this theme.';for(const b of Array.from(themes.querySelectorAll('button')))b.setAttribute('aria-pressed',String(b===choice));});choice.setAttribute('aria-pressed',String(site.theme.id===theme.id));choice.className='website-theme-choice';for(const palette of [theme.light,theme.dark]){const swatch=element('span','Aa');swatch.className='website-theme-swatch';swatch.setAttribute('aria-hidden','true');swatch.style.background=palette.canvas;swatch.style.color=palette.text;swatch.style.borderColor=palette.action;choice.append(swatch);}themes.append(choice);}content.append(element('h3','Theme'),themes,element('p','Every theme supports light, dark, and system modes. Save appearance, then rebuild to preview the website.'));
      const setting=<K extends keyof Website['theme']['settings']>(key:K,value:Website['theme']['settings'][K])=>site={...site,theme:{...site.theme,settings:{...site.theme.settings,[key]:value}}};
      content.append(element('h3','Platform membership and offers'),element('p','Visitors continue to your platform-hosted checkout, membership account, or mailing-list offer. Leave unused links blank. Signup, consent, delivery and access are handled at the linked destination.'));
      for(const [key,label] of [['membershipUrl','Membership / checkout URL'],['memberAccountUrl','Membership account URL'],['mailingListUrl','Mailing-list / offer signup URL'],['bookingUrl','Session booking URL'],['clientGalleryUrl','Private client gallery URL'],['trailerUrl','Featured trailer / playback URL'],['podcastFeedUrl','Public podcast feed URL (do not use a private member feed)'],['sponsorshipUrl','Sponsorship information URL'],['inquiryUrl','Commission / service inquiry URL'],['ticketsUrl','Event tickets / attendance URL'],['courseUrl','Workshop / course enrollment URL'],['storeUrl','Store / checkout destination URL'],['audioUrl','Featured audio / listening URL'],['releaseUrl','Release purchase URL'],['merchandiseUrl','Merchandise store URL']] as const)field(content,label,site.theme.settings[key]??'',value=>setting(key,value.trim()||undefined));
      if(client.media)await mediaField(content,'Favicon',site.theme.settings.faviconAssetId,id=>setting('faviconAssetId',id));
      field(content,'Accent color (six-digit hex; contrast checked on save)',site.theme.settings.accentColor??'',v=>site={...site,theme:{...site.theme,settings:{...site.theme.settings,accentColor:v||undefined}}});
      const font=element('select');font.setAttribute('aria-label','Font preset');for(const value of ['system','serif']){const option=element('option',value);option.value=value;font.append(option);}font.value=site.theme.settings.font??'system';font.onchange=()=>{site={...site,theme:{...site.theme,settings:{...site.theme.settings,font:font.value as 'system'|'serif'}}};};content.append(font);
      const select=element('select');select.setAttribute('aria-label','Color mode');for(const mode of ['light','dark','system'] as const){const o=element('option',mode);o.value=mode;select.append(o);}select.value=site.theme.settings.colorMode??'light';select.onchange=()=>{site={...site,theme:{...site.theme,settings:{...site.theme.settings,colorMode:select.value as 'light'|'dark'|'system'}}};};content.append(select,button('Save appearance',save));
    }
    if(tab==='Layout') {
      const workspace=element('div'),selector=element('nav'),divider=element('div'),surface=element('div');
      workspace.className='website-page-workspace'+(layoutSelectorExpanded?'':' website-pages-collapsed');selector.className='website-page-selector';selector.id='website-layout-'+site.id;selector.setAttribute('aria-label','Website layout');selector.hidden=!layoutSelectorExpanded;surface.className='website-page-surface';
      for(const name of ['Header','Top navigation','Footer']){const choice=button(name,async()=>{selectedLayout=name;await show('Layout');});choice.className='website-page-choice';choice.setAttribute('aria-pressed',String(selectedLayout===name));selector.append(choice);}
      divider.className='website-page-divider';const handle=element('div');handle.className='website-page-handle-viewport';const toggle=button('',async()=>{layoutSelectorExpanded=!layoutSelectorExpanded;workspace.classList.toggle('website-pages-collapsed',!layoutSelectorExpanded);selector.hidden=!layoutSelectorExpanded;updateToggle();measurePages();});toggle.className='website-page-toggle';toggle.setAttribute('aria-controls',selector.id);
      const updateToggle=()=>{toggle.setAttribute('aria-label',layoutSelectorExpanded?'Collapse layout selector':'Expand layout selector');toggle.setAttribute('aria-expanded',String(layoutSelectorExpanded));const svg=d.createElementNS('http://www.w3.org/2000/svg','svg'),path=d.createElementNS('http://www.w3.org/2000/svg','path');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('fill','none');svg.setAttribute('stroke','currentColor');svg.setAttribute('stroke-width','2');svg.setAttribute('aria-hidden','true');path.setAttribute('d',layoutSelectorExpanded?'m15 18-6-6 6-6':'m9 18 6-6-6-6');svg.append(path);toggle.replaceChildren(svg);};updateToggle();handle.append(toggle);divider.append(handle);workspace.append(selector,divider,surface);content.append(workspace);surface.append(element('h2',selectedLayout));
      const setting=<K extends keyof Website['theme']['settings']>(key:K,value:Website['theme']['settings'][K])=>site={...site,theme:{...site.theme,settings:{...site.theme.settings,[key]:value}}};
      const layout=(name:string,key:'headerLayout'|'footerLayout',values:string[])=>{const l=element('label',name),select=element('select');select.setAttribute('aria-label',name);for(const value of values){const o=element('option',value==='split'?'Brand left · navigation right':value==='centered'?(key==='headerLayout'?'Centered wordmark · no logo':'Centered navigation'):value==='stacked'?'Centered brand · navigation below':'Compact footer');o.value=value;select.append(o);}select.value=site.theme.settings[key]??'split';select.onchange=()=>setting(key,select.value as 'split'|'centered');l.append(select);surface.append(l);};
      if(selectedLayout==='Header')layout('Header layout','headerLayout',['split','centered','stacked']);
      if(selectedLayout==='Footer')layout('Footer layout','footerLayout',['split','centered','minimal']);
      if(selectedLayout==='Header'){const wordmarkLabel=element('label','Show site wordmark beside logo'),wordmark=element('input');wordmark.type='checkbox';wordmark.checked=site.theme.settings.showWordmark!==false;wordmark.onchange=()=>setting('showWordmark',wordmark.checked);wordmarkLabel.append(wordmark);surface.append(wordmarkLabel);
      if(client.media){surface.append(element('p','Images used here are included in your exported website. Centered wordmark headers hide the logo.'));await mediaField(surface,'Logo',site.theme.settings.logoAssetId,id=>setting('logoAssetId',id));}
      }
      if(selectedLayout==='Top navigation'||selectedLayout==='Footer')for(const key of (selectedLayout==='Footer'?['footerLinks']:['navigationLinks']) as ('footerLinks'|'navigationLinks')[]){const l=element('label',key==='navigationLinks'?'Extra header links · Label | https://… or mailto:… per line':'Extra footer links · Label | https://… or mailto:… per line'),textarea=element('textarea');textarea.value=(site[key]??[]).map(link=>link.label+' | '+link.url).join('\n');textarea.onchange=()=>{site={...site,[key]:textarea.value.split('\n').filter(line=>line.trim()).map(line=>{const at=line.indexOf('|');return {label:line.slice(0,at).trim(),url:line.slice(at+1).trim()};})};};l.append(textarea);surface.append(l);}
      if(selectedLayout==='Footer')field(surface,'Footer text',site.theme.settings.footer??'',v=>site={...site,theme:{...site.theme,settings:{...site.theme.settings,footer:v}}});
      if(selectedLayout==='Footer'){const label=element('label','Show year-based copyright notice'),check=element('input');check.type='checkbox';check.checked=site.theme.settings.showCopyright!==false;check.onchange=()=>setting('showCopyright',check.checked);label.append(check);surface.append(label,element('p',`© ${new Date().getFullYear()} ${site.title} · The year updates when you rebuild the website.`));}
      if(selectedLayout==='Header'&&options.showAssetIds!==false)field(surface,'Logo public asset ID',site.theme.settings.logoAssetId??'',v=>site={...site,theme:{...site.theme,settings:{...site.theme.settings,logoAssetId:v||undefined}}});

      if(selectedLayout==='Top navigation'||selectedLayout==='Footer'){
        const footer=selectedLayout==='Footer',key=footer?'footerNavigation':'navigation',orderKey=footer?'footerNavigationOrder':'navigationOrder',parentKey=footer?'footerNavigationParentId':'navigationParentId';
        surface.append(element('h3',footer?'Footer navigation':'Navigation items'),element('p','Drag links between rows to reorder them, or into an indented area to create a dropdown. Use the arrows to move links without dragging. Save the menu to keep your changes.'));
        const menu=element('div');menu.className='website-navigation-editor';surface.append(menu);let draggedPageId:string|undefined;
        const included=(page:WebsitePage)=>!!page[key];
        const change=(updates:Map<string,Partial<WebsitePage>>)=>{site={...site,pages:site.pages.map(page=>updates.has(page.id)?{...page,...updates.get(page.id),revision:page.revision+1}:page)};};
        const renderMenu=(focus?:string)=>{
          menu.replaceChildren();const members=site.pages.filter(included).sort((a,b)=>websiteMenuOrder(a,footer)-websiteMenuOrder(b,footer)||a.id.localeCompare(b.id,'en'));
          const parent=(page:WebsitePage)=>{const id=websiteMenuParent(page,footer);return members.some(member=>member.id===id)?id:undefined;};
          const roots=members.filter(page=>!parent(page));
          const control=(label:string,focusId:string,action:()=>void)=>{const b=button(label,async()=>{action();renderMenu(focusId);});b.dataset.menuFocus=focusId;return b;};
          const list=element('ol');list.className='website-navigation-list';list.setAttribute('aria-label',footer?'Footer navigation items':'Top navigation items');
          const movePage=(id:string,parentId:string|undefined,beforeId?:string)=>{
            const page=members.find(page=>page.id===id);if(!page||id===parentId||id===beforeId)return;
            const ordered=members.filter(page=>page.id!==id),siblings=ordered.filter(page=>parent(page)===parentId);
            const before=beforeId?ordered.findIndex(page=>page.id===beforeId):-1,last=siblings[siblings.length-1];
            const index=before>=0?before:last?ordered.findIndex(page=>page.id===last.id)+1:ordered.length;ordered.splice(index,0,page);
            const updates=new Map<string,Partial<WebsitePage>>(ordered.map((page,index)=>[page.id,{[orderKey]:index}]));updates.set(id,{...updates.get(id),[parentKey]:parentId??null});
            const children=members.filter(child=>parent(child)===id);if(parentId)for(const child of children)updates.set(child.id,{...updates.get(child.id),[parentKey]:null});
            change(updates);status.textContent=`${page.title} moved ${parentId?'under '+members.find(page=>page.id===parentId)!.title:'to the top level'}.${parentId&&children.length?' Its former submenu links are now top-level items.':''} Save this menu to keep the change.`;
          };
          const dropZone=(parentId?:string,beforeId?:string)=>{
            const slot=element('li'),zone=element('div',parentId?`Drop here under ${members.find(page=>page.id===parentId)!.title}`:'Drop here at top level');slot.className='website-navigation-drop-slot';slot.setAttribute('role','presentation');zone.className='website-navigation-drop-zone';zone.dataset.parentId=parentId??'';zone.dataset.beforeId=beforeId??'';zone.setAttribute('role','group');zone.setAttribute('aria-label',zone.textContent!);slot.append(zone);
            const allowed=()=>!!draggedPageId&&draggedPageId!==parentId&&draggedPageId!==beforeId;
            zone.ondragover=event=>{if(!allowed())return;event.preventDefault();event.stopPropagation();if(event.dataTransfer)event.dataTransfer.dropEffect='move';zone.dataset.active='true';};
            zone.ondragleave=()=>delete zone.dataset.active;
            zone.ondrop=event=>{event.preventDefault();event.stopPropagation();if(!allowed())return;const id=draggedPageId!;draggedPageId=undefined;delete menu.dataset.dragging;movePage(id,parentId,beforeId);renderMenu(id+'drag');};return slot;
          };
          const row=(page:WebsitePage,siblings:WebsitePage[])=>{
            const item=element('li'),card=element('div'),title=element('strong',page.navigationLabel??page.title),actions=element('div');card.className='website-navigation-item';actions.className='website-navigation-actions';
            const heading=element('div'),handle=element('button','⠿');heading.className='website-navigation-item-heading';handle.type='button';handle.className='website-navigation-drag-handle';handle.draggable=true;handle.setAttribute('aria-label',`Drag ${page.title} to reorder`);handle.dataset.menuFocus=page.id+'drag';handle.title='Drag to reorder; arrow buttons are also available';
            handle.ondragstart=event=>{draggedPageId=page.id;event.dataTransfer?.setData('application/x-website-menu-page',page.id);if(event.dataTransfer)event.dataTransfer.effectAllowed='move';menu.dataset.dragging='true';card.dataset.dragging='true';};
            handle.ondragend=()=>{draggedPageId=undefined;delete menu.dataset.dragging;delete card.dataset.dragging;for(const zone of menu.querySelectorAll<HTMLElement>('[data-active]'))delete zone.dataset.active;};heading.append(handle,title);card.append(heading);if(page.state!=='ready')card.append(element('small',`${page.state==='draft'?'Draft':'Archived'} · visible after the page is ready`));
            const at=siblings.findIndex(sibling=>sibling.id===page.id);
            for(const [direction,offset] of [['up',-1],['down',1]] as const){const move=control(direction==='up'?'↑':'↓',page.id+direction,()=>{const other=siblings[at+offset],ordered=[...members],a=ordered.findIndex(p=>p.id===page.id),b=ordered.findIndex(p=>p.id===other.id);[ordered[a],ordered[b]]=[ordered[b],ordered[a]];change(new Map(ordered.map((p,index)=>[p.id,{[orderKey]:index}])));});move.setAttribute('aria-label',`Move ${page.title} ${direction}`);move.disabled=at+offset<0||at+offset>=siblings.length;actions.append(move);}
            const currentParent=parent(page),rootIndex=roots.findIndex(root=>root.id===page.id),previous=roots[rootIndex-1];
            const level=control(currentParent?'←':'→',page.id+'level',()=>{if(currentParent){const parentIndex=roots.findIndex(root=>root.id===currentParent);movePage(page.id,undefined,roots[parentIndex+1]?.id);}else if(previous)movePage(page.id,previous.id);});
            level.setAttribute('aria-label',currentParent?`Move ${page.title} to top level`:`Nest ${page.title} under the previous page`);level.disabled=!currentParent&&!previous;actions.append(level);
            const remove=control('Remove',page.id+'remove',()=>{const updates=new Map<string,Partial<WebsitePage>>([[page.id,{[key]:false}]]);for(const child of members.filter(child=>parent(child)===page.id))updates.set(child.id,{[parentKey]:null});change(updates);status.textContent=`${page.title} removed from this menu. The page is still available.`;});remove.setAttribute('aria-label',`Remove ${page.title} from navigation`);heading.append(actions,remove);item.append(card);
            const children=members.filter(child=>parent(child)===page.id);if(!parent(page)){const nested=element('ol');nested.className='website-navigation-submenu';for(const child of children)nested.append(dropZone(page.id,child.id),row(child,children));nested.append(dropZone(page.id));item.append(nested);}return item;
          };
          for(const page of roots)list.append(dropZone(undefined,page.id),row(page,roots));list.append(dropZone());menu.append(list);if(!members.length)menu.append(element('p','No pages in this menu yet.'));
          const available=site.pages.filter(page=>!included(page)&&page.state!=='archived'),addBox=element('div');addBox.className='website-navigation-add';
          const label=element('label','Add a page to this menu'),select=element('select');select.setAttribute('aria-label','Page to add to navigation');const placeholder=element('option',available.length?'Choose a page…':'All available pages are in this menu');placeholder.value='';select.append(placeholder);for(const page of available){const option=element('option',page.title);option.value=page.id;select.append(option);}label.append(select);const add=control('Add to navigation','add',()=>{if(!select.value)return;const page=site.pages.find(p=>p.id===select.value)!;change(new Map([[page.id,{[key]:true,[parentKey]:null,[orderKey]:Math.max(-1,...members.map(p=>websiteMenuOrder(p,footer)))+1}]]));status.textContent=`${page.title} added to this menu. Save this menu to keep the change.`;});add.disabled=true;select.disabled=!available.length;select.onchange=()=>add.disabled=!select.value;addBox.append(label,add);menu.append(addBox);
          if(focus){const target=[...menu.querySelectorAll<HTMLElement>('[data-menu-focus]')].find(control=>control.dataset.menuFocus===focus&&!control.hasAttribute('disabled'))??select;const details=target.closest('details');if(details)details.open=true;target.focus();}
        };renderMenu();
      }
      surface.append(button('Save '+selectedLayout.toLowerCase(),save));
    }
    if(tab==='Galleries') {
      content.append(element('p','Named galleries are publishing destinations. Display any gallery in a gallery block on any page. Galleries support Works or sub-galleries, with two levels. Website content is free or preview-only; paid access stays with your membership platform.'));
      const hostingTargets=(await client.hostingHistory?.())?.targets??[];
      if(disposed||renderGeneration!==generation)return;
      const workspace=element('div'),selector=element('nav'),divider=element('div'),surface=element('div');
      workspace.className='website-page-workspace website-gallery-workspace'+(gallerySelectorExpanded?'':' website-pages-collapsed');selector.className='website-page-selector website-gallery-selector';selector.id='website-galleries-'+site.id;selector.setAttribute('aria-label','Gallery selector');selector.hidden=!gallerySelectorExpanded;surface.className='website-page-surface website-gallery-detail';
      divider.className='website-page-divider';const handle=element('div');handle.className='website-page-handle-viewport';const toggle=button('',async()=>{gallerySelectorExpanded=!gallerySelectorExpanded;workspace.classList.toggle('website-pages-collapsed',!gallerySelectorExpanded);selector.hidden=!gallerySelectorExpanded;updateToggle();measurePages();});toggle.className='website-page-toggle';toggle.setAttribute('aria-controls',selector.id);
      const updateToggle=()=>{toggle.setAttribute('aria-label',gallerySelectorExpanded?'Collapse gallery selector':'Expand gallery selector');toggle.setAttribute('aria-expanded',String(gallerySelectorExpanded));toggle.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="'+(gallerySelectorExpanded?'m15 18-6-6 6-6':'m9 18 6-6-6-6')+'"/></svg>';};updateToggle();handle.append(toggle);divider.append(handle);workspace.append(selector,divider,surface);content.append(workspace);
      let refreshGalleryLists=()=>{};
      const update=(id:string,patch:Partial<NonNullable<Website['namedGalleries']>[number]>)=>{site={...site,namedGalleries:(site.namedGalleries??[]).map(row=>row.id===id?{...row,...patch}:row)};reportDirty();refreshGalleryLists();};
      const parentFilterLabel=element('label','Main gallery'),parentFilter=element('select');parentFilterLabel.append(parentFilter);selector.append(parentFilterLabel);
      const searchLabel=element('label','Find a gallery'),search=element('input');search.type='search';search.placeholder='Filter by name or path';search.value=galleryQuery;searchLabel.append(search);selector.append(searchLabel);
      const clear=button('Clear filter',async()=>{galleryQuery='';search.value='';refreshGalleryLists();search.focus();});clear.className='website-gallery-filter-clear';selector.append(clear);
      const count=element('p');count.className='small';count.setAttribute('role','status');count.setAttribute('aria-live','polite');selector.append(count);
      const list=element('div');list.className='website-gallery-choices';selector.append(list);const empty=element('p','No galleries match this filter.');selector.append(empty);
      const galleryRows=new Map<string,{card:HTMLElement;before:HTMLElement;after:HTMLElement;choice:HTMLButtonElement;grip:HTMLButtonElement;up:HTMLButtonElement;down:HTMLButtonElement;box:HTMLElement;title:HTMLElement;meta:HTMLElement;heading:HTMLElement;context:HTMLElement}>();
      let draggedGallery:string|undefined;
      const dragScroll=attachWebsiteDragScroll(selector,()=>!disposed&&Boolean(draggedGallery));cleanupLinks.push(dragScroll.destroy);
      const reorder=(id:string,target:string,placement:'before'|'after')=>{const next=moveWebsiteGallery(site,id,target,placement);if(next===site)return;site=next;reportDirty();refreshGalleryLists();status.textContent='Gallery order changed. Save galleries to keep this order.';};
      const selectGallery=(id:string)=>{selectedGallery=id;refreshGalleryLists();};
      search.oninput=()=>{galleryQuery=search.value;refreshGalleryLists();};parentFilter.onchange=()=>{galleryParentFilter=parentFilter.value;if(galleryParentFilter)selectedGallery=site.namedGalleries?.find(row=>row.parentId===galleryParentFilter)?.id??galleryParentFilter;refreshGalleryLists();};
      for(const gallery of site.namedGalleries??[]){
        const choice=button('',async()=>selectGallery(gallery.id));choice.className='website-page-choice website-gallery-choice';
        const title=element('strong',gallery.title),meta=element('small');choice.append(title,meta);
        const card=element('div'),actions=element('div'),grip=element('button','⠿');card.className='website-gallery-card';card.dataset.galleryId=gallery.id;card.draggable=true;actions.className='website-gallery-order-actions';grip.type='button';grip.className='website-navigation-drag-handle';grip.setAttribute('aria-label','Drag '+gallery.title+' to reorder');grip.title='Drag to reorder; use arrow buttons or arrow keys to move';grip.draggable=true;
        const move=(direction:-1|1)=>{const current=site.namedGalleries!.find(g=>g.id===gallery.id)!;const siblings=site.namedGalleries!.filter(g=>(g.parentId??'')===(current.parentId??''));const target=siblings[siblings.findIndex(g=>g.id===gallery.id)+direction];if(target){reorder(gallery.id,target.id,direction<0?'before':'after');grip.focus();}};
        const up=button('↑',async()=>move(-1)),down=button('↓',async()=>move(1));up.setAttribute('aria-label','Move '+gallery.title+' up');down.setAttribute('aria-label','Move '+gallery.title+' down');
        grip.onkeydown=event=>{if(event.key==='ArrowUp'||event.key==='ArrowDown'){event.preventDefault();move(event.key==='ArrowUp'?-1:1);grip.focus();}};
        const clearDrag=()=>{dragScroll.stop();draggedGallery=undefined;for(const row of galleryRows.values()){delete row.card.dataset.dragging;delete row.card.dataset.drop;delete row.before.dataset.active;delete row.after.dataset.active;}};
        card.ondragstart=event=>{draggedGallery=gallery.id;card.dataset.dragging='true';event.dataTransfer?.setData('application/x-website-gallery',gallery.id);if(event.dataTransfer)event.dataTransfer.effectAllowed='move';};card.ondragend=clearDrag;
        card.ondragover=event=>{const source=site.namedGalleries?.find(g=>g.id===draggedGallery),target=site.namedGalleries?.find(g=>g.id===gallery.id);if(!source||!target||source.id===target.id||(source.parentId??'')!==(target.parentId??''))return;event.preventDefault();if(event.dataTransfer)event.dataTransfer.dropEffect='move';card.dataset.drop=event.clientY<card.getBoundingClientRect().top+card.clientHeight/2?'before':'after';};
        card.ondragleave=event=>{if(!(event.relatedTarget instanceof Node)||!card.contains(event.relatedTarget))delete card.dataset.drop;};
        card.ondrop=event=>{event.preventDefault();const id=draggedGallery,placement=card.dataset.drop;clearDrag();if(id&&(placement==='before'||placement==='after'))reorder(id,gallery.id,placement);};
        const dropZone=(placement:'before'|'after')=>{const zone=element('div');zone.className='website-gallery-drop-zone website-navigation-drop-zone';zone.setAttribute('role','group');zone.setAttribute('aria-label',(placement==='before'?'Move before ':'Move after ')+gallery.title);zone.textContent='Drop gallery here';
          zone.ondragover=event=>{const source=site.namedGalleries?.find(g=>g.id===draggedGallery),target=site.namedGalleries?.find(g=>g.id===gallery.id);if(!source||!target||source.id===target.id||(source.parentId??'')!==(target.parentId??''))return;event.preventDefault();if(event.dataTransfer)event.dataTransfer.dropEffect='move';zone.dataset.active='true';};zone.ondragleave=()=>delete zone.dataset.active;zone.ondrop=event=>{event.preventDefault();const id=draggedGallery,active=zone.dataset.active==='true';clearDrag();if(id&&active)reorder(id,gallery.id,placement);};return zone;};
        const before=dropZone('before'),after=dropZone('after');actions.append(up,down);card.append(grip,choice,actions);list.append(before,card,after);
        const box=element('section');box.className='website-gallery-settings';box.id='website-gallery-panel-'+gallery.id;box.setAttribute('aria-label','Settings for '+gallery.title);choice.setAttribute('aria-controls',box.id);surface.append(box);
        const heading=element('h3',gallery.title),context=element('p');context.className='small';box.append(heading,context);
        galleryRows.set(gallery.id,{card,before,after,choice,grip,up,down,box,title,meta,heading,context});
        field(box,'Gallery name',gallery.title,title=>update(gallery.id,{title}));field(box,'Path segment',gallery.slug,slug=>update(gallery.id,{slug}));box.append(element('small','Changing a published path creates a redirect when you next publish.'));
        const parentLabel=element('label','Parent gallery'),parent=element('select');parent.append(element('option','Top level'));parent.options[0].value='';
        for(const candidate of site.namedGalleries??[])if(candidate.id!==gallery.id&&!candidate.parentId&&candidate.kind==='galleries'){const option=element('option',candidate.title);option.value=candidate.id;parent.append(option);}parent.value=gallery.parentId??'';parent.onchange=()=>update(gallery.id,{parentId:parent.value||undefined});parentLabel.append(parent);box.append(parentLabel);
        const kindLabel=element('label','Contents'),kind=element('select');for(const [value,title]of [['works','Works'],['galleries','Sub-galleries']]){const option=element('option',title);option.value=value;kind.append(option);}kind.value=gallery.kind;kind.disabled=!!gallery.parentId;kind.onchange=()=>update(gallery.id,{kind:kind.value as 'works'|'galleries'});kindLabel.append(kind);box.append(kindLabel);
        const accessLabel=element('label','Public access'),access=element('select');for(const [value,title]of [['free','Free gallery'],['preview','Previews only']]){const option=element('option',title);option.value=value;access.append(option);}access.value=gallery.access;access.onchange=()=>update(gallery.id,{access:access.value as 'free'|'preview'});accessLabel.append(access);box.append(accessLabel);
        if(gallery.kind==='works'){
          for(const [linksKey,textKey,heading,defaultText] of [['purchaseLinks','purchaseText','Purchase Links','Want more?'],['externalLinks','externalLinksText','Additional Platform Links','Also available on:']] as const){
            const group=element('details');group.className='website-gallery-link-editor';group.append(element('summary',heading),element('p',linksKey==='purchaseLinks'?'Link to purchase or subscription pages. Choose a known published destination or add a link manually.':'Link to other places visitors can find this gallery. Choose a known published destination or add a link manually.'));box.append(group);
            field(group,heading+' heading',gallery[textKey]??defaultText,value=>update(gallery.id,{[textKey]:value||undefined}));
            const links=element('div');links.dataset.galleryLinkEditor=gallery.id+':'+linksKey;group.append(links);
            if(mountLinks){cleanupLinks.push(mountLinks(links,{heading,saveSuggestionUrl:client.saveGalleryLink?(id,url,expectedUrl)=>client.saveGalleryLink!(gallery.id,id,url,expectedUrl):undefined,loadSuggestions:client.galleryLinkSuggestions?()=>client.galleryLinkSuggestions!(gallery.id):undefined,purchase:linksKey==='purchaseLinks',value:[...gallery[linksKey]??[]],onChange:value=>update(gallery.id,{[linksKey]:value})}));}
            else {
              const renderLinks=()=>{links.replaceChildren();const current=site.namedGalleries!.find(row=>row.id===gallery.id)!;
                for(const [index,item]of (current[linksKey]??[]).entries()){
                  const row=element('fieldset');row.append(element('legend',`Link ${index+1}`));
                  const patch=(values:{label?:string;url?:string;priceText?:string})=>{const latest=site.namedGalleries!.find(g=>g.id===gallery.id)![linksKey]??[];update(gallery.id,{[linksKey]:latest.map((link,i)=>i===index?{...link,...values}:link)});};
                  field(row,'Link label',item.label,value=>patch({label:value}));field(row,'URL',item.url,value=>patch({url:value}));
                  if(linksKey==='purchaseLinks')field(row,'Price or detail text (optional)','priceText' in item?String(item.priceText??''):'',value=>patch({priceText:value||undefined}));
                  row.append(button('Remove link',async()=>{const latest=site.namedGalleries!.find(g=>g.id===gallery.id)![linksKey]??[];update(gallery.id,{[linksKey]:latest.filter((_,i)=>i!==index)});renderLinks();}));links.append(row);
                }
              };renderLinks();group.append(button('Add link',async()=>{const current=site.namedGalleries!.find(row=>row.id===gallery.id)!;if((current[linksKey]?.length??0)>=10)throw Error('Use up to 10 links in each group.');update(gallery.id,{[linksKey]:[...current[linksKey]??[],{label:'',url:''}]});renderLinks();}));
            }
          }
          const targetLabel=element('label','Publishing destination'),target=element('select');target.append(element('option',hostingTargets.length===1?'Use the website’s only publishing destination':'Choose a publishing destination…'));target.options[0].value='';for(const host of hostingTargets){const option=element('option',host.label);option.value=host.id;target.append(option);}target.value=gallery.hostingTargetId??'';target.onchange=()=>update(gallery.id,{hostingTargetId:target.value||undefined});targetLabel.append(target);box.append(targetLabel);
          box.append(element('p','Choose this website gallery in Works or Collections → Publishing destinations, then use Review and publish. A Work can appear in multiple galleries.'));
          if(mountWorks){const host=element('div');box.append(host);cleanupLinks.push(mountWorks(host,{website:site,galleryId:gallery.id,reviewBlocked:()=>dirty()?'Save website changes before reviewing Works.':undefined}));}

        }
        if(gallery.kind==='galleries')box.append(button('Browse sub-galleries',async()=>{galleryParentFilter=gallery.id;galleryQuery='';search.value='';refreshGalleryLists();const first=site.namedGalleries?.find(row=>row.parentId===gallery.id);if(first)selectGallery(first.id);}));
        box.append(button('Remove gallery',async()=>{await confirmAction('Remove '+gallery.title+'?','This removes the gallery and its sub-galleries from this website. The original Works remain. This removal cannot be undone. Blocks displaying a removed gallery will need another gallery selected.','Remove gallery',async()=>{const removed=new Set([gallery.id,...(site.namedGalleries??[]).filter(row=>row.parentId===gallery.id).map(row=>row.id)]);const named=site.namedGalleries?.filter(row=>!removed.has(row.id));const retained=site.galleryPublicationIds.filter(id=>!id.startsWith('website-work-')||named?.some(g=>g.publicationIds.includes(id)));site={...site,namedGalleries:named,galleryPublicationIds:retained,gallerySettings:site.gallerySettings?.filter(setting=>retained.includes(setting.publicationId))};await save();await show('Galleries');});}));
      }
      const add=element('fieldset');add.className='website-named-gallery-new';add.append(element('legend','New gallery'));let title='',kind:'works'|'galleries'='works',newParent=galleryParentFilter;field(add,'Gallery name','',value=>title=value);prepareDraft=()=>{if(selectedGallery==='new'&&title)throw new Error('Add the new gallery before previewing your changes.');};const select=element('select');select.setAttribute('aria-label','New gallery contents');for(const [value,label]of [['works','Works'],['galleries','Sub-galleries']]){const option=element('option',label);option.value=value;select.append(option);}select.onchange=()=>kind=select.value as typeof kind;add.append(select);const newParentLabel=element('label','Main gallery'),newParentSelect=element('select');newParentSelect.append(element('option','Top level'));newParentSelect.options[0].value='';for(const gallery of site.namedGalleries??[])if(!gallery.parentId&&gallery.kind==='galleries'){const option=element('option',gallery.title);option.value=gallery.id;newParentSelect.append(option);}newParentSelect.value=newParent;newParentSelect.onchange=()=>{newParent=newParentSelect.value;if(newParent){kind='works';select.value='works';}select.disabled=!!newParent;};select.disabled=!!newParent;newParentLabel.append(newParentSelect);add.append(newParentLabel);
      add.append(button('Add gallery',async()=>{if(!title.trim())throw Error('Add a gallery name.');const base=title.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,60)||'gallery';let slug=base,n=2;while(site.namedGalleries?.some(row=>(row.parentId??'')===newParent&&row.slug===slug))slug=base+'-'+n++;selectedGallery=crypto.randomUUID();site={...site,namedGalleries:[...site.namedGalleries??[],{id:selectedGallery,title:title.trim(),slug,kind,parentId:newParent||undefined,access:'free',publicationIds:[]}]};await save();await show('Galleries');}));surface.append(add);
      const newChoice=button('+ New gallery',async()=>{if(!title){newParent=galleryParentFilter;newParentSelect.value=newParent;select.disabled=!!newParent;if(newParent){kind='works';select.value='works';}}selectGallery('new');});newChoice.className='website-selector-action website-selector-action-secondary';selector.append(newChoice);
      const saveGalleries=button('Save galleries',async()=>{saveGalleries.disabled=true;try{await save();await show('Galleries');}finally{saveGalleries.disabled=false;}});saveGalleries.className='website-gallery-save';surface.append(saveGalleries);
      refreshGalleryLists=()=>{
        const galleries=site.namedGalleries??[],parents=galleries.filter(gallery=>!gallery.parentId&&gallery.kind==='galleries');
        if(!parents.some(gallery=>gallery.id===galleryParentFilter))galleryParentFilter='';
        const all=element('option','All galleries');all.value='';parentFilter.replaceChildren(all);for(const gallery of parents){const option=element('option',gallery.title);option.value=gallery.id;parentFilter.append(option);}parentFilter.value=galleryParentFilter;
        const members=galleries.filter(gallery=>!galleryParentFilter||gallery.id===galleryParentFilter||gallery.parentId===galleryParentFilter);
        const query=galleryQuery.trim().toLocaleLowerCase();let matches=0;
        if(selectedGallery!=='new'&&!galleryRows.has(selectedGallery))selectedGallery=members.find(gallery=>gallery.kind==='works')?.id??members[0]?.id??'new';
        const ordered=galleries.filter(g=>!g.parentId).flatMap(g=>[g,...galleries.filter(child=>child.parentId===g.id)]);
        for(const gallery of ordered){const row=galleryRows.get(gallery.id)!;const parent=galleries.find(item=>item.id===gallery.parentId);list.append(row.before,row.card,row.after);const siblings=galleries.filter(g=>(g.parentId??'')===(gallery.parentId??'')),at=siblings.findIndex(g=>g.id===gallery.id);row.up.disabled=at===0;row.down.disabled=at===siblings.length-1;
          row.grip.setAttribute('aria-label','Drag '+gallery.title+' to reorder');row.up.setAttribute('aria-label','Move '+gallery.title+' up');row.down.setAttribute('aria-label','Move '+gallery.title+' down');row.title.textContent=gallery.title;row.heading.textContent=gallery.title;row.box.setAttribute('aria-label','Settings for '+gallery.title);
          row.meta.textContent=gallery.kind==='galleries'?`${galleries.filter(child=>child.parentId===gallery.id).length} sub-galleries`:`${gallery.access==='preview'?'Previews only':'Free gallery'} · ${gallery.publicationIds.length} items`;
          row.context.textContent=parent?'Main gallery: '+parent.title:gallery.kind==='galleries'?'Main gallery':'Top-level gallery';
          const match=members.includes(gallery)&&(!query||[gallery.title,gallery.slug,parent?.title??''].some(value=>value.toLocaleLowerCase().includes(query)));
          row.card.dataset.subgallery=String(Boolean(gallery.parentId));row.card.hidden=!match;row.before.hidden=!match||at!==0;row.after.hidden=!match;if(match)matches++;row.choice.setAttribute('aria-pressed',String(gallery.id===selectedGallery));row.box.hidden=gallery.id!==selectedGallery;
        }
        clear.hidden=!galleryQuery;count.textContent=`${matches} of ${members.length} galleries`;empty.hidden=matches>0;
        empty.textContent=galleries.length?'No galleries match this filter.':'No galleries yet. Create your first gallery below.';
        add.hidden=selectedGallery!=='new';saveGalleries.hidden=selectedGallery==='new';newChoice.setAttribute('aria-pressed',String(selectedGallery==='new'));measurePages();
      };
      refreshGalleryLists();
    }
    if(tab==='Appearance') {
      const catalogue=client.catalogue?await client.catalogue():undefined;if(disposed||renderGeneration!==generation)return;
      const availableModes=options.destinationModes??['local','manual','connected'];
      const destinationPicker=(parent:HTMLElement,label:string,value:WebsiteDestination|undefined,choices:readonly WebsiteCatalogueOption[],change:(v:WebsiteDestination|undefined)=>void,inherit=false)=>{
        const box=element('fieldset');box.className='website-gallery-destination';box.append(element('legend',label));const mode=element('select');mode.setAttribute('aria-label',label);
        for(const id of [...(inherit?['inherit']:[]),...availableModes]){const option=element('option',({inherit:'Use gallery default',local:'Website gallery',manual:'Custom public link',connected:'Connected publication'} as Record<string,string>)[id]);option.value=id;mode.append(option);}mode.value=value?.mode??'inherit';box.append(mode);
        let manual=value?.mode==='manual'?value.url:'';
        const url=field(box,'Public URL',manual,v=>{manual=v;update();});
        const connection=element('select');connection.setAttribute('aria-label',label+' connection');const empty=element('option','Choose a connected destination');empty.value='';connection.append(empty);
        const destinations=new Map<string,Extract<WebsiteDestination,{mode:'connected'}>>();
        for(const row of choices)if(row.destination){const key=JSON.stringify(row.destination);if(destinations.has(key))continue;destinations.set(key,row.destination);const option=element('option',row.destinationLabel??row.title);option.value=key;connection.append(option);}
        if(value?.mode==='connected'){const key=JSON.stringify(value);if(!destinations.has(key)){destinations.set(key,value);const option=element('option','Saved connection (not currently available)');option.value=key;connection.append(option);}connection.value=key;}
        box.append(connection);parent.append(box);
        const visible=()=>{url.parentElement!.hidden=mode.value!=='manual';connection.hidden=mode.value!=='connected';};
        const update=()=>{visible();change(mode.value==='inherit'?undefined:mode.value==='local'?{mode:'local'}:mode.value==='manual'?{mode:'manual',url:manual}:destinations.get(connection.value)??{mode:'connected',destinationId:'',accountId:''});};mode.onchange=update;connection.onchange=update;visible();
      };
      destinationPicker(content,'Default card click behavior',site.galleryDefault.destination,catalogue??[],destination=>{if(destination)site={...site,galleryDefault:{destination,missing:'error'}};});
      content.append(button('Save card default',save));
    }
    if(tab==='Publishing'&&options.exportEnabled!==false) {
      const exportPanel=element('details');exportPanel.className='website-publishing-export';exportPanel.append(element('summary','Download website ZIP'));content.append(exportPanel);
      exportPanel.append(element('p','Each build preserves a saved website version. Rebuild after changing pages or Works.'));
      if(client.builds) {
        const builds=await client.builds(),select=element('select');select.setAttribute('aria-label','Saved website build');select.append(element('option','Choose a build'));
        for(const build of builds){const option=element('option',`Revision ${build.websiteRevision} — ${build.state}`);option.value=build.id;select.append(option);}select.value=currentBuild??'';select.onchange=()=>{currentBuild=select.value||undefined;};exportPanel.append(select);
      }
      exportPanel.append(button('Build website',async()=>{const b=await client.requestBuild(site.revision,globalThis.crypto.randomUUID());currentBuild=b.id;status.textContent=b.state==='ready'?'Website build ready. Preview it or download the ZIP.':b.state==='failed'?'Website build failed. Refresh the status for details.':`Website build ${b.state}. Refresh the status to follow its progress.`;}));
      exportPanel.append(button('Refresh build status',async()=>{if(!currentBuild)throw new Error('Build a candidate first.');const b=await client.build(currentBuild);status.textContent=`Build ${b.state}${b.stale?' — newer or restricted sources exist':''}. ${b.errorCode??''} ${b.warnings.join(' ')}`;}));
      if(tab==='Publishing') exportPanel.append(button('Download exact candidate ZIP',async()=>{if(!currentBuild)throw new Error('Build a candidate first.');if(client.download)await client.download(currentBuild);else{const blob=await client.export(currentBuild),url=URL.createObjectURL(blob),a=element('a','Download website ZIP');a.href=url;a.download='website.zip';content.append(a);a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);}status.textContent='Exported. Upload the files to your hosting provider to publish.';}));

    }
    reportDirty();
    if(!disposed&&root.isConnected){root.scrollIntoView?.({block:'start'});measurePages();}
  };
  for(const tab of ['Settings','Pages','Layout','Appearance','Galleries','Preview',...(options.exportEnabled===false&&!client.hostingChoices?[]:['Publishing'])]){const choice=tab==='Preview'?previewButton('Preview',()=>site.homePageId):button(tab,async()=>{if(!disposed)await show(tab);});choice.dataset.websiteTool=tab;tabs.append(choice);}
  const measureTools=()=>{if(win){const height=win.getComputedStyle(tabs).position==='sticky'?tabs.getBoundingClientRect().height:0;root.style.setProperty('--website-tools-height',`${height}px`);scheduleMeasure();}};
  const toolsObserver=typeof ResizeObserver==='undefined'?undefined:new ResizeObserver(measureTools);toolsObserver?.observe(tabs);measureTools();
  const ready=client.get().then(async value=>{if(!disposed){site=value;savedSite=JSON.stringify(value);notifyWebsitePreviewSaved(value);if(win)registerPreviewProvider(value,win.location.href,client);await show(options.initialTab??'Pages');}}).catch(error=>{status.textContent=String(error);});
  return {ready,destroy(){disposed=true;toolsObserver?.disconnect();root.style.removeProperty('--website-tools-height');root.removeEventListener('input',scheduleDirty);root.removeEventListener('change',scheduleDirty);stopPublishingPoll();for(const close of dialogs.values())close();dialogs.clear();win?.removeEventListener('resize',scheduleMeasure);win?.removeEventListener('scroll',scheduleMeasure,true);if(measureFrame)win?.cancelAnimationFrame(measureFrame);for(const observer of imageObservers)observer.disconnect();cleanupEditor?.();cleanupSettings?.();for(const cleanup of cleanupLinks.splice(0))cleanup();root.replaceChildren();}};
};
