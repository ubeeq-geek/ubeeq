import type { Website, WebsiteDocument, WebsiteHostingTarget, HostingCapabilities } from '@ubeeq/core';

export interface WebsiteWorkspaceClient {
  hostingConnections?():Promise<readonly {id:string;family:string;accountId:string;state:string}[]>;
  hostingConnectionAction?(action:string,body:Record<string,unknown>):Promise<any>;
  hostingChoices?():Promise<readonly {id:string;family:string;capabilities:HostingCapabilities}[]>;
  hostingHistory?():Promise<{targets:readonly WebsiteHostingTarget[];bindings?:readonly {id:string;revision:number;label:string;enabled:boolean;targetIds:readonly string[]}[];domains?:readonly {id:string;targetId:string;hostname:string;state:string;instructions:readonly string[]}[];attempts:readonly {id:string;targetId:string;state:string;generation:number;errorCode?:string;verification?:{publicConfirmed:boolean;reasons:readonly string[]}}[]}>;
  createNativeTarget?(adapterId:string,label:string):Promise<void>;
  reviewBinding?(id:string,bindingRevision:number,websiteRevision:number):Promise<{planId:string;fingerprint:string;expiresAt:string}>;
  reviewPublication?(revision:number,targetIds:readonly string[]):Promise<{planId:string;fingerprint:string;expiresAt:string}>;
  publishWebsite?(planId:string,fingerprint:string,key:string):Promise<void>;
  hostingAction?(action:string,id:string,body?:unknown):Promise<void>;
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
  /** Returns an authorized generated HTML document. The iframe is always sandboxed. */
  preview(id: string,file?:string): Promise<string>;
}
/** Shared editor injection keeps the authoritative block format and existing editor. */
export const createWebsiteWorkspace = (root: HTMLElement, client: WebsiteWorkspaceClient, mountEditor: (host: HTMLElement, document: WebsiteDocument, onChange: (document: WebsiteDocument) => void) => (() => void)) => {
  const d=root.ownerDocument;
  let site: Website, disposed=false, cleanupEditor: (()=>void)|undefined, currentBuild:string|undefined;
  const element=<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string) => {const el=d.createElement(tag);if(text)el.textContent=text;return el;};
  const status=element('p'); status.setAttribute('role','status');
  const tabs=element('nav'), content=element('section'); tabs.setAttribute('aria-label','Website tools'); root.replaceChildren(tabs,status,content);
  const act=(fn:()=>Promise<void>)=>async()=>{try{await fn();}catch(error){status.textContent=error instanceof Error?error.message:'Website operation failed.';}};
  const button=(label:string,fn:()=>Promise<void>)=>{const b=element('button',label);b.type='button';b.onclick=act(fn);return b;};
  const field=(parent:HTMLElement,label:string,value:string,change:(v:string)=>void)=>{const l=element('label',label),i=element('input');i.value=value;i.onchange=()=>change(i.value);l.append(i);parent.append(l);return i;};
  const save=async()=>{const expected=site.revision;site=await client.save({...site,revision:expected+1},expected);status.textContent=`Website revision ${site.revision} saved. Build a new candidate to update the export.`;};
  const show=async(tab:string)=>{
    cleanupEditor?.();cleanupEditor=undefined;content.replaceChildren(element('h2',tab));
    if(tab==='Publishing'&&client.hostingChoices&&client.hostingHistory){
      const choices=await client.hostingChoices(),history=await client.hostingHistory();
      content.append(element('p','Publish captures the approved saved content for the selected destinations. Later draft edits stay out of this release. Provider propagation and public verification may take time.'));
      if(!choices.length)content.append(element('p','Hosting has not been enabled by the installation administrator. Exact candidate ZIP download remains available below.'));
      for(const choice of choices){
        content.append(element('p',`${choice.family}: staging ${choice.capabilities.staging}; activation ${choice.capabilities.activation}; domains ${choice.capabilities.domains}.`));
        if(choice.family==='native'&&client.createNativeTarget)content.append(button('Create native destination',async()=>{await client.createNativeTarget!(choice.id,site.title);await show('Publishing');}));
      }
      if(client.hostingConnections&&client.hostingConnectionAction&&choices.some(c=>['netlify','cloudflare-pages','sftp'].includes(c.family))){
        const connections=await client.hostingConnections(),action=client.hostingConnectionAction.bind(client);
        const connect=element('details');connect.append(element('summary','Connect a hosting account'));
        if(choices.some(c=>c.family==='netlify')){let accountId='';field(connect,'Netlify team account ID','',v=>accountId=v);connect.append(button('Authorize Netlify',async()=>{const result=await action('netlify-authorize',{accountId});globalThis.location.assign(result.authorizationUrl);}));}
        if(choices.some(c=>c.family==='cloudflare-pages')){let accountId='',token='';field(connect,'Cloudflare account ID','',v=>accountId=v);const secret=field(connect,'Restricted Pages API token','',v=>token=v);secret.type='password';secret.autocomplete='off';connect.append(button('Connect Cloudflare Pages',async()=>{await action('cloudflare-pages',{accountId,token});token='';secret.value='';await show('Publishing');}));}
        if(choices.some(c=>c.family==='sftp')){let accountId='',username='',privateKey='';field(connect,'SFTP account label','',v=>accountId=v);field(connect,'SFTP username','',v=>username=v);const label=element('label','SSH private key'),key=element('textarea');key.autocomplete='off';key.onchange=()=>privateKey=key.value;label.append(key);connect.append(label,button('Save SFTP key connection',async()=>{await action('sftp',{accountId,username,privateKey});privateKey='';key.value='';await show('Publishing');}));}
        content.append(connect);
        for(const connection of connections){const group=element('details');group.append(element('summary',`${connection.family}: ${connection.accountId} (${connection.state})`),button('Disconnect account',async()=>{await action('disconnect',{connectionId:connection.id});await show('Publishing');}));
          if(['netlify','cloudflare-pages'].includes(connection.family)){let name='';field(group,'New provider site/project name','',v=>name=v);group.append(button('Create provider site/project',async()=>{await action('provision',{connectionId:connection.id,name});status.textContent='Provider site created. Reload the site catalogue to select it.';}),button('Load sites/projects',async()=>{const catalogue=await action('catalogue',{connectionId:connection.id});for(const remote of catalogue.sites){const row=element('div');row.append(element('p',remote.name));let handoff=false;const label=element('label','Confirm replacement of this site and any Git deployment handoff'),check=element('input');check.type='checkbox';check.onchange=()=>handoff=check.checked;label.append(check);row.append(label,button('Use '+remote.name,async()=>{if(!handoff)throw new Error('Confirm management of the selected site.');await action('target',{connectionId:connection.id,websiteId:site.id,remoteId:remote.id,label:remote.name,publicUrl:remote.publicUrl,ownershipConfirmed:true,config:connection.family==='cloudflare-pages'?{projectName:remote.name,productionBranch:remote.productionBranch}:{gitHandoff:'confirmed'}});await show('Publishing');}));group.append(row);}}));}
          if(connection.family==='sftp'){const config:Record<string,string>={port:'22'};for(const [key,label] of [['hostname','SFTP hostname'],['port','SFTP port'],['root','Dedicated absolute managed root'],['hostKeyFingerprint','Independently verified SHA256 host fingerprint']])field(group,label,config[key]??'',v=>config[key]=v);let publicUrl='',owned=false;field(group,'Public HTTPS URL for this root','',v=>publicUrl=v);const label=element('label','I authorize replacement of files in this dedicated managed root'),check=element('input');check.type='checkbox';check.onchange=()=>owned=check.checked;label.append(check);group.append(label,element('p','In-place copying can expose mixed files during interruptions. Pointer profiles require operator setup and a successful protocol probe.'),button('Validate and use in-place SFTP',async()=>{if(!owned)throw new Error('Confirm management of the dedicated root.');await action('target',{connectionId:connection.id,adapterId:'sftp-in_place',websiteId:site.id,label:connection.accountId,publicUrl,config,ownershipConfirmed:true});await show('Publishing');}));}
          content.append(group);
        }
      }
      const selected=new Set<string>();
      for(const target of history.targets){const label=element('label',target.label),check=element('input');check.type='checkbox';check.onchange=()=>check.checked?selected.add(target.id):selected.delete(target.id);label.append(check);content.append(label,element('p',`Desired generation ${target.desiredGeneration}; active ${target.activeGeneration}; serving ${target.serving}.`));if(target.servingRemovalRequired)content.append(element('p','Policy requires serving removal. The provider/server operator must complete withdrawal; serving is not confirmed disabled.'));const link=element('a','Open public website');link.href=target.publicUrl;link.target='_blank';link.rel='noopener noreferrer';content.append(link);
        if(['suspended','unpublished'].includes(target.serving)&&target.capabilities.emergencySuspension&&target.activeGeneration>0)content.append(button('Resume eligible serving',async()=>{await client.hostingAction!('resume',target.id);await show('Publishing');}));
        if(target.capabilities.unpublish==='confirmed')content.append(button('Unpublish '+target.label,async()=>{await client.hostingAction!('unpublish',target.id,{idempotencyKey:crypto.randomUUID()});await show('Publishing');}));
        else content.append(element('p','Serving removal requires the provider or server operator.'));
        let hostname='';field(content,'Custom hostname for '+target.label,'',v=>hostname=v);content.append(button('Request domain',async()=>{await client.hostingAction!('domains',target.id,{hostname,mode:'alias'});await show('Publishing');}));
        for(const domain of history.domains?.filter(d=>d.targetId===target.id)??[]){content.append(element('p',`${domain.hostname}: ${domain.state}. ${domain.instructions.join(' ')}`),button('Verify '+domain.hostname,async()=>{await client.hostingAction!('domain-verify',target.id,{domainId:domain.id});await show('Publishing');}),button('Remove '+domain.hostname,async()=>{await client.hostingAction!('domain-remove',target.id,{domainId:domain.id});await show('Publishing');}));}

      }
      let bindingLabel='';field(content,'Saved destination selection name','',v=>bindingLabel=v);content.append(button('Save destination binding',async()=>{await client.hostingAction!('binding','',{label:bindingLabel,targetIds:[...selected],expectedRevision:0,enabled:true});await show('Publishing');}));
      for(const binding of history.bindings??[])if(binding.enabled&&client.reviewBinding)content.append(button('Review Publish to '+binding.label,async()=>{const plan=await client.reviewBinding!(binding.id,binding.revision,site.revision);content.append(element('p',`Approved source review for ${binding.label}; expires ${plan.expiresAt}.`),button('Publish approved '+binding.label,async()=>{await client.publishWebsite!(plan.planId,plan.fingerprint,crypto.randomUUID());await show('Publishing');}));}));
      content.append(button('Review Publish',async()=>{if(!selected.size)throw new Error('Select a publishing destination.');const plan=await client.reviewPublication!(site.revision,[...selected]);const review=element('section');review.append(element('p',`Saved website revision ${site.revision}; ${selected.size} destination(s). Review expires ${plan.expiresAt}. Staged external deploy URLs can be public.`),button('Publish approved release',async()=>{await client.publishWebsite!(plan.planId,plan.fingerprint,crypto.randomUUID());status.textContent='Publish accepted. The worker will generate and deploy the approved release.';await show('Publishing');}));content.append(review);}));
      content.append(button('Refresh publishing status',async()=>show('Publishing')));
      for(const attempt of history.attempts){const row=element('div');row.append(element('p',`${history.targets.find(t=>t.id===attempt.targetId)?.label??'Website'}: generation ${attempt.generation}: ${attempt.state}${attempt.errorCode?' ('+attempt.errorCode+')':''}`));
        if(attempt.verification)row.append(element('p',attempt.verification.publicConfirmed?'Public release verified':`Verification pending: ${attempt.verification.reasons.join(', ')}`));
        if(['failed','reconnect_required'].includes(attempt.state))row.append(button('Retry deployment',async()=>{await client.hostingAction!('retry',attempt.id,{idempotencyKey:crypto.randomUUID()});await show('Publishing');}));
        if(['unknown','verifying'].includes(attempt.state))row.append(button('Reconcile serving status',async()=>{await client.hostingAction!('reconcile',attempt.id);await show('Publishing');}));
        if(['queued','generating','uploading'].includes(attempt.state))row.append(button('Cancel deployment',async()=>{await client.hostingAction!('cancel',attempt.id);await show('Publishing');}));
        if(attempt.state==='published')row.append(button('Restore this retained release',async()=>{await client.hostingAction!('rollback',attempt.targetId,{attemptId:attempt.id,idempotencyKey:crypto.randomUUID()});await show('Publishing');}));content.append(row);
      }
    }
    if(tab==='Pages') {
      content.append(element('p','Hidden pages included in an export remain publicly reachable. Shared document edits affect every destination listed below.'));
      for(const p of site.pages) {
        const row=element('div');
        const editPage=(patch:Partial<typeof p>)=>{site={...site,pages:site.pages.map(next=>next.id===p.id?{...next,...patch,revision:next.revision+1}:next)};};
        field(row,'Page title',p.title,v=>editPage({title:v}));
        field(row,'Search title',p.seoTitle??'',v=>editPage({seoTitle:v||undefined}));
        field(row,'Search description',p.description??'',v=>editPage({description:v||undefined}));
        field(row,'Canonical URL (optional)',p.canonicalUrl??'',v=>editPage({canonicalUrl:v||undefined}));
        field(row,'Social preview asset ID (optional)',p.socialAssetId??'',v=>editPage({socialAssetId:v||undefined}));
        if(p.kind==='update') field(row,'Update date',p.date??'',v=>editPage({date:v||undefined}));
        if(p.kind!=='home') {const state=element('select');state.setAttribute('aria-label','Page lifecycle');for(const value of ['draft','ready','archived']){const option=element('option',value);option.value=value;state.append(option);}state.value=p.state;state.onchange=()=>editPage({state:state.value as typeof p.state});row.append(state);}
        row.append(button('Duplicate document for this page',async()=>{const source=await client.document(p.documentId),id=globalThis.crypto.randomUUID();await client.saveDocument({...source.document,id,revision:1},0);editPage({documentId:id});await save();await show('Pages');}));
        row.append(button(p.title,async()=>{
          const result=await client.document(p.documentId),editor=element('div');let doc=result.document;
          content.replaceChildren(element('h2',p.title),element('p',`Shared by: ${result.sharedBy.map(p=>p.title).join(', ')||'This page'}`),editor);
          cleanupEditor=mountEditor(editor,doc,next=>{doc=next;});
          content.append(button('Save content',async()=>{doc=await client.saveDocument({...doc,revision:result.document.revision+1},result.document.revision);status.textContent='Content saved. Reopen the editor to continue from the saved revision.';await show('Pages');}));
        }));
        if(p.kind!=='home') {
          field(row,'Path segment',p.slug,v=>{site={...site,pages:site.pages.map(next=>next.id===p.id?{...next,slug:v,revision:next.revision+1}:next)};});
          const label=element('label','Parent'),select=element('select');
          for(const candidate of [{id:'',title:'Top level'},...site.pages.filter(x=>x.kind!=='home'&&x.kind!=='update'&&!x.parentId&&x.id!==p.id)]) {const option=element('option',candidate.title);option.value=candidate.id;select.append(option);}
          select.value=p.parentId??'';select.onchange=()=>{site={...site,pages:site.pages.map(next=>next.id===p.id?{...next,parentId:select.value||undefined,revision:next.revision+1}:next)};};label.append(select);row.append(label);
        }
        const label=element('label','Show in navigation'),check=element('input');check.type='checkbox';check.checked=p.navigation;check.onchange=()=>{site={...site,pages:site.pages.map(next=>next.id===p.id?{...next,navigation:check.checked,revision:next.revision+1}:next)};};label.append(check);row.append(label);
        row.append(button('Move up',async()=>{const ordered=[...site.pages].sort((a,b)=>a.order-b.order);const i=ordered.findIndex(x=>x.id===p.id);if(i>0)[ordered[i],ordered[i-1]]=[ordered[i-1],ordered[i]];site={...site,pages:ordered.map((p,i)=>({...p,order:i,revision:p.revision+1}))};await save();await show('Pages');}));content.append(row);
      }
      content.append(button('Save page settings',save));
      const redirects=element('label','Redirects: one previous path => current path or external URL per line'),text=element('textarea');
      text.value=site.redirects.map(r=>r.from+' => '+r.to).join('\n');
      redirects.append(text);content.append(redirects,button('Save redirects',async()=>{site={...site,redirects:text.value.split('\n').filter(s=>s.trim()).map(line=>{const [from,to,...extra]=line.split('=>').map(s=>s.trim());if(!from||!to||extra.length)throw new Error('Redirects require previous path => destination.');return {from,to,status:301 as const};})};await save();}));

      const add=element('div');let title='',slug='',kind:'page'|'portfolio'|'update'='page';field(add,'New page title','',v=>title=v);field(add,'New page path','',v=>slug=v);
      const select=element('select');select.setAttribute('aria-label','Page kind');for(const k of ['page','portfolio','update'] as const){const o=element('option',k);o.value=k;select.append(o);}select.onchange=()=>kind=select.value as typeof kind;add.append(select);
      add.append(button('Add page',async()=>{if(!title.trim()||!slug.trim())throw new Error('Page title and path are required.');const id=globalThis.crypto.randomUUID(),documentId=globalThis.crypto.randomUUID();await client.saveDocument({id:documentId,workspaceId:site.workspaceId,revision:1,blocks:[]},0);site={...site,pages:[...site.pages,{id,documentId,websiteId:site.id,workspaceId:site.workspaceId,revision:1,kind,title,slug,order:site.pages.length,state:'ready',navigation:kind!=='update'}]};await save();await show('Pages');}));content.append(add);
    }
    if(tab==='Appearance') {
      field(content,'Site title',site.title,v=>site={...site,title:v});field(content,'Footer',site.theme.settings.footer??'',v=>site={...site,theme:{...site.theme,settings:{...site.theme.settings,footer:v}}});
      field(content,'Logo public asset ID',site.theme.settings.logoAssetId??'',v=>site={...site,theme:{...site.theme,settings:{...site.theme.settings,logoAssetId:v||undefined}}});
      field(content,'Favicon public asset ID',site.theme.settings.faviconAssetId??'',v=>site={...site,theme:{...site.theme,settings:{...site.theme.settings,faviconAssetId:v||undefined}}});
      field(content,'Accent color (six-digit hex; contrast checked on save)',site.theme.settings.accentColor??'',v=>site={...site,theme:{...site.theme,settings:{...site.theme.settings,accentColor:v||undefined}}});
      const font=element('select');font.setAttribute('aria-label','Font preset');for(const value of ['system','serif']){const option=element('option',value);option.value=value;font.append(option);}font.value=site.theme.settings.font??'system';font.onchange=()=>{site={...site,theme:{...site.theme,settings:{...site.theme.settings,font:font.value as 'system'|'serif'}}};};content.append(font);
      const select=element('select');select.setAttribute('aria-label','Color mode');for(const mode of ['light','dark','system'] as const){const o=element('option',mode);o.value=mode;select.append(o);}select.value=site.theme.settings.colorMode??'light';select.onchange=()=>{site={...site,theme:{...site.theme,settings:{...site.theme.settings,colorMode:select.value as 'light'|'dark'|'system'}}};};content.append(select,button('Save appearance',save));
    }
    if(tab==='Gallery destinations') {
      content.append(element('p','Gallery blocks select exact publication IDs. A missing connected mapping blocks the build unless an explicit fallback or omission rule is configured.'));
      const select=element('select');select.setAttribute('aria-label','Default gallery destination');for(const mode of ['local','manual','connected']){const o=element('option',mode);o.value=mode;select.append(o);}select.value=site.galleryDefault.destination.mode;
      let external=site.galleryDefault.destination.mode==='manual'?site.galleryDefault.destination.url:'';
      let destination=site.galleryDefault.destination.mode==='connected'?site.galleryDefault.destination.destinationId:'',account=site.galleryDefault.destination.mode==='connected'?site.galleryDefault.destination.accountId:'',space=site.galleryDefault.destination.mode==='connected'?site.galleryDefault.destination.spaceId??'':'';
      content.append(select);field(content,'External public URL',external,v=>external=v);field(content,'Connected destination ID',destination,v=>destination=v);field(content,'Account ID',account,v=>account=v);field(content,'Space ID (optional)',space,v=>space=v);
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
        const mode=element('select');mode.setAttribute('aria-label','Publication destination');for(const m of ['inherit','local','manual']){const o=element('option',m);o.value=m;mode.append(o);}mode.value=setting.destination?.destination.mode??'inherit';
        let manual=setting.destination?.destination.mode==='manual'?setting.destination.destination.url:'';
        const update=()=>{setting={...setting,destination:mode.value==='inherit'?undefined:{destination:mode.value==='local'?{mode:'local'}:{mode:'manual',url:manual},missing:'error'}};change();};
        mode.onchange=update;row.append(mode);field(row,'Publication external URL',manual,v=>{manual=v;update();});content.append(row);
      }
      content.append(button('Save publication overrides',save));

    }
    if(tab==='Publishing'||tab==='Preview') {
      content.append(element('p','Builds are immutable candidates. Exported means downloaded; it does not confirm a live deployment.'));
      if(client.builds) {
        const builds=await client.builds(),select=element('select');select.setAttribute('aria-label','Build candidate');select.append(element('option','Choose a candidate'));
        for(const build of builds){const option=element('option',`Revision ${build.websiteRevision} — ${build.state}`);option.value=build.id;select.append(option);}select.value=currentBuild??'';select.onchange=()=>{currentBuild=select.value||undefined;};content.append(select);
      }
      content.append(button('Build website',async()=>{const b=await client.requestBuild(site.revision,globalThis.crypto.randomUUID());currentBuild=b.id;status.textContent=`Build ${b.state}. Refresh status after the worker completes.`;}));
      content.append(button('Refresh build status',async()=>{if(!currentBuild)throw new Error('Build a candidate first.');const b=await client.build(currentBuild);status.textContent=`Build ${b.state}${b.stale?' — newer or restricted sources exist':''}. ${b.errorCode??''} ${b.warnings.join(' ')}`;}));
      if(tab==='Publishing') content.append(button('Download exact candidate ZIP',async()=>{if(!currentBuild)throw new Error('Build a candidate first.');const blob=await client.export(currentBuild),url=URL.createObjectURL(blob),a=element('a','Download website ZIP');a.href=url;a.download='website.zip';content.append(a);a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);status.textContent='Exact candidate ZIP downloaded.';}));
      if(tab==='Preview') {
        const frame=element('iframe');frame.title='Private website candidate';frame.setAttribute('sandbox','');frame.style.width='100%';frame.style.height='600px';
        const select=element('select');select.setAttribute('aria-label','Preview page');const option=element('option','Home');option.value='index.html';select.append(option);
        content.append(button('Load candidate pages',async()=>{if(!currentBuild)throw new Error('Build a candidate first.');const paths=await client.previewPages?.(currentBuild)??['index.html'];select.replaceChildren();for(const path of paths){const option=element('option',path==='index.html'?'Home':path.replace(/\/index.html$/,''));option.value=path;select.append(option);}}),select,button('Show candidate',async()=>{if(!currentBuild)throw new Error('Build a candidate first.');frame.srcdoc=await client.preview(currentBuild,select.value);}),button('Mobile width',async()=>{frame.style.width='375px';frame.style.maxWidth='100%';}),button('Desktop width',async()=>{frame.style.width='100%';}),frame);
      }
    }
  };
  for(const tab of ['Pages','Appearance','Gallery destinations','Preview','Publishing'])tabs.append(button(tab,async()=>{if(!disposed)await show(tab);}));
  const ready=client.get().then(async value=>{if(!disposed){site=value;await show('Pages');}}).catch(error=>{status.textContent=String(error);});
  return {ready,destroy(){disposed=true;cleanupEditor?.();root.replaceChildren();}};
};
