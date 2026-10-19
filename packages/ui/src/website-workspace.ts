import { WEBSITE_THEMES, WEBSITE_PAGE_TEMPLATES, websiteRoutes, type EntityId, type Website, type WebsiteDocument } from '@ubeeq/core';
export interface WebsiteMediaOption {id:string;title:string;source?:string;}

export interface WebsiteWorkspaceClient {
  pendingUploads?():boolean;
  media?(query?:string):Promise<readonly WebsiteMediaOption[]>;
  uploadMedia?(file:File):Promise<WebsiteMediaOption>;
  mediaPreview?(id:string):Promise<string>;
  creators?():Promise<readonly {id:string;title:string}[]>;
  catalogue?(): Promise<readonly {id:string;title:string}[]>;
  get(): Promise<Website>;
  save(website: Website, expectedRevision: number): Promise<Website>;
  document(id: string): Promise<{ document: WebsiteDocument; sharedBy: readonly { title: string }[] }>;
  saveDocument(document: WebsiteDocument, expectedRevision: number): Promise<WebsiteDocument>;
  requestBuild(revision: number, key: string): Promise<{ id: string; state: string }>;
  builds?(): Promise<readonly {id:string;state:string;websiteRevision:number}[]>;
  previewPages?(id:string): Promise<readonly string[]>;
  build(id: string): Promise<{ id: string; state: string; errorCode?: string; warnings: readonly string[]; stale?: boolean }>;
  export(id: string): Promise<Blob>;
  /** Product downloads may use a short-lived private storage URL to avoid gateway response limits. */
  download?(id: string): Promise<void>;
  /** Returns an authorized generated HTML document. The iframe is always sandboxed. */
  preview(id: string,file?:string): Promise<string>;
}
export interface WebsiteWorkspaceOptions { exportEnabled?:boolean; destinationModes?: readonly ('local'|'manual'|'connected')[]; showAssetIds?: boolean; }
/** Shared editor injection keeps the authoritative block format and existing editor. */
export const createWebsiteWorkspace = (root: HTMLElement, client: WebsiteWorkspaceClient, mountEditor: (host: HTMLElement, document: WebsiteDocument, onChange: (document: WebsiteDocument) => void) => (() => void), options: WebsiteWorkspaceOptions = {}) => {
  const d=root.ownerDocument;
  let site: Website, disposed=false, cleanupEditor: (()=>void)|undefined, currentBuild:string|undefined,selectedPage:string|undefined,pageSelectorExpanded=true,renderGeneration=0;
  const documentDrafts=new Map<string,WebsiteDocument>();
  let selectedLayout='Header',layoutSelectorExpanded=true,previewPending=false;
  const element=<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string) => {const el=d.createElement(tag);if(text)el.textContent=text;return el;};
  const status=element('p'); status.setAttribute('role','status');
  const tabs=element('nav'), content=element('section'); tabs.setAttribute('aria-label','Website tools'); root.replaceChildren(tabs,status,content);
  const act=(fn:()=>Promise<void>)=>async()=>{try{await fn();}catch(error){status.textContent=error instanceof Error?error.message:'Website operation failed.';}};
  const button=(label:string,fn:()=>Promise<void>)=>{const b=element('button',label);b.type='button';b.onclick=act(fn);return b;};
  const field=(parent:HTMLElement,label:string,value:string,change:(v:string)=>void)=>{const l=element('label',label),i=element('input');i.value=value;i.onchange=()=>change(i.value);l.append(i);parent.append(l);return i;};
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
  const save=async()=>{if(uploads||client.pendingUploads?.())throw new Error('Wait for image uploads to finish before saving.');const expected=site.revision;site=await client.save({...site,revision:expected+1},expected);status.textContent=`Website revision ${site.revision} saved. Build a new candidate to update the export.`;};
  const win=d.defaultView;let measureFrame=0;
  const measurePages=()=>{const selector=root.querySelector<HTMLElement>('.website-page-selector');if(!selector||selector.hidden||!win)return;const top=Math.max(0,selector.getBoundingClientRect().top);selector.style.setProperty('--website-selector-height',`${Math.max(160,win.innerHeight-top-24)}px`);const first=selector.querySelector<HTMLElement>('button');if(first)selector.parentElement?.style.setProperty('--website-selector-first-center',`${first.offsetTop+first.offsetHeight/2}px`);};
  const scheduleMeasure=()=>{if(win&&!measureFrame)measureFrame=win.requestAnimationFrame(()=>{measureFrame=0;measurePages();});};win?.addEventListener('resize',scheduleMeasure);win?.addEventListener('scroll',scheduleMeasure,true);
  const previewPage=async(pageId:string)=>{
    if(previewPending)throw new Error('A page preview is already opening.');
    const popup=win?.open('about:blank','_blank');
    if(!popup)throw new Error('Allow pop-ups to open this preview in a new tab.');
    popup.opener=null;popup.document.title='Opening page preview';popup.document.body.textContent='Preparing the saved page preview…';previewPending=true;
    try {
      const saved=await client.get(),page=saved.pages.find(p=>p.id===pageId);
      if(!page||page.state!=='ready')throw new Error('Save this page as Ready before previewing it.');
      let buildId:string|undefined;
      for(const candidate of await client.builds?.()??[])if(candidate.state==='ready'&&candidate.websiteRevision===saved.revision){if(!(await client.build(candidate.id)).stale){buildId=candidate.id;break;}}
      if(!buildId){const build=await client.requestBuild(saved.revision,globalThis.crypto.randomUUID());if(build.state!=='ready')throw new Error('The website build is '+build.state+'. Check its status in Preview.');buildId=build.id;}
      currentBuild=buildId;const route=websiteRoutes(saved).get(pageId);if(!route)throw new Error('This page is unavailable in the saved website.');
      const html=await client.preview(buildId,route==='/'?'index.html':decodeURIComponent(route.slice(1))+'index.html');
      if(popup.closed)return;
      popup.document.title=page.title+' · Website preview';const frame=popup.document.createElement('iframe');frame.title=page.title+' preview';frame.setAttribute('sandbox','');frame.style.cssText='position:fixed;inset:0;width:100%;height:100%;border:0';frame.srcdoc=html;popup.document.body.replaceChildren(frame);
      status.textContent='Preview opened in a new tab using saved changes.';
    }catch(error){if(!popup.closed)popup.document.body.textContent=error instanceof Error?error.message:'Unable to open preview.';throw error;}finally{previewPending=false;}
  };
  const show=async(tab:string)=>{
    const generation=++renderGeneration;
    for(const choice of Array.from(tabs.querySelectorAll('button')))choice.setAttribute('aria-pressed',String(choice.textContent===tab));
    cleanupEditor?.();cleanupEditor=undefined;for(const observer of imageObservers)observer.disconnect();imageObservers.length=0;content.replaceChildren(element('h2',tab));
    if(tab==='Pages') {
      if(!selectedPage||!['new','redirects',...site.pages.map(p=>p.id)].includes(selectedPage))selectedPage=site.homePageId;
      const workspace=element('div'),selector=element('nav'),divider=element('div'),handle=element('div'),surface=element('div');
      workspace.className='website-page-workspace'+(pageSelectorExpanded?'':' website-pages-collapsed');selector.className='website-page-selector';selector.id='website-pages-'+site.id;selector.setAttribute('aria-label','Website pages');selector.tabIndex=0;selector.hidden=!pageSelectorExpanded;surface.className='website-page-surface';
      for(const page of [...site.pages].sort((a,b)=>a.order-b.order)){
        const choice=button(page.title,async()=>{selectedPage=page.id;await show('Pages');});choice.className='website-page-choice';choice.dataset.child=String(!!page.parentId);choice.setAttribute('aria-pressed',String(selectedPage===page.id));choice.append(element('small',page.id===site.homePageId?'Homepage':page.state==='ready'?'Ready':page.state));selector.append(choice);
      }
      selector.append(button('New page',async()=>{selectedPage='new';await show('Pages');}),button('Redirects',async()=>{selectedPage='redirects';await show('Pages');}));
      divider.className='website-page-divider';handle.className='website-page-handle-viewport';const toggle=button('',async()=>{pageSelectorExpanded=!pageSelectorExpanded;workspace.classList.toggle('website-pages-collapsed',!pageSelectorExpanded);selector.hidden=!pageSelectorExpanded;updateToggle();measurePages();});toggle.className='website-page-toggle';toggle.setAttribute('aria-controls',selector.id);
      const updateToggle=()=>{toggle.setAttribute('aria-label',pageSelectorExpanded?'Collapse page selector':'Expand page selector');toggle.setAttribute('aria-expanded',String(pageSelectorExpanded));const svg=d.createElementNS('http://www.w3.org/2000/svg','svg'),path=d.createElementNS('http://www.w3.org/2000/svg','path');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('fill','none');svg.setAttribute('stroke','currentColor');svg.setAttribute('stroke-width','2');svg.setAttribute('aria-hidden','true');path.setAttribute('d',pageSelectorExpanded?'m15 18-6-6 6-6':'m9 18 6-6-6-6');svg.append(path);toggle.replaceChildren(svg);};updateToggle();handle.append(toggle);divider.append(handle);workspace.append(selector,divider,surface);content.append(workspace);
      const active=site.pages.find(page=>page.id===selectedPage);
      if(active){const heading=element('div');heading.className='website-page-detail-heading';heading.append(element('h2',active.title),button('Preview in new tab',()=>previewPage(active.id)));surface.append(heading);}
      for(const p of site.pages.filter(page=>page.id===selectedPage)) {
        const row=element('div');row.className='website-page-settings-fields';
        const editPage=(patch:Partial<typeof p>)=>{site={...site,pages:site.pages.map(next=>next.id===p.id?{...next,...patch,revision:next.revision+1}:next)};};
        field(row,'Page title',p.title,v=>editPage({title:v}));
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
          const result=await client.document(p.documentId);if(disposed||renderGeneration!==generation)return;const editor=element('div');editor.className='website-page-content-editor';let doc=documentDrafts.get(p.documentId)??result.document;
          if(result.sharedBy.length>1)surface.append(element('p',`This content is shared by: ${result.sharedBy.map(page=>page.title).join(', ')}. Duplicate the document in Page settings to edit this page independently.`));surface.append(editor);
          const mount=()=>{cleanupEditor?.();cleanupEditor=mountEditor(editor,doc,next=>{doc=next;documentDrafts.set(doc.id,doc);});};mount();
          let saving=false;const savePage=button('Save page',async()=>{if(saving)return;if(uploads||client.pendingUploads?.())throw new Error('Wait for image uploads to finish before saving.');saving=true;savePage.disabled=true;try{if(documentDrafts.has(doc.id)){doc=await client.saveDocument({...doc,revision:doc.revision+1},doc.revision);documentDrafts.delete(doc.id);mount();}await save();status.textContent='Page content and settings saved.';await show('Pages');}finally{saving=false;savePage.disabled=false;}});surface.append(savePage);

        };
        if(p.kind!=='home') {
          field(row,'Path segment',p.slug,v=>{site={...site,pages:site.pages.map(next=>next.id===p.id?{...next,slug:v,revision:next.revision+1}:next)};});
          const label=element('label','Parent'),select=element('select');
          for(const candidate of [{id:'',title:'Top level'},...site.pages.filter(x=>x.kind!=='home'&&x.kind!=='update'&&!x.parentId&&x.id!==p.id)]) {const option=element('option',candidate.title);option.value=candidate.id;select.append(option);}
          select.value=p.parentId??'';select.onchange=()=>{site={...site,pages:site.pages.map(next=>next.id===p.id?{...next,parentId:select.value||undefined,revision:next.revision+1}:next)};};label.append(select);row.append(label);
        }
        const label=element('label','Show in top navigation'),check=element('input');check.type='checkbox';check.checked=p.navigation;check.onchange=()=>{site={...site,pages:site.pages.map(next=>next.id===p.id?{...next,navigation:check.checked,revision:next.revision+1}:next)};};label.append(check);row.append(label);
        const footerLabel=element('label','Show in footer navigation'),footerCheck=element('input');footerCheck.type='checkbox';footerCheck.checked=p.footerNavigation??p.navigation;footerCheck.onchange=()=>editPage({footerNavigation:footerCheck.checked});footerLabel.append(footerCheck);row.append(footerLabel);
        row.append(button('Move up',async()=>{const ordered=[...site.pages].sort((a,b)=>a.order-b.order);const i=ordered.findIndex(x=>x.id===p.id);if(i>0)[ordered[i],ordered[i-1]]=[ordered[i-1],ordered[i]];site={...site,pages:ordered.map((p,i)=>({...p,order:i,revision:p.revision+1}))};await save();await show('Pages');}));await openContent();if(disposed||renderGeneration!==generation)return;const settings=element('details');settings.className='website-page-settings';settings.append(element('summary','Page settings'),row);surface.append(settings);
      }
      if(selectedPage==='redirects'){
      const redirects=element('label','Redirects: one previous path => current path or external URL per line'),text=element('textarea');
      text.value=site.redirects.map(r=>r.from+' => '+r.to).join('\n');
      redirects.append(text);surface.append(redirects,button('Save redirects',async()=>{site={...site,redirects:text.value.split('\n').filter(s=>s.trim()).map(line=>{const [from,to,...extra]=line.split('=>').map(s=>s.trim());if(!from||!to||extra.length)throw new Error('Redirects require previous path => destination.');return {from,to,status:301 as const};})};await save();}));

      }
      if(selectedPage==='new'){surface.append(element('h2','New page'));
      const add=element('div');let title='',slug='',kind:'page'|'portfolio'|'update'='page',template:Website['pages'][number]['template']='standard';field(add,'New page title','',v=>title=v);field(add,'New page path','',v=>slug=v);
      const select=element('select');select.setAttribute('aria-label','Page kind');for(const k of ['page','portfolio','update'] as const){const o=element('option',k);o.value=k;select.append(o);}select.onchange=()=>kind=select.value as typeof kind;add.append(select);
      const templateSelect=element('select');templateSelect.setAttribute('aria-label','New page template');for(const t of WEBSITE_PAGE_TEMPLATES){const o=element('option',t.title);o.value=t.id;templateSelect.append(o);}templateSelect.onchange=()=>template=templateSelect.value as typeof template;add.append(templateSelect);
      add.append(button('Add page',async()=>{if(!title.trim()||!slug.trim())throw new Error('Page title and path are required.');const id=globalThis.crypto.randomUUID(),documentId=globalThis.crypto.randomUUID();await client.saveDocument({id:documentId,workspaceId:site.workspaceId,revision:1,blocks:template==='gallery'?[{type:'gallery_list',id:globalThis.crypto.randomUUID() as EntityId,data:{sort:'newest',pageSize:12}}]:[{type:'paragraph',id:globalThis.crypto.randomUUID() as EntityId,text:template==='profile'?'Introduce yourself and your work.':'Add your page content here.'}]},0);site={...site,pages:[...site.pages,{id,documentId,websiteId:site.id,workspaceId:site.workspaceId,revision:1,kind,title,slug,template,order:site.pages.length,state:'ready',navigation:kind!=='update'}]};selectedPage=id;await save();await show('Pages');}));surface.append(add);}
    }
    if(tab==='Appearance') {
      const themes=element('div');themes.className='website-theme-grid';
      for(const theme of WEBSITE_THEMES){const choice=button(theme.title,async()=>{site={...site,theme:{...site.theme,id:theme.id}};status.textContent='Theme selected. Save appearance to keep this theme.';for(const b of Array.from(themes.querySelectorAll('button')))b.setAttribute('aria-pressed',String(b===choice));});choice.setAttribute('aria-pressed',String(site.theme.id===theme.id));choice.className='website-theme-choice';for(const palette of [theme.light,theme.dark]){const swatch=element('span','Aa');swatch.className='website-theme-swatch';swatch.setAttribute('aria-hidden','true');swatch.style.background=palette.canvas;swatch.style.color=palette.text;swatch.style.borderColor=palette.action;choice.append(swatch);}themes.append(choice);}content.append(element('h3','Theme'),themes,element('p','Every theme supports light, dark, and system modes. Save appearance, then rebuild to preview the website.'));
      const setting=<K extends keyof Website['theme']['settings']>(key:K,value:Website['theme']['settings'][K])=>site={...site,theme:{...site.theme,settings:{...site.theme.settings,[key]:value}}};
      if(client.media)await mediaField(content,'Favicon',site.theme.settings.faviconAssetId,id=>setting('faviconAssetId',id));
      field(content,'Accent color (six-digit hex; contrast checked on save)',site.theme.settings.accentColor??'',v=>site={...site,theme:{...site.theme,settings:{...site.theme.settings,accentColor:v||undefined}}});
      const font=element('select');font.setAttribute('aria-label','Font preset');for(const value of ['system','serif']){const option=element('option',value);option.value=value;font.append(option);}font.value=site.theme.settings.font??'system';font.onchange=()=>{site={...site,theme:{...site.theme,settings:{...site.theme.settings,font:font.value as 'system'|'serif'}}};};content.append(font);
      const select=element('select');select.setAttribute('aria-label','Color mode');for(const mode of ['light','dark','system'] as const){const o=element('option',mode);o.value=mode;select.append(o);}select.value=site.theme.settings.colorMode??'light';select.onchange=()=>{site={...site,theme:{...site.theme,settings:{...site.theme.settings,colorMode:select.value as 'light'|'dark'|'system'}}};};content.append(select,button('Save appearance',save));
    }
    if(tab==='Layout') {
      const workspace=element('div'),selector=element('nav'),divider=element('div'),surface=element('div');
      workspace.className='website-page-workspace'+(layoutSelectorExpanded?'':' website-pages-collapsed');selector.className='website-page-selector';selector.id='website-layout-'+site.id;selector.setAttribute('aria-label','Website layout');selector.hidden=!layoutSelectorExpanded;surface.className='website-page-surface';
      for(const name of ['Header','Footer','Top navigation']){const choice=button(name,async()=>{selectedLayout=name;await show('Layout');});choice.className='website-page-choice';choice.setAttribute('aria-pressed',String(selectedLayout===name));selector.append(choice);}
      divider.className='website-page-divider';const handle=element('div');handle.className='website-page-handle-viewport';const toggle=button('',async()=>{layoutSelectorExpanded=!layoutSelectorExpanded;workspace.classList.toggle('website-pages-collapsed',!layoutSelectorExpanded);selector.hidden=!layoutSelectorExpanded;updateToggle();measurePages();});toggle.className='website-page-toggle';toggle.setAttribute('aria-controls',selector.id);
      const updateToggle=()=>{toggle.textContent=layoutSelectorExpanded?'‹':'›';toggle.setAttribute('aria-label',layoutSelectorExpanded?'Collapse layout selector':'Expand layout selector');toggle.setAttribute('aria-expanded',String(layoutSelectorExpanded));};updateToggle();handle.append(toggle);divider.append(handle);workspace.append(selector,divider,surface);content.append(workspace);surface.append(element('h2',selectedLayout));
      const setting=<K extends keyof Website['theme']['settings']>(key:K,value:Website['theme']['settings'][K])=>site={...site,theme:{...site.theme,settings:{...site.theme.settings,[key]:value}}};
      const layout=(name:string,key:'headerLayout'|'footerLayout',values:string[])=>{const l=element('label',name),select=element('select');select.setAttribute('aria-label',name);for(const value of values){const o=element('option',value==='split'?'Brand left · navigation right':value==='centered'?(key==='headerLayout'?'Centered wordmark · no logo':'Centered navigation'):value==='stacked'?'Centered brand · navigation below':'Compact footer');o.value=value;select.append(o);}select.value=site.theme.settings[key]??'split';select.onchange=()=>setting(key,select.value as 'split'|'centered');l.append(select);surface.append(l);};
      if(selectedLayout==='Header')layout('Header layout','headerLayout',['split','centered','stacked']);
      if(selectedLayout==='Footer')layout('Footer layout','footerLayout',['split','centered','minimal']);
      if(selectedLayout==='Header'){const wordmarkLabel=element('label','Show site wordmark beside logo'),wordmark=element('input');wordmark.type='checkbox';wordmark.checked=site.theme.settings.showWordmark!==false;wordmark.onchange=()=>setting('showWordmark',wordmark.checked);wordmarkLabel.append(wordmark);surface.append(wordmarkLabel);
      if(client.media){surface.append(element('p','Images used here are included in your exported website. Centered wordmark headers hide the logo.'));await mediaField(surface,'Logo',site.theme.settings.logoAssetId,id=>setting('logoAssetId',id));}
      }
      if(selectedLayout==='Top navigation'||selectedLayout==='Footer')for(const key of (selectedLayout==='Footer'?['footerLinks']:['navigationLinks']) as ('footerLinks'|'navigationLinks')[]){const l=element('label',key==='navigationLinks'?'Extra header links · Label | https://… or mailto:… per line':'Extra footer links · Label | https://… or mailto:… per line'),textarea=element('textarea');textarea.value=(site[key]??[]).map(link=>link.label+' | '+link.url).join('\n');textarea.onchange=()=>{site={...site,[key]:textarea.value.split('\n').filter(line=>line.trim()).map(line=>{const at=line.indexOf('|');return {label:line.slice(0,at).trim(),url:line.slice(at+1).trim()};})};};l.append(textarea);surface.append(l);}
      if(selectedLayout==='Header')field(surface,'Site title',site.title,v=>site={...site,title:v});if(selectedLayout==='Footer')field(surface,'Footer text',site.theme.settings.footer??'',v=>site={...site,theme:{...site.theme,settings:{...site.theme.settings,footer:v}}});
      if(selectedLayout==='Header'&&options.showAssetIds!==false)field(surface,'Logo public asset ID',site.theme.settings.logoAssetId??'',v=>site={...site,theme:{...site.theme,settings:{...site.theme.settings,logoAssetId:v||undefined}}});

      if(selectedLayout==='Top navigation'||selectedLayout==='Footer'){
        surface.append(element('h3',selectedLayout==='Footer'?'Footer navigation':'Top navigation'),element('p','Choose which pages appear in this menu. Child pages use dropdown navigation. Change page order and parents in Page settings.'));
        for(const page of [...site.pages].sort((a,b)=>a.order-b.order)){const row=element('fieldset');row.append(element('legend',page.title));for(const key of (selectedLayout==='Footer'?['footerNavigation']:['navigation']) as ('footerNavigation'|'navigation')[]){const label=element('label',key==='navigation'?'Top navigation':'Footer navigation'),check=element('input');check.type='checkbox';check.checked=page[key]??page.navigation;check.onchange=()=>{site={...site,pages:site.pages.map(p=>p.id===page.id?{...p,[key]:check.checked,revision:p.revision+1}:p)};};label.append(check);row.append(label);}surface.append(row);}
      }
      surface.append(button('Save '+selectedLayout.toLowerCase(),save));
    }
    if(tab==='Gallery destinations') {
      content.append(element('p',options.destinationModes&&!options.destinationModes.includes('connected')?'Select public Works to include in this website. Each Work can have its own title and link destination.':'Gallery blocks select exact publication IDs. A missing connected mapping blocks the build unless an explicit fallback or omission rule is configured.'));
      const select=element('select');select.setAttribute('aria-label','Default gallery destination');for(const mode of options.destinationModes ?? ['local','manual','connected']){const o=element('option',mode);o.value=mode;select.append(o);}select.value=site.galleryDefault.destination.mode;
      let external=site.galleryDefault.destination.mode==='manual'?site.galleryDefault.destination.url:'';
      let destination=site.galleryDefault.destination.mode==='connected'?site.galleryDefault.destination.destinationId:'',account=site.galleryDefault.destination.mode==='connected'?site.galleryDefault.destination.accountId:'',space=site.galleryDefault.destination.mode==='connected'?site.galleryDefault.destination.spaceId??'':'';
      content.append(select);const manualInput=field(content,'External public URL',external,v=>external=v);
      const connectedInputs=options.destinationModes&&!options.destinationModes.includes('connected')?[]:[field(content,'Connected destination ID',destination,v=>destination=v),field(content,'Account ID',account,v=>account=v),field(content,'Space ID (optional)',space,v=>space=v)];
      const toggleFields=()=>{manualInput.parentElement!.hidden=select.value!=='manual';for(const input of connectedInputs)input.parentElement!.hidden=select.value!=='connected';};select.onchange=toggleFields;toggleFields();
      content.append(button('Save gallery default',async()=>{site={...site,galleryDefault:{destination:select.value==='manual'?{mode:'manual',url:external}:select.value==='connected'?{mode:'connected',destinationId:destination,accountId:account,spaceId:space||undefined}:{mode:'local'},missing:'error'}};await save();}));
      const catalogue=client.catalogue?await client.catalogue():undefined;
      if(catalogue) for(const publication of catalogue) {
        const label=element('label',publication.title),check=element('input');check.type='checkbox';check.checked=site.galleryPublicationIds.includes(publication.id);
        check.onchange=()=>{site={...site,galleryPublicationIds:check.checked?[...site.galleryPublicationIds,publication.id]:site.galleryPublicationIds.filter(id=>id!==publication.id),gallerySettings:check.checked?site.gallerySettings:site.gallerySettings?.filter(s=>s.publicationId!==publication.id)};};label.append(check);content.append(label);
      } else field(content,'Selected publication IDs (comma separated)',site.galleryPublicationIds.join(', '),v=>{site={...site,galleryPublicationIds:v.split(',').map(s=>s.trim()).filter(Boolean)};});
      content.append(button('Save selection',async()=>{await save();await show('Gallery destinations');}));
      for(const publicationId of site.galleryPublicationIds) {
        const row=element('fieldset');row.append(element('legend',catalogue?.find(p=>p.id===publicationId)?.title??'Selected publication'));
        let setting=site.gallerySettings?.find(s=>s.publicationId===publicationId)??{publicationId};
        const change=()=>{site={...site,gallerySettings:[...(site.gallerySettings??[]).filter(s=>s.publicationId!==publicationId),setting]};};
        field(row,'Website title',setting.title??'',v=>{setting={...setting,title:v||undefined};change();});
        field(row,'Website slug',setting.slug??'',v=>{setting={...setting,slug:v||undefined};change();});
        const mode=element('select');mode.setAttribute('aria-label','Publication destination');for(const m of ['inherit',...(options.destinationModes ?? ['local','manual']).filter(m=>m!=='connected')]){const o=element('option',m);o.value=m;mode.append(o);}mode.value=setting.destination?.destination.mode??'inherit';
        let manual=setting.destination?.destination.mode==='manual'?setting.destination.destination.url:'';
        const update=()=>{setting={...setting,destination:mode.value==='inherit'?undefined:{destination:mode.value==='local'?{mode:'local'}:{mode:'manual',url:manual},missing:'error'}};change();};
        mode.onchange=update;row.append(mode);field(row,'Publication external URL',manual,v=>{manual=v;update();});content.append(row);
      }
      content.append(button('Save publication overrides',save));

    }
    if(tab==='Publishing'||tab==='Preview') {
      content.append(element('p','Each build preserves a saved website version. Rebuild after changing pages or Works.'));
      if(client.builds) {
        const builds=await client.builds(),select=element('select');select.setAttribute('aria-label','Saved website build');select.append(element('option','Choose a build'));
        for(const build of builds){const option=element('option',`Revision ${build.websiteRevision} — ${build.state}`);option.value=build.id;select.append(option);}select.value=currentBuild??'';select.onchange=()=>{currentBuild=select.value||undefined;};content.append(select);
      }
      content.append(button('Build website',async()=>{const b=await client.requestBuild(site.revision,globalThis.crypto.randomUUID());currentBuild=b.id;status.textContent=b.state==='ready'?'Website build ready. Preview it or download the ZIP.':b.state==='failed'?'Website build failed. Refresh the status for details.':`Website build ${b.state}. Refresh the status to follow its progress.`;}));
      content.append(button('Refresh build status',async()=>{if(!currentBuild)throw new Error('Build a candidate first.');const b=await client.build(currentBuild);status.textContent=`Build ${b.state}${b.stale?' — newer or restricted sources exist':''}. ${b.errorCode??''} ${b.warnings.join(' ')}`;}));
      if(tab==='Publishing') content.append(button('Download exact candidate ZIP',async()=>{if(!currentBuild)throw new Error('Build a candidate first.');if(client.download)await client.download(currentBuild);else{const blob=await client.export(currentBuild),url=URL.createObjectURL(blob),a=element('a','Download website ZIP');a.href=url;a.download='website.zip';content.append(a);a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);}status.textContent='Exported. Upload the files to your hosting provider to publish.';}));
      if(tab==='Preview') {
        const frame=element('iframe');frame.title='Private website candidate';frame.setAttribute('sandbox','');frame.style.width='100%';frame.style.height='600px';
        const select=element('select');select.setAttribute('aria-label','Preview page');const option=element('option','Home');option.value='index.html';select.append(option);
        content.append(button('Load candidate pages',async()=>{if(!currentBuild)throw new Error('Build a candidate first.');const paths=await client.previewPages?.(currentBuild)??['index.html'];select.replaceChildren();for(const path of paths){const option=element('option',path==='index.html'?'Home':path.replace(/\/index.html$/,''));option.value=path;select.append(option);}}),select,button('Show candidate',async()=>{if(!currentBuild)throw new Error('Build a candidate first.');frame.srcdoc=await client.preview(currentBuild,select.value);}),button('Mobile width',async()=>{frame.style.width='375px';frame.style.maxWidth='100%';}),button('Desktop width',async()=>{frame.style.width='100%';}),frame);
      }
    }
    if(!disposed&&root.isConnected){root.scrollIntoView?.({block:'start'});measurePages();}
  };
  for(const tab of ['Pages','Layout','Appearance','Gallery destinations','Preview',...(options.exportEnabled===false?[]:['Publishing'])])tabs.append(button(tab,async()=>{if(!disposed)await show(tab);}));
  const ready=client.get().then(async value=>{if(!disposed){site=value;await show('Pages');}}).catch(error=>{status.textContent=String(error);});
  return {ready,destroy(){disposed=true;win?.removeEventListener('resize',scheduleMeasure);win?.removeEventListener('scroll',scheduleMeasure,true);if(measureFrame)win?.cancelAnimationFrame(measureFrame);for(const observer of imageObservers)observer.disconnect();cleanupEditor?.();root.replaceChildren();}};
};
