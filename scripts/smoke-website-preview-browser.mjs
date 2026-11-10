/** Real Chromium, loopback-only private preview of 1000 distinct metadata-clean JPEGs.
 * Exercises the actual WebsiteClient, cross-tab broker, sandbox and file service. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {build} from 'esbuild';
import sharp from 'sharp';
import {SqliteWebsiteStore} from '../adapters/local/dist/index.js';
import {WebsiteService,websiteDigest} from '../packages/portability/dist/index.js';
import {handleWebsiteRequest} from '../apps/reference-api/dist/websites.js';
import {websitePreviewFixture} from './website-preview-fixture.mjs';

const assets=[];
for(let index=0;index<1000;index++){
 const raw=Buffer.alloc(64*48*3,40);
 for(let bit=0;bit<10;bit++)if(index&(1<<bit))for(let y=0;y<12;y++)for(let x=0;x<8;x++)raw.fill(240,((Math.floor(bit/5)*20+y)*64+(bit%5)*12+x)*3,((Math.floor(bit/5)*20+y)*64+(bit%5)*12+x)*3+3);
 const bytes=await sharp(raw,{raw:{width:64,height:48,channels:3}}).jpeg().toBuffer();
 assets.push({id:'image-'+index,workspaceId:'workspace',revision:1,checksum:websiteDigest(bytes),mimeType:'image/jpeg',bytes,alt:'Image '+index,width:640,height:480,approvedPublic:true,metadataStripped:true});
}
assert.equal(new Set(assets.map(asset=>asset.checksum)).size,1000);
const snapshot=websitePreviewFixture(assets),store=new SqliteWebsiteStore(':memory:'),actor={workspaceId:'workspace',actorId:'owner'};let allowed=true;
const pdf=Buffer.alloc(33*1024*1024,32);pdf.write('%PDF-1.4\n');
snapshot.assets=[...assets,{id:'large-pdf',workspaceId:'workspace',revision:1,checksum:websiteDigest(pdf),mimeType:'application/pdf',bytes:pdf,approvedPublic:true,metadataStripped:true}];
snapshot.documents[0].blocks.push({id:'large-download',type:'file',fileId:'large-pdf',text:'Large PDF'});
const service=new WebsiteService({store,membership:async()=>({workspaceId:'workspace',userId:'owner',role:'owner',status:'active'}),creatorIdentityAllowed:async()=>true,capabilities:async()=>({apiVersion:'1',export:true,maxPages:200,maxAssets:2000,maxBytes:256*1024*1024,deploymentAdapters:[]}),resolveSnapshot:async()=>snapshot,evaluateRelease:async()=>({decision:allowed?'allow':'hold',revision:'policy-1',reasons:[]}),dependenciesEligible:async()=>allowed,enqueue:async()=>{},audit:async()=>{}});
for(const document of snapshot.documents)await store.saveDocument(document,0);await store.saveWebsite(snapshot.website,0);
const requested=await service.requestBuild(actor,'site',1,'browser'),ready=await service.execute('workspace',requested.id);assert.equal(ready.state,'ready');
const manifest=await service.previewManifest(actor,ready.id),galleryPage=Object.keys(manifest.files).find(path=>path.includes('/photos/all/')&&path.endsWith('index.html'));assert.ok(galleryPage);
store.getArtifact=async()=>assert.fail('Browser preview downloaded the archive');
let transferredMedia=0,mediaReads=0;const pathsRead=new Set(),read=service.previewFiles.bind(service);
let rangeReads=0,rangeBytes=0;const readRange=service.previewFileRange.bind(service);
service.previewFileRange=async(...args)=>{const result=await readRange(...args);rangeReads++;rangeBytes+=result.bytes.length;assert.ok(result.bytes.length<=2*1024*1024);return result;};
service.previewFiles=async(...args)=>{const result=await read(...args);for(const file of result.files){pathsRead.add(file.path);if(/\.(jpg|png)$/.test(file.path)){mediaReads++;transferredMedia+=file.bytes?.length??0;}}return result;};
const bundled=await build({stdin:{contents:"import {openWebsitePreview} from './packages/ui/src/website-workspace.ts';import {WebsiteClient} from './packages/ui/src/website-client.ts';const client=new WebsiteClient('site',()=> 'fixture-bearer','/v1/websites');document.getElementById('open').onclick=()=>{const popup=window.open('about:blank');window.previewError='';openWebsitePreview(client,popup,location.href).catch(error=>window.previewError=error.message);};",resolveDir:process.cwd()},bundle:true,minify:true,platform:'browser',write:false,format:'iife'});
const server=createServer(async(request,response)=>{
 try{
  const url=new URL(request.url,'http://local');response.setHeader('cache-control','private, no-store');
  if(url.pathname==='/'){response.setHeader('content-type','text/html');response.end('<!doctype html><title>Private preview fixture</title><button id="open">Open preview</button><script src="/client.js"></script>');return;}
  if(url.pathname==='/client.js'){response.setHeader('content-type','text/javascript');response.end(bundled.outputFiles[0].contents);return;}
  if(request.headers.authorization!=='Bearer fixture-bearer'){response.writeHead(401).end();return;}
  const result=await handleWebsiteRequest({service,actor,request,response,url,body:async()=>{let body='';for await(const chunk of request)body+=chunk;return JSON.parse(body||'{}');}});
  if(!response.writableEnded){response.setHeader('content-type','application/json');response.end(JSON.stringify(result));}
 }catch(error){response.writeHead(400,{'content-type':'application/json'}).end(JSON.stringify({error:{message:error.message}}));}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
const profile=mkdtempSync(join(tmpdir(),'website-preview-chromium-'));
const browser=spawn(process.env.CHROMIUM_PATH??'/usr/bin/chromium',['--headless','--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-first-run','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{stdio:['ignore','ignore','pipe']});
let socket;
try{
 const endpoint=await new Promise((resolve,reject)=>{let stderr='';const timer=setTimeout(()=>reject(Error('Chromium startup timed out')),15000);browser.stderr.on('data',chunk=>{stderr+=chunk;const match=stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(match){clearTimeout(timer);resolve(match[1]);}});browser.on('error',reject);});
 socket=new WebSocket(endpoint);await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
 let sequence=0;const waiting=new Map(),exceptions=[],frameSessions=new Map(),enabledFrames=new Set(),sessionTargets=new Map();
 socket.onmessage=event=>{const message=JSON.parse(event.data);if(message.id){const pending=waiting.get(message.id);if(!pending)return;waiting.delete(message.id);clearTimeout(pending.timer);message.error?pending.reject(Error(JSON.stringify(message.error))):pending.resolve(message.result);}else if(message.method==='Runtime.exceptionThrown')exceptions.push(message.params.exceptionDetails.exception?.description??message.params.exceptionDetails.text);
  else if(message.method==='Target.attachedToTarget'&&message.params.targetInfo.type==='iframe'){frameSessions.set(message.params.sessionId,{parent:message.sessionId,parentTarget:message.params.targetInfo.parentId,url:message.params.targetInfo.url});}
  else if(message.method==='Target.detachedFromTarget')frameSessions.delete(message.params.sessionId);
 };
 const send=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{waiting.delete(id);reject(Error('CDP timeout: '+method));},15000);waiting.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));});
 await send('Browser.setDownloadBehavior',{behavior:'deny'});
 const attach=async targetId=>{const {sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});sessionTargets.set(sessionId,targetId);await send('Page.enable',{},sessionId);await send('Runtime.enable',{},sessionId);return sessionId;};
 const evaluate=async(sessionId,expression,contextId)=>{const result=await send('Runtime.evaluate',{expression,contextId,awaitPromise:true,returnByValue:true,userGesture:true},sessionId);if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description??result.exceptionDetails.text);return result.result.value;};
 const wait=async condition=>{const deadline=Date.now()+15000;let last;while(Date.now()<deadline){try{if(await condition())return;}catch(error){last=error;}await new Promise(resolve=>setTimeout(resolve,50));}throw Error('Preview DOM condition timed out'+(last?': '+last.message:''));};
 const frameEvaluate=async(sessionId,expression)=>{
  // Opaque srcdoc frames can move out of process after document.open(). Discover
  // the current child target rather than relying on the original frame tree.
  const target=(await send('Target.getTargets')).targetInfos.find(target=>target.type==='iframe'&&target.parentId===sessionTargets.get(sessionId)&&target.url==='about:srcdoc');
  if(target){const known=[...sessionTargets].find(([,id])=>id===target.targetId),child=known?.[0]??await attach(target.targetId);return evaluate(child,expression);}
  const remote=[...frameSessions].find(([,frame])=>(frame.parent===sessionId||frame.parentTarget===sessionTargets.get(sessionId))&&frame.url==='about:srcdoc');
  if(remote){if(!enabledFrames.has(remote[0])){await send('Runtime.enable',{},remote[0]);enabledFrames.add(remote[0]);}return evaluate(remote[0],expression);}
  const tree=await send('Page.getFrameTree',{},sessionId),frame=tree.frameTree.childFrames?.find(child=>child.frame.url==='about:srcdoc')?.frame;if(!frame)throw Error('Sandbox is not ready');const {executionContextId}=await send('Page.createIsolatedWorld',{frameId:frame.id,worldName:'preview-smoke'},sessionId);return evaluate(sessionId,expression,executionContextId);
 };
 const {targetId}=await send('Target.createTarget',{url:origin}),editor=await attach(targetId);
 await wait(()=>evaluate(editor,"typeof document.querySelector('#open')?.onclick==='function'"));
 const open=async()=>{const before=new Set((await send('Target.getTargets')).targetInfos.map(target=>target.targetId));await evaluate(editor,"document.getElementById('open').click()");let target;
  await wait(async()=>{const error=await evaluate(editor,'window.previewError');assert.ok(!error,error);target=(await send('Target.getTargets')).targetInfos.find(candidate=>candidate.type==='page'&&!before.has(candidate.targetId));return target;});
  const session=await attach(target.targetId);await send('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:false,flatten:true},session);try{await wait(()=>frameEvaluate(session,"!!document.querySelector('h1')&&[...document.images].some(image=>image.naturalWidth>0)"));}catch(error){throw Error(error.message+' '+JSON.stringify({editorError:await evaluate(editor,'window.previewError'),inner:await frameEvaluate(session,"JSON.stringify({title:document.title,heading:document.querySelector('h1')?.textContent,images:[...document.images].filter(image=>image.hasAttribute('src')).map(image=>({src:image.src,naturalWidth:image.naturalWidth,complete:image.complete,top:image.getBoundingClientRect().top})).slice(0,10)})"),mediaReads,pathsRead:[...pathsRead],frameSessions:[...frameSessions],targets:await send('Target.getTargets'),exceptions}));}return session;
 };
 const preview=await open();
 assert.ok(mediaReads<20,'initial preview fetched too many images');assert.equal(pathsRead.has('about/index.html'),false);
 await frameEvaluate(preview,`(()=>{const create=URL.createObjectURL.bind(URL);URL.createObjectURL=blob=>{if(blob.size===${pdf.length})window.largePreviewLoaded=true;return create(blob);};document.querySelector('a[data-preview-download$=".pdf"]').click();})()`);
 await wait(()=>frameEvaluate(preview,'window.largePreviewLoaded===true'));
 assert.equal(rangeReads,17);assert.equal(rangeBytes,pdf.length);
 await frameEvaluate(preview,"document.querySelector('[data-gallery-open]').click()");
 await wait(()=>frameEvaluate(preview,"document.querySelector('dialog').open&&document.querySelector('[data-viewer-image]').naturalWidth>0"));
 await frameEvaluate(preview,"document.querySelector('[data-action=next]').click()");
 await wait(()=>frameEvaluate(preview,"document.querySelector('[data-image-counter]').textContent.startsWith('2 /')&&document.querySelector('[data-viewer-image]').naturalWidth>0"));
 assert.ok(pathsRead.has('assets/'+assets[1].checksum+'.jpg'),'gallery full image did not load on demand');
 await frameEvaluate(preview,"document.querySelector('[data-action=close]').click();document.querySelector('a[data-preview-page=\"about/index.html\"]').click()");
 await wait(()=>frameEvaluate(preview,"document.querySelector('h1')?.textContent==='About this website'&&[...document.images].some(image=>image.naturalWidth>0)"));
 assert.ok(pathsRead.has('about/index.html'));assert.ok(pathsRead.has('assets/'+assets.at(-1).checksum+'.jpg'));
 await evaluate(preview,'location.hash='+JSON.stringify('#'+new URLSearchParams({page:galleryPage})));
 await wait(()=>frameEvaluate(preview,"document.querySelectorAll('.website-gallery-tile').length===1000&&[...document.images].some(image=>image.naturalWidth>0)"));
 assert.ok(mediaReads<100,'opening the gallery fetched all media');
 const transferredBefore=transferredMedia;await open();assert.equal(transferredMedia,transferredBefore,'reopening preview retransferred a cached cover');
 allowed=false;await send('Page.bringToFront',{},preview);await frameEvaluate(preview,"document.querySelectorAll('.website-gallery-tile').item(500).scrollIntoView()");
 await wait(()=>evaluate(preview,"!!document.getElementById('website-preview-file-error')"));
 assert.deepEqual(exceptions,[]);
 console.log(JSON.stringify({images:assets.length,artifactFiles:Object.keys(manifest.files).length,mediaReads,mediaBytesTransferred:transferredMedia,rangeReads,rangeBytes,archiveReads:0,checks:['lazy images','33 MiB PDF in 2 MiB chunks','gallery viewer','page navigation','conditional cache reuse','revocation','opaque sandbox']},null,2));
}finally{socket?.close();browser.kill('SIGKILL');await new Promise(resolve=>server.close(resolve));store.close();await new Promise(resolve=>setTimeout(resolve,100));rmSync(profile,{recursive:true,force:true});}
