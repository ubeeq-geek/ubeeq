import test from 'node:test';
import assert from 'node:assert/strict';
import {openWebsitePreview,disposeWebsitePreviewNamespace} from '../dist/website-workspace.js';
import {saveWebsitePreview} from '../dist/website-preview.js';
import {createWebsiteZip} from '@ubeeq/portability';

const website={id:'site',workspaceId:'workspace',creatorIdentityId:'creator',revision:1,title:'Website',locale:'en',homePageId:'home',theme:{id:'neutral',version:'1',settings:{}},galleryDefault:{destination:{mode:'local'}},mediaMode:'bundled',basePath:'/',pages:[{id:'home',websiteId:'site',workspaceId:'workspace',revision:1,documentId:'doc',kind:'home',title:'Home',slug:'',order:0,state:'ready',navigation:true}],galleryPublicationIds:[],redirects:[]};
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const archive=new Blob([createWebsiteZip(new Map([['index.html',new TextEncoder().encode('<h1>Complete private draft</h1>')]]))]);
const client=get=>({get,builds:async()=>[{id:'build',state:'ready',websiteRevision:1,stale:false}],build:async()=>({id:'build',state:'ready',stale:false}),requestBuild:async()=>assert.fail('Saved build already exists'),previewSite:async()=>archive});
const popup=()=>{const writes=[],navigations=[];return{writes,navigations,closed:false,close(){this.closed=true;},location:{replace:url=>navigations.push(url)},document:{body:{textContent:''},open(){},write:html=>writes.push(html),close(){},getElementById(){return{textContent:''};}}};};
function browser(t){const old={window:globalThis.window,BroadcastChannel:globalThis.BroadcastChannel,indexedDB:globalThis.indexedDB},channels=[];globalThis.window={};globalThis.BroadcastChannel=class{constructor(key){this.key=key;this.closed=false;channels.push(this);}postMessage(){}close(){this.closed=true;}};globalThis.indexedDB={open(){assert.fail('A disposed opening must never reach persistent preview storage.');}};t.after(()=>{disposeWebsitePreviewNamespace('pending-editor');for(const[key,value]of Object.entries(old)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}});return channels;}

test('namespace disposal prevents a deferred opening from recreating a broker, caching or navigating the old popup',async t=>{
 const channels=browser(t),gate=deferred(),old=popup(),pending=openWebsitePreview(client(()=>gate.promise),old,'https://frontend.test/editor',undefined,'/preview.html',{namespace:'pending-editor'});
 disposeWebsitePreviewNamespace('pending-editor');assert.equal(old.closed,true);gate.resolve(website);await assert.rejects(pending,/closed|no longer active/i);assert.equal(channels.length,0);assert.equal(old.navigations.length,0);assert.equal(old.writes.length,1,'only the initial non-sensitive loading document was written');
 // A new editor with the same verified namespace can create its own lifetime.
 const next=popup();assert.equal(await openWebsitePreview(client(async()=>website),next,'https://frontend.test/editor',undefined,undefined,{namespace:'pending-editor'}),'build');assert.equal(next.writes.length,2);assert.ok(channels.some(channel=>!channel.closed));
});

test('a destroyed editor signal also fences deferred legacy unscoped previews',async t=>{
 const channels=browser(t),gate=deferred(),controller=new AbortController(),old=popup(),pending=openWebsitePreview(client(()=>gate.promise),old,'https://frontend.test/editor',undefined,undefined,undefined,controller.signal);controller.abort();gate.resolve(website);await assert.rejects(pending,/closed|no longer active/i);assert.equal(old.closed,true);assert.equal(channels.length,0);assert.equal(old.writes.length,1);
});

test('cancelling a pending preview cache transaction leaves no committed draft',async t=>{
 const previous=globalThis.indexedDB,controller=new AbortController(),committed=new Map(),staged=new Map();let transaction,commit,closed=false;
 globalThis.indexedDB={open(){const request={};queueMicrotask(()=>{request.result={transaction(){let aborted=false;transaction={abort(){aborted=true;staged.clear();queueMicrotask(()=>transaction.onabort?.());},objectStore(){return{openCursor(){const cursor={result:null};queueMicrotask(()=>cursor.onsuccess?.());return cursor;},delete(){},put(value){staged.set(value.id,value);commit=()=>{if(aborted)return;for(const[key,row]of staged)committed.set(key,row);transaction.oncomplete?.();};}};}};return transaction;},close(){closed=true;}};request.onsuccess?.();});return request;}};
 t.after(()=>{if(previous===undefined)delete globalThis.indexedDB;else globalThis.indexedDB=previous;});
 const pending=saveWebsitePreview('<trusted private draft>',{namespace:'pending-editor'},controller.signal);while(!commit)await tick();controller.abort();await assert.rejects(pending,/no longer active/);commit();assert.equal(committed.size,0);assert.equal(staged.size,0);assert.equal(closed,true);
});
