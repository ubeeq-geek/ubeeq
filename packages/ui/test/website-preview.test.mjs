import test from 'node:test';
import assert from 'node:assert/strict';
import {createWebsiteZip} from '@ubeeq/portability';
import {readWebsitePreviewArchive,websitePreviewHtml} from '../dist/website-preview.js';
test('complete previews preserve pages and binary assets once in a bounded archive',async()=>{
 const source=new Map([['index.html',new TextEncoder().encode('<h1>Home</h1>')],['about/index.html',new TextEncoder().encode('<h1>About</h1>')],['assets/image.png',new Uint8Array([0,255,1,128])]]);
 const files=await readWebsitePreviewArchive(new Blob([createWebsiteZip(source)]));
 assert.equal(atob(files['about/index.html']),'<h1>About</h1>');assert.deepEqual(Uint8Array.from(atob(files['assets/image.png']),c=>c.charCodeAt(0)),source.get('assets/image.png'));
 const html=websitePreviewHtml(files,'about/index.html');assert.match(html,/website-preview.navigate/);assert.doesNotMatch(html,/allow-same-origin/);assert.match(html,/script-src 'nonce-/);assert.match(html,/connect-src 'none'/);
 assert.throws(()=>websitePreviewHtml(files,'missing.html'));
 await assert.rejects(readWebsitePreviewArchive(new Blob(['not a zip'])));
 const unsafe=Buffer.from(createWebsiteZip(new Map([['index.html',new Uint8Array()],['safeimg.html',new Uint8Array()]])));unsafe.write('../evil.html',unsafe.indexOf('safeimg.html'));
 await assert.rejects(readWebsitePreviewArchive(new Blob([unsafe])));
});

test('queued previews wait automatically and report failed builds without fetching an archive',async()=>{
 const {openWebsitePreview}=await import('../dist/website-workspace.js');
 const site={id:'site',workspaceId:'workspace',creatorIdentityId:'creator',revision:1,title:'Website',locale:'en',homePageId:'home',theme:{id:'neutral',version:'1',settings:{}},galleryDefault:{destination:{mode:'local'}},mediaMode:'bundled',basePath:'/',pages:[{id:'home',websiteId:'site',workspaceId:'workspace',revision:1,documentId:'doc',kind:'home',title:'Home',slug:'',order:0,state:'ready',navigation:true}],galleryPublicationIds:[],redirects:[]};
 let polls=0,archiveCalls=0,output='';const statuses=[],writes=[];const popup={closed:false,document:{title:'',body:{textContent:''},open(){},getElementById(){return {set textContent(value){statuses.push(value);}};},write(value){output=value;writes.push(value);},close(){}}};
 const client={get:async()=>site,builds:async()=>[],requestBuild:async()=>({id:'queued',state:'queued'}),build:async()=>({state:++polls<2?'rendering':'ready',stale:false}),previewSite:async()=>{archiveCalls++;return new Blob([createWebsiteZip(new Map([['index.html',new TextEncoder().encode('<h1>Ready</h1>')]]))]);}};
 assert.equal(await openWebsitePreview(client,popup,'https://example.com/'),'queued');assert.equal(archiveCalls,1);assert.match(output,/website-preview.navigate/);assert.ok(polls>=2);assert.match(writes[0],/website-preview-spinner/);assert.match(writes[0],/aria-busy="true"/);assert.ok(statuses.includes('Loading your preview…'));assert.match(output,/addEventListener\('load'/);
 archiveCalls=0;client.build=async()=>({state:'failed',errorCode:'storage_limit_reached'});await assert.rejects(openWebsitePreview(client,popup,'https://example.com/'),/storage_limit_reached/);assert.equal(archiveCalls,0);assert.match(popup.document.body.textContent,/could not be prepared/);
});
