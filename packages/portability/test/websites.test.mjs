import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebsiteService, buildWebsiteArtifact, websiteDigest, normalizeWebsiteDocument } from '../dist/index.js';
import { websiteRoutes, websitePath, resolveWebsiteGallery, parseContentBlocks } from '@ubeeq/core';
import { STATIC_BLOCK_SUPPORT } from '@ubeeq/ui';
import { SqliteWebsiteStore } from '../../../adapters/local/dist/index.js';

const limits={maxPages:200,maxAssets:500,maxBytes:2*1024*1024};
const page=(id,slug,extra={})=>({id,websiteId:'site-private',workspaceId:'workspace-private',revision:1,documentId:'doc-'+id,kind:'page',title:id,slug,order:1,state:'ready',navigation:true,...extra});
const block=(type,extra={})=>({id:'block-private-'+type,type,...extra});
const fixture=(basePath='/')=>{
  const home=page('home','',{kind:'home',title:'Home',order:0}),portfolio=page('portfolio','portfolio'),about=page('about','about',{parentId:'portfolio'}),update=page('update','autumn',{kind:'update',date:'2026-10-18',excerpt:'Autumn release'});
  const website={id:'site-private',workspaceId:'workspace-private',creatorIdentityId:'creator-private',revision:1,title:'A quiet portfolio',locale:'en',homePageId:'home',theme:{id:'neutral',version:'1',settings:{footer:'Artist copyright'}},galleryDefault:{destination:{mode:'manual',url:'https://example.com/portfolio'},missing:'error'},mediaMode:'bundled',basePath,publicBaseUrl:'https://artist.example',pages:[home,portfolio,about,update],galleryPublicationIds:['preview-private','premium-private'],redirects:[{from:'/old-about/',to:'/portfolio/about/',status:301}]};
  const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNQinMHAAFtAMjJGretAAAAAElFTkSuQmCC','base64');
  const asset={id:'public-preview-private',workspaceId:website.workspaceId,revision:1,checksum:websiteDigest(bytes),mimeType:'image/png',bytes,alt:'An autumn landscape',width:1,height:1,approvedPublic:true,metadataStripped:true};
  const common={workId:'same-work-private',workspaceId:website.workspaceId,revision:1,description:'Public caption',tags:['landscape'],collectionIds:['collection-private'],date:'2026-10-18',previewAssetIds:[asset.id],publicAssetIds:[]};
  const galleries=[{...common,publicationId:'preview-private',title:'Autumn public gallery',slug:'autumn',premium:false,publicAssetIds:[asset.id],destination:{destination:{mode:'local'}}},{...common,publicationId:'premium-private',title:'Members gallery preview',slug:'members',premium:true}];
  const content=[block('heading',{text:'Selected work'}),block('paragraph',{html:'Public <strong>introduction</strong> <a href="https://example.com/artist">Artist</a><script>token-secret-draft</script>'}),block('quote',{text:'A quotation',author:'A reader'}),block('divider'),block('image',{assetId:asset.id,caption:'Autumn'}),block('link',{label:'Contact',url:'mailto:artist@example.com'}),block('credit',{author:'Artist',text:'Public attribution'}),block('section',{title:'More',children:[block('paragraph',{text:'Nested section'})]}),block('grouping',{children:[block('paragraph',{text:'Group'})]}),block('carousel',{children:[block('image',{assetId:asset.id})]}),block('embed',{title:'Watch externally',url:'https://example.com/video',data:{staticFallback:'link'}}),block('gallery_preview',{data:{publicationIds:['preview-private']}}),block('premium_promotion',{data:{publicationIds:['premium-private']}}),block('selected_portfolio',{data:{publicationIds:['premium-private','preview-private']}}),block('gallery_list',{data:{tags:['landscape'],collectionIds:[],publicationIds:[],pageSize:1}}),block('update_list'),block('page_link',{data:{pageId:'about'},label:'About the artist'})];
  return {apiVersion:'1',website,documents:website.pages.map((p,i)=>({id:p.documentId,workspaceId:website.workspaceId,revision:1,blocks:i===0?content:[block('paragraph',{text:p.title+' public text'})]})),galleries,mappings:[],assets:[asset],dependencies:[{kind:'catalogue',id:'selected-pool-private',revision:'1'}]};
};
const unzip=zip=>{
  const files=new Map();let pos=0;
  while(zip.readUInt32LE(pos)===0x04034b50){const size=zip.readUInt32LE(pos+18),n=zip.readUInt16LE(pos+26),extra=zip.readUInt16LE(pos+28),name=zip.subarray(pos+30,pos+30+n).toString(),start=pos+30+n+extra;files.set(name,zip.subarray(start,start+size));pos=start+size;}
  return files;
};

test('portable artifact is deterministic, inert, publication-specific and contains no private records',()=>{
  const snapshot=fixture(),first=buildWebsiteArtifact(snapshot,limits),second=buildWebsiteArtifact(structuredClone(snapshot),limits);
  assert.equal(first.digest,second.digest);assert.deepEqual(first.zip,second.zip);
  const files=unzip(Buffer.from(first.zip));assert.equal(files.size,first.files.size);
  const text=[...files].filter(([p])=>!p.endsWith('.png')).map(([,b])=>b.toString()).join('\n');
  for(const secret of ['workspace-private','same-work-private','site-private','creator-private','doc-home','token-secret-draft','block-private','collection-private','selected-pool-private'])assert.ok(!text.includes(secret),secret);
  assert.ok(files.has('galleries/autumn/index.html'));assert.ok(!files.has('galleries/members/index.html'));
  assert.match(files.get('index.html').toString(),/https:\/\/example.com\/portfolio/);
  assert.match(files.get('index.html').toString(),/href="\/galleries\/autumn\/"/);
  assert.equal([...files.keys()].filter(p=>p.endsWith('.png')).length,1);
  assert.ok(!text.includes('<script'));assert.match(text,/noopener noreferrer/);
  assert.ok(first.warnings.some(w=>w.includes('HTTP 301')));
});

test('root and subpath exports work over HTTP with no Ubeeq instance or browser script',async t=>{
  for(const base of ['/','/creator/']){
    const snapshot=fixture(base); snapshot.website.pages[2].slug='café'; snapshot.website.redirects[0].to='/portfolio/café/';
    const artifact=buildWebsiteArtifact(snapshot,limits),prefix=base.slice(0,-1);
    const server=createServer((req,res)=>{const path=new URL(req.url,'http://static.local').pathname;if(!path.startsWith(prefix+'/')){res.writeHead(404).end();return;}let key=decodeURIComponent(path.slice(prefix.length+1));if(!key||key.endsWith('/'))key+='index.html';const bytes=artifact.files.get(key);res.writeHead(bytes?200:404,{'content-type':key.endsWith('.html')?'text/html':key.endsWith('.css')?'text/css':'image/png'}).end(bytes);});
    server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
    const origin='http://127.0.0.1:'+server.address().port;
    for(const path of [base,base+'portfolio/caf%C3%A9/',base+'galleries/autumn/',base+'assets/theme.css'])assert.equal((await fetch(origin+path)).status,200,path);
    const home=await(await fetch(origin+base)).text();
    for(const href of [...home.matchAll(/(?:href|src)="([^"#]+)"/g)].map(m=>m[1]).filter(p=>p.startsWith('/')))assert.equal((await fetch(origin+href)).status,200,href);
  }
});

test('hierarchy, revisions, workspace boundaries, normalized collisions and unsafe paths fail closed',()=>{
  const source=fixture();
  for(const path of ['/../secret','/%2e%2e/','/a%2fb','/a\\b','/a?x','/index.html','/con/'])assert.throws(()=>websitePath(path),{code:'invalid_path'});
  assert.equal(websitePath('/PORTFOLIO/'),'/portfolio/');
  for(const mutate of [s=>s.pages.push(page('third','third',{parentId:'about'})),s=>s.pages[1].parentId='about',s=>s.pages[2].workspaceId='other',s=>s.pages.push(page('duplicate','PORTFOLIO')),s=>s.pages[1].slug='galleries',s=>s.pages[1].parentId='home']){const site=structuredClone(source.website);mutate(site);assert.throws(()=>websiteRoutes(site));}
  const wrong=fixture();wrong.documents[0].workspaceId='other';assert.throws(()=>buildWebsiteArtifact(wrong,limits),{code:'foreign_reference'});
});

test('connected mappings preserve exact publication, destination, account and Space identity',()=>{
  const {website,galleries}=fixture(),g=galleries[1];g.destination={destination:{mode:'connected',destinationId:'destination',accountId:'account',spaceId:'space'}};
  const mapping={workspaceId:website.workspaceId,publicationId:g.publicationId,destinationId:'destination',accountId:'account',spaceId:'space',publicUrl:'https://example.com/intended'};
  for(const replacement of [{publicationId:'preview-private'},{accountId:'other'},{spaceId:'other'},{destinationId:'other'},{workspaceId:'other'}])assert.throws(()=>resolveWebsiteGallery(website,g,[{...mapping,...replacement}]),{code:'missing_destination'});
  assert.equal(resolveWebsiteGallery(website,g,[mapping]).href,mapping.publicUrl);
  g.destination.missing='omit';assert.equal(resolveWebsiteGallery(website,g,[]).href,undefined);
  g.destination.missing='fallback';g.destination.fallback={mode:'manual',url:'https://example.com/fallback'};assert.equal(resolveWebsiteGallery(website,g,[]).href,'https://example.com/fallback');
});

test('premium bytes, unclean renditions, signed URLs, future schema and missing assets are rejected',()=>{
  for(const mutate of [s=>s.assets[0].approvedPublic=false,s=>s.assets[0].metadataStripped=false,s=>s.assets[0].bytes[0]=0,s=>s.assets=[],s=>s.galleries[1].destination={destination:{mode:'local'}},s=>s.galleries[1].generateLocal=true,s=>s.website.galleryDefault={destination:{mode:'manual',url:'https://example.com/?token=private'}},s=>s.website.galleryDefault={destination:{mode:'manual',url:'https://example.com/#access_token=private'}},s=>s.apiVersion='99']){const s=fixture();mutate(s);assert.throws(()=>buildWebsiteArtifact(s,limits));}
  const source=fixture();source.website.mediaMode='linked';source.assets[0].publicUrl='https://cdn.example/public.png';const a=buildWebsiteArtifact(source,limits);assert.equal([...a.files.keys()].filter(p=>p.endsWith('.png')).length,0);assert.match(Buffer.from(a.files.get('README.txt')).toString(),/depends/);
  source.assets[0].publicUrl='https://cdn.example/image?X-Amz-Signature=secret';assert.throws(()=>buildWebsiteArtifact(source,limits),{code:'invalid_url'});
});

test('website-specific settings and metadata do not rewrite canonical gallery or page content',()=>{
  const snapshot=fixture(),before=structuredClone(snapshot.galleries);
  snapshot.website.gallerySettings=[{publicationId:'preview-private',title:'Website display title',slug:'custom-display',destination:{destination:{mode:'manual',url:'https://example.com/primary'}},generateLocal:true,canonicalUrl:'https://example.com/canonical'}];
  snapshot.website.theme.settings={colorMode:'light',accentColor:'#225e47',font:'serif',logoAssetId:snapshot.assets[0].id,faviconAssetId:snapshot.assets[0].id};
  snapshot.website.pages[0].seoTitle='Artist portfolio';snapshot.website.pages[0].socialAssetId=snapshot.assets[0].id;
  snapshot.website.navigationLinks=[{label:'External portfolio',url:'https://example.com/public'}];snapshot.website.footerLinks=[{label:'Contact',url:'mailto:artist@example.com'}];
  const output=buildWebsiteArtifact(snapshot,limits),home=Buffer.from(output.files.get('index.html')).toString();
  assert.match(home,/Artist portfolio/);assert.match(home,/og:image/);assert.match(home,/rel="icon"/);assert.match(home,/External portfolio/);
  assert.match(Buffer.from(output.files.get('galleries/custom-display/index.html')).toString(),/https:\/\/example.com\/canonical/);
  assert.deepEqual(snapshot.galleries,before);
  snapshot.website.theme.settings.accentColor='#fafaf9';assert.throws(()=>buildWebsiteArtifact(snapshot,limits),{code:'theme_contrast'});
});

test('standard block matrix is exhaustive and unsupported content never silently vanishes',()=>{
  const base=fixture(),doc=base.documents[0];
  for(const type of Object.keys(STATIC_BLOCK_SUPPORT))assert.equal(parseContentBlocks([block(type)]).length,1,type);
  for(const type of ['unknown_future_block','html_fragment']){const s=fixture();s.documents[0].blocks.push(block(type,{html:'<form>secret</form>'}));assert.throws(()=>buildWebsiteArtifact(s,limits),{code:'unsupported_block'});}
  const s=fixture();s.documents[0].blocks.push(block('embed',{url:'https://example.com'}));assert.throws(()=>buildWebsiteArtifact(s,limits),{code:'unsupported_block'});
  for(const type of ['audio','video','file','pdf_preview']){
    const s=fixture(),media={...s.assets[0],id:'second',mimeType:type==='audio'?'audio/mpeg':type==='video'?'video/mp4':'application/pdf'};s.assets.push(media);s.documents[0].blocks=[block(type,{assetId:media.id,fileId:type==='file'||type==='pdf_preview'?media.id:undefined})];assert.doesNotThrow(()=>buildWebsiteArtifact(s,limits));
  }
  const nested=structuredClone(doc);nested.blocks=[block('paragraph',{children:[block('paragraph')]})];assert.throws(()=>normalizeWebsiteDocument(nested),{code:'unsupported_block'});
});

test('queries paginate deterministically with stable ties, empty states and static update links',()=>{
  const source=fixture(),a=buildWebsiteArtifact(source,limits),b=structuredClone(source);b.galleries.reverse();
  assert.equal(a.digest,buildWebsiteArtifact(b,limits).digest);
  const paginated=[...a.files.keys()].filter(p=>p.startsWith('page/')||p.includes('/page/'));assert.equal(paginated.length,1);
  assert.match(Buffer.from(a.files.get(paginated[0])).toString(),/Page 1/);
  source.documents[0].blocks=[block('gallery_list',{data:{tags:['missing'],emptyMessage:'Nothing published yet.'}})];assert.match(Buffer.from(buildWebsiteArtifact(source,limits).files.get('index.html')).toString(),/Nothing published yet/);
  source.documents[0].blocks=[block('link',{url:'/missing/',label:'Broken'})];assert.throws(()=>buildWebsiteArtifact(source,limits),{code:'broken_link'});
  source.documents[0].blocks=[block('link',{url:'#missing',label:'Broken fragment'})];assert.throws(()=>buildWebsiteArtifact(source,limits),{code:'broken_fragment'});
  assert.throws(()=>buildWebsiteArtifact(fixture(),{...limits,maxBytes:100}),{code:'quota_exceeded'});
});

const harness=async(options={})=>{
  const snapshot=fixture(),store=new SqliteWebsiteStore(':memory:'),actor={workspaceId:snapshot.website.workspaceId,actorId:'owner'};
  let active=true,allowed=true,eligible=true;const events=[],queued=[];
  const service=new WebsiteService({store,creatorIdentityAllowed:async(_actor,id)=>id===snapshot.website.creatorIdentityId,membership:async()=>({workspaceId:actor.workspaceId,userId:actor.actorId,role:options.role??'owner',resourceIds:options.resourceIds,status:active?'active':'removed'}),capabilities:async()=>({apiVersion:'1',export:true,...limits,deploymentAdapters:[]}),resolveSnapshot:async(_a,website)=>({...structuredClone(snapshot),website,documents:await Promise.all(website.pages.map(p=>store.getDocument(actor.workspaceId,p.documentId)))}),evaluateRelease:async()=>({decision:allowed?'allow':'hold',revision:'policy-1',reasons:[]}),dependenciesEligible:async()=>eligible,enqueue:async input=>queued.push(input),audit:async e=>events.push(e),now:()=>new Date('2026-10-19T12:00:00Z')});
  for(const doc of snapshot.documents)await service.saveDocument(actor,doc,0);await service.save(actor,snapshot.website,0);
  return {service,store,snapshot,actor,events,queued,setActive:v=>active=v,setAllowed:v=>allowed=v,setEligible:v=>eligible=v};
};
test('durable build/export lifecycle reauthorizes queued work and immutable candidate downloads',async t=>{
  const h=await harness();t.after(()=>h.store.close());
  const {service,actor,store,snapshot}=h;
  const b=await service.requestBuild(actor,snapshot.website.id,1,'same-key'),same=await service.requestBuild(actor,snapshot.website.id,1,'same-key');assert.equal(b.id,same.id);
  await assert.rejects(service.requestBuild(actor,snapshot.website.id,2,'same-key'),{code:'idempotency_conflict'});
  const ready=await service.execute(actor.workspaceId,b.id);assert.equal(ready.state,'ready');assert.ok(ready.report.checks.includes('internal-links'));
  const downloaded=await service.export(actor,b.id);assert.deepEqual((await service.previewArchive(actor,b.id)).bytes,downloaded.bytes);const again=await service.execute(actor.workspaceId,b.id);assert.equal(downloaded.digest,again.artifactDigest);
  const changed={...snapshot.documents[0],revision:2,blocks:[block('paragraph',{text:'NEW DRAFT ONLY'})]};await service.saveDocument(actor,changed,1);
  assert.ok(!Buffer.from(await service.preview(actor,b.id,'index.html')).toString().includes('NEW DRAFT ONLY'));
  assert.deepEqual((await service.export(actor,b.id)).bytes,downloaded.bytes);
  await assert.rejects(service.saveDocument(actor,changed,1),{code:'revision_conflict'});
  h.setActive(false);await assert.rejects(service.export(actor,b.id),{code:'authorization_denied'});h.setActive(true);
  h.setAllowed(false);await assert.rejects(service.export(actor,b.id),{code:'release_restricted'});h.setAllowed(true);
  h.setEligible(false);await assert.rejects(service.previewArchive(actor,b.id),{code:'dependency_restricted'});await assert.rejects(service.export(actor,b.id),{code:'dependency_restricted'});h.setEligible(true);
  await service.invalidate(actor.workspaceId,{kind:'publication',id:'preview-private'});await assert.rejects(service.export(actor,b.id),{code:'artifact_unavailable'});
  assert.equal(await store.getWebsite('another-workspace',snapshot.website.id),undefined);
  assert.ok(h.events.some(e=>e.action==='website.export'));
});
test('revocation between request and worker dispatch prevents a candidate',async t=>{
  const h=await harness();t.after(()=>h.store.close());const b=await h.service.requestBuild(h.actor,h.snapshot.website.id,1,'revoked');h.setActive(false);
  const failed=await h.service.execute(h.actor.workspaceId,b.id);assert.equal(failed.state,'failed');assert.equal(failed.errorCode,'authorization_denied');assert.equal(failed.artifactDigest,undefined);
});
test('a hold arriving during private artifact retrieval prevents the download',async t=>{
  const h=await harness();t.after(()=>h.store.close());const b=await h.service.requestBuild(h.actor,h.snapshot.website.id,1,'hold-during-load');await h.service.execute(h.actor.workspaceId,b.id);
  const read=h.store.getArtifact.bind(h.store);h.store.getArtifact=async(...args)=>{const bytes=await read(...args);h.setAllowed(false);return bytes;};
  await assert.rejects(h.service.export(h.actor,b.id),{code:'release_restricted'});
});
test('resource-scoped editors can build their selected resources without gaining manager export or unrelated site access',async t=>{
  const options={},h=await harness(options);t.after(()=>h.store.close());
  await h.store.saveWebsite({...h.snapshot.website,id:'unrelated',pages:h.snapshot.website.pages.map(p=>({...p,websiteId:'unrelated'}))},0);
  options.role='editor';options.resourceIds=['site-private',...h.snapshot.documents.map(d=>d.id),...h.snapshot.galleries.map(g=>g.publicationId),...h.snapshot.assets.map(a=>a.id)];
  assert.equal((await h.service.list(h.actor)).length,1);
  assert.ok((await h.service.document(h.actor,h.snapshot.documents[0].id)).sharedBy.every(p=>p.websiteId==='site-private'));
  const b=await h.service.requestBuild(h.actor,h.snapshot.website.id,1,'scoped');assert.equal((await h.service.execute(h.actor.workspaceId,b.id)).state,'ready');
  await assert.rejects(h.service.export(h.actor,b.id),{code:'authorization_denied'});
});
test('full rebuilds remove obsolete files without modifying canonical documents or an older artifact',async t=>{
  const h=await harness();t.after(()=>h.store.close());const a=await h.service.requestBuild(h.actor,h.snapshot.website.id,1,'first');await h.service.execute(h.actor.workspaceId,a.id);
  const old=await h.service.export(h.actor,a.id),current=structuredClone(h.snapshot.website);current.revision=2;current.galleryPublicationIds=[];h.snapshot.galleries=[];h.snapshot.assets=[];
  const doc={...h.snapshot.documents[0],revision:2,blocks:[block('paragraph',{text:'Simple public site'})]};await h.service.saveDocument(h.actor,doc,1);await h.service.save(h.actor,current,1);
  const b=await h.service.requestBuild(h.actor,current.id,2,'second');assert.equal((await h.service.execute(h.actor.workspaceId,b.id)).state,'ready');
  const next=unzip(Buffer.from((await h.service.export(h.actor,b.id)).bytes));assert.ok(!next.has('galleries/autumn/index.html'));assert.ok(unzip(Buffer.from(old.bytes)).has('galleries/autumn/index.html'));assert.equal((await h.service.document(h.actor,doc.id)).document.revision,2);
});

test('a Galleries landing page coexists with generated galleries while nested authored routes remain reserved',()=>{
 const snapshot=fixture();
 snapshot.website.pages.push(page('galleries','galleries',{kind:'portfolio'}));
 snapshot.documents.push({id:'doc-galleries',workspaceId:snapshot.website.workspaceId,revision:1,blocks:[block('gallery_list')]});
 assert.equal(websiteRoutes(snapshot.website).get('galleries'),'/galleries/');
 const artifact=buildWebsiteArtifact(snapshot,limits);
 assert.ok(artifact.files.has('galleries/index.html'));
 assert.ok(artifact.files.has('galleries/autumn/index.html'));
 snapshot.website.pages.push(page('nested','nested',{parentId:'galleries'}));
 assert.throws(()=>websiteRoutes(snapshot.website),/reserved/);
});

test('website removal is revision checked, blocks retained builds, and cannot be undone by stale saves',async t=>{
 const h=await harness();t.after(()=>h.store.close());
 const {service,actor,snapshot,store}=h,site=snapshot.website;
 const b=await service.requestBuild(actor,site.id,1,'delete');await service.execute(actor.workspaceId,b.id);
 await assert.rejects(service.remove(actor,site.id,2),{code:'revision_conflict'});
 await assert.rejects(service.save(actor,{...site,revision:2,deletedAt:'now'},1),{code:'invalid_website'});
 await service.remove(actor,site.id,1);
 assert.deepEqual(await service.list(actor),[]);
 await assert.rejects(service.export(actor,b.id),{code:'website_not_found'});
 await assert.rejects(service.preview(actor,b.id,'index.html'),{code:'website_not_found'});
 await assert.rejects(service.save(actor,{...site,revision:3},2),{code:'revision_conflict'});
 assert.equal((await store.listWorkspaceBuilds(actor.workspaceId)).length,1);
 assert.ok(await store.getDocument(actor.workspaceId,site.pages[0].documentId));
 const editor=await harness({role:'editor'});t.after(()=>editor.store.close());
 await assert.rejects(editor.service.remove(editor.actor,editor.snapshot.website.id,1),{code:'authorization_denied'});
});

test('page designs bundle cover/background images and every theme supports light, dark and system exports',()=>{
 for(const theme of ['neutral','ink','ocean','plum'])for(const mode of ['light','dark','system']){
  const snapshot=fixture();snapshot.website.theme={id:theme,version:'1',settings:{colorMode:mode,headerLayout:'split',footerLayout:'centered',logoAssetId:snapshot.assets[0].id}};
  Object.assign(snapshot.website.pages[0],{template:'cover',coverAssetId:snapshot.assets[0].id,backgroundAssetId:snapshot.assets[0].id,coverPosition:{x:.2,y:.8}});
  const output=buildWebsiteArtifact(snapshot,limits),html=Buffer.from(output.files.get('index.html')).toString(),css=Buffer.from(output.files.get('assets/theme.css')).toString();
  assert.match(html,/template-cover/);assert.match(html,/page-cover/);assert.match(html,/page-background/);assert.match(html,/image-position-20-80/);assert.match(css,/object-position:20% 80%/);assert.match(html,/site-header split/);assert.match(html,/site-footer centered/);
  assert.match(html,/<details class="nav-dropdown"><summary>portfolio/);assert.match(html,/aria-label="Footer"/);assert.match(css,/prefers-color-scheme:dark/);assert.match(css,/nav details\[open\]/);
  assert.ok([...output.files.keys()].some(path=>path.startsWith('assets/')&&path.endsWith('.png')));
 }
 const centered=fixture();centered.website.theme.settings={headerLayout:'centered',logoAssetId:centered.assets[0].id};
 const html=Buffer.from(buildWebsiteArtifact(centered,limits).files.get('index.html')).toString();assert.match(html,/site-header centered/);assert.doesNotMatch(html,/class="site-logo"/);
 for(const patch of [{template:'unsafe'},{coverPosition:{x:2,y:.5}},{backgroundAssetId:'../secret'}]){const invalid=fixture();Object.assign(invalid.website.pages[0],patch);assert.throws(()=>websiteRoutes(invalid.website));}
});

test('menu order and dropdown levels are independent of routes and other menus',()=>{
 const snapshot=fixture(),site=snapshot.website;
 const home=site.pages[0],portfolio=site.pages[1],about=site.pages[2];
 site.pages=site.pages.filter(page=>page.kind!=='update');
 home.navigationOrder=2;portfolio.navigationOrder=1;about.navigationOrder=0;
 about.navigationParentId=null;portfolio.navigationParentId='about';
 for(const page of site.pages){page.footerNavigation=true;page.footerNavigationParentId=null;}
 home.footerNavigationOrder=0;portfolio.footerNavigationOrder=1;about.footerNavigationOrder=2;
 const routes=websiteRoutes(site);assert.equal(routes.get('about'),'/portfolio/about/');
 const artifact=buildWebsiteArtifact(snapshot,limits),html=Buffer.from(artifact.files.get('index.html')).toString();
 const top=html.split('</header>')[0],footer=html.split('<footer')[1];
 assert.match(top,/<summary>about<\/summary>/);assert.ok(top.indexOf('<summary>about')<top.indexOf('>Home</a>'));
 assert.doesNotMatch(footer,/nav-dropdown/);assert.ok(footer.indexOf('>Home</a>')<footer.indexOf('>portfolio</a>'));
 home.navigationParentId='portfolio';assert.throws(()=>websiteRoutes(site),{code:'invalid_navigation'});
 home.navigationParentId=null;about.navigationParentId='portfolio';assert.throws(()=>websiteRoutes(site),{code:'invalid_navigation'});
 about.navigationParentId=null;portfolio.navigationParentId='missing';assert.throws(()=>websiteRoutes(site),{code:'invalid_navigation'});
});

test('public promotion overrides preserve exact links and never enable local premium originals',()=>{
 const snapshot=fixture(),premium=snapshot.galleries.find(g=>g.premium),asset=snapshot.assets[0];
 snapshot.website.gallerySettings=[{publicationId:premium.publicationId,description:'An approved public teaser',previewAssetId:asset.id,destination:{destination:{mode:'connected',destinationId:'tumblr',accountId:'blog-a'}}}];
 snapshot.mappings=[{publicationId:premium.publicationId,workspaceId:snapshot.website.workspaceId,destinationId:'tumblr',accountId:'blog-a',publicUrl:'https://artist.tumblr.com/post/123'}];
 const html=Buffer.from(buildWebsiteArtifact(snapshot,limits).files.get('index.html')).toString();assert.match(html,/An approved public teaser/);assert.match(html,/https:\/\/artist.tumblr.com\/post\/123/);
 snapshot.website.gallerySettings[0].destination.destination.accountId='blog-b';assert.throws(()=>buildWebsiteArtifact(snapshot,limits),e=>e.code==='missing_destination');
 snapshot.website.gallerySettings[0].destination={destination:{mode:'local'}};assert.throws(()=>buildWebsiteArtifact(snapshot,limits),e=>e.code==='local_not_public');
 snapshot.website.gallerySettings[0].description='a'.repeat(5001);assert.throws(()=>buildWebsiteArtifact(snapshot,limits),e=>e.code==='invalid_gallery');
});

test('only generated platform signup forms pass static validation, including subpath builds',async()=>{
 const f=fixture('/artist/');f.website.theme.settings.mailingListUrl='https://platform.example/mailing/creator';f.documents[0].blocks.push(block('link',{id:'mailing-signup',label:'Subscribe',data:{action:'mailing'}}));f.mailingList={signupUrl:f.website.theme.settings.mailingListUrl,submitUrl:'https://api.example/public/mailing-list/creator/subscribe-form',consentText:'Receive letters. Unsubscribe any time.',offers:[]};
 const built=buildWebsiteArtifact(f,limits);const html=Buffer.from(built.files.get('index.html')).toString();assert.match(html,/<form/);
 const {validateWebsiteFiles}=await import('../dist/website-artifact.js');
 for(const invalid of ['<form action="https://evil.example" method="post"></form>','<form data-website-mailing="true" method="post" action="https://evil.example/steal"></form>'])assert.throws(()=>validateWebsiteFiles(f.website,new Map([['index.html',new TextEncoder().encode(invalid)]])),/signup|submission/);
});
