import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {Readable} from 'node:stream';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MemoryCreatorContentStore} from '@ubeeq/persistence';
import {createLocalAdapterSet,installSqliteRetainedContentAtomic} from '@ubeeq/adapter-local';
import {defaultContentPreparation} from '@ubeeq/core';
import {ContentWorkflowService,ContentPreparationError} from '../dist/content-preparations.js';
import {registerContentPreparationRoutes} from '../dist/content-preparation-http.js';
import {createContentPreparationNodeHandler} from '../dist/content-preparation-node.js';
import {createCoreRuntime} from '../dist/index.js';

// Explicit test host: rich records and command receipts share the real SQLite
// coordinator. It does not provide collection assembly or external publication.
class FixtureStore extends MemoryCreatorContentStore {
 creators=[{creatorId:'creator',status:'active',owner:'owner'}];
 async getCreatorById(id){return this.creators.find(row=>row.creatorId===id)??null;}
 async listCreators(){return this.creators;}
 async getAnnouncementOrchestration(){return null;}
}
const unsupported=()=>{throw new ContentPreparationError('unsupported_operation','No release provider is configured in this transport fixture.',503);};
function fixtureHost(store,actor){
 const access=async id=>(await store.getCreatorById(id))?.owner===actor;
 return {authorizeCreator:access,canManageCollections:access,
  recoveryAuthorization:savedActor=>fixtureHost(store,savedActor),
  defaultSettings:()=>({...defaultContentPreparation(),access:'private'}),
  inspectOriginal:unsupported,captureSetup:unsupported,contentMetadataWork:unsupported,
  validateCollectionVolumes:unsupported,resolvedCollectionMembers:unsupported,recordImageCompatibility:unsupported};
}
function bindingsFor(store){
 return {access:async(req,_res,id)=>fixtureHost(store,req.session.subject.id).authorizeCreator(id),
  createService:req=>new ContentWorkflowService(store,{tenantId:'tenant'},fixtureHost(store,req.session.subject.id)),
  createRelease:unsupported,enabled:()=>true,durableDrafts:()=>store.publicationAtomic.supportsConditionalTransactions,
  offerings:async()=>[],announcementDestinations:async()=>[],destinations:async()=>[],managementUrl:id=>'/works?creator='+encodeURIComponent(id)};
}
const session=(id='owner')=>({subject:{id,roles:['creator_operator'],accountScope:'creator_operator'},expiresAt:new Date(Date.now()+60_000).toISOString()});
async function fixture(t,options={}){
 const directory=await mkdtemp(join(tmpdir(),'preparation-http-')),path=join(directory,'state.sqlite');
 let store,atomic;
 const open=()=>{store=new FixtureStore();atomic=installSqliteRetainedContentAtomic(store,path,{fields:['creators','works','canonicalAssets','workAssets','publications','publicationIntents','creatorCollections','collectionWorks','workDiscovery'],savePublication:p=>store.upsertPublication(p)});};open();
 let enabled=true,created=0,authenticated=0;
 let bindings;
 const buildHandler=()=>{
  bindings={...bindingsFor(store),enabled:()=>enabled,...options.bindings};
  const service=bindings.createService;bindings.createService=(...args)=>{created++;return service(...args);};
  return createContentPreparationNodeHandler(bindings,async req=>{authenticated++;if(req.headers.authorization!=='Bearer verified')throw new ContentPreparationError('authentication_invalid','Verified session required.',401);return options.session??session();},{publicBaseUrl:'http://localhost',...options.transport});
 };
 let handler=buildHandler();
 const server=createServer(async(req,res)=>{try{if(!await handler.handle(req,res)){res.statusCode=404;res.end();}}catch{res.statusCode=500;res.end();}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));handler.close();atomic.close();await rm(directory,{recursive:true,force:true});});
 const request=async(path,method='GET',body,headers={})=>{
  const response=await fetch('http://127.0.0.1:'+server.address().port+path,{method,headers:{authorization:'Bearer verified','content-type':'application/json',...headers},...(body===undefined?{}:{body:typeof body==='string'?body:JSON.stringify(body)})});
  const bytes=Buffer.from(await response.arrayBuffer());let value;try{value=JSON.parse(bytes);}catch{}
  return {status:response.status,body:value,bytes,headers:response.headers};
 };
 return {request,get handler(){return handler;},get bindings(){return bindings;},get store(){return store;},get created(){return created;},get authenticated(){return authenticated;},disable:()=>{enabled=false;},
  restart:()=>{handler.close();atomic.close();open();handler=buildHandler();}};
}
const base='/studio/content';
const url=(path,creator='creator')=>base+path+'?creatorId='+encodeURIComponent(creator);

test('shared Node HTTP persists authored content, resumes after restart and fences stale or foreign mutations',async t=>{
 const f=await fixture(t);
 let result=await f.request(url('/workflows'),'POST',{operationId:'begin',entry:{intent:'work'}});assert.equal(result.status,200);let draft=result.body;
 assert.equal(draft.actorId,'owner');
 result=await f.request(url(`/workflows/${draft.id}/objects`),'POST',{expectedRevision:draft.revision,operationId:'write',object:{media:'article',title:'Retained article',text:'Original content'}});assert.equal(result.status,200);draft=result.body;
 const input={expectedRevision:draft.revision,operationId:'save'};
 result=await f.request(url(`/workflows/${draft.id}/save`),'POST',input);assert.equal(result.status,200);const saved=result.body;
 assert.equal(f.store.works.length,1);assert.equal(f.store.works[0].body[0].text,'Original content');
 f.restart();
 result=await f.request(url(`/workflows/${draft.id}/save`),'POST',input);assert.equal(result.status,200);assert.deepEqual(result.body,saved);assert.equal(f.store.works.length,1);
 assert.equal((await f.request(url(`/workflows/${draft.id}`),'PATCH',{expectedRevision:draft.revision,operationId:'stale',patch:{title:'Lost edit'}})).status,409);
 assert.equal((await f.request(url(`/workflows/${draft.id}`,'other'))).status,403);
 assert.equal((await f.request('/api'+url(`/workflows/${draft.id}`))).body.draft.id,draft.id);
 assert.equal((await f.request(url('/workflows'))).body.items.length,1);
});

test('authentication precedes body reads and service construction; caller identity hints have no authority',async t=>{
 const f=await fixture(t);
 for(const headers of [{authorization:''},{authorization:'Bearer unsigned','x-user-id':'owner'}])assert.equal((await f.request(url('/workflows'),'POST','{invalid',headers)).status,401);
 assert.equal(f.created,0);
 let read=false;const request=new Readable({read(){read=true;throw Error('Unauthenticated body was consumed');}});request.url=url('/workflows');request.method='POST';request.headers={};
 const response={headersSent:false,setHeader(){},end(){},statusCode:200};
 assert.equal(await f.handler.handle(request,response),true);assert.equal(response.statusCode,401);assert.equal(read,false);
 assert.equal(await f.handler.handle({url:'/unrelated',method:'POST'},response),false);
 const allowed=await f.request(url('/workflows'),'POST',{operationId:'trusted',entry:{intent:'work'},actorId:'forged'}, {'x-user-id':'forged'});
 assert.equal(allowed.status,200);assert.equal(allowed.body.actorId,'owner');
});

test('customer, expired and malformed verified sessions cannot create preparations',async t=>{
 for(const invalid of [{...session(),subject:{id:'owner',roles:['customer_account'],accountScope:'customer_account'}},{...session(),expiresAt:'2000-01-01T00:00:00Z'},{...session(),expiresAt:'invalid'},{...session(),subject:{id:'owner'}}]){
  const f=await fixture(t,{session:invalid}),r=await f.request(url('/workflows'),'POST',{operationId:'begin',entry:{intent:'work'}});
  assert.equal(r.status,invalid.subject.roles?.includes('customer_account')?403:401);assert.equal(f.created,0);assert.equal(f.store.works.length,0);
 }
});

test('disabled new intake retains saved read, save and resume paths while reporting absent upload and release providers',async t=>{
 const f=await fixture(t),draft=(await f.request(url('/workflows'),'POST',{operationId:'begin',entry:{intent:'work'}})).body;
 let r=await f.request(url(`/workflows/${draft.id}/uploads`),'POST',{expectedRevision:draft.revision,operationId:'upload',upload:{}});assert.equal(r.status,503);assert.equal(r.body.code,'unsupported_operation');
 assert.equal((await f.request(url(`/workflows/${draft.id}/previews`),'POST',{expectedRevision:draft.revision})).status,503);
 f.disable();
 assert.equal((await f.request(url('/workflows'),'POST',{operationId:'blocked',entry:{intent:'work'}})).body.code,'workflow_disabled');
 assert.equal((await f.request(url(`/workflows/${draft.id}`))).status,200);
 assert.equal((await f.request(url(`/workflows/${draft.id}/save`),'POST',{expectedRevision:draft.revision,operationId:'save'})).status,200);
 assert.equal((await f.request(url(`/workflows/${draft.id}/resume`),'POST',{})).status,200);
});

test('the Node transport rejects malformed JSON, duplicate Creator selectors and oversized requests without creating state',async t=>{
 const f=await fixture(t,{transport:{maxJsonBodyBytes:256}});
 for(const body of ['{','[]','null'])assert.equal((await f.request(url('/workflows'),'POST',body)).status,400);
 assert.equal((await f.request(url('/workflows')+'&creatorId=other')).status,403);
 assert.equal((await f.request(url('/workflows'),'POST',JSON.stringify({creatorId:'creator',padding:'x'.repeat(300)}))).status,413);
 assert.equal((await f.request(url('/workflows'))).body.items.length,0);
});

test('review media preserves exact bytes, attachment safety and HEAD semantics through both path aliases',async t=>{
 const bytes=Buffer.from('synthetic reviewed document'),calls=[];
 const f=await fixture(t,{bindings:{createRelease:()=>({async reviewMedia(...args){calls.push(args);return {file:{mimeType:'application/pdf',filename:"review's (copy).pdf"},bytes};}})}});
 const path=url('/workflows/draft/reviews/review/images/representation/component');
 for(const prefix of ['', '/api']){
  const r=await f.request(prefix+path);assert.equal(r.status,200);assert.deepEqual(r.bytes,bytes);assert.equal(r.headers.get('cache-control'),'private, no-store');assert.equal(r.headers.get('x-content-type-options'),'nosniff');assert.equal(r.headers.get('content-type'),'application/pdf');assert.ok(r.headers.get('content-disposition').includes('review%27s%20%28copy%29.pdf'));
  const head=await f.request(prefix+path,'HEAD');assert.equal(head.status,200);assert.equal(head.bytes.length,0);assert.equal(Number(head.headers.get('content-length')),bytes.length);
 }
 assert.deepEqual(calls[0],['creator','draft','review','representation','component']);
 assert.equal((await f.request(path.replace('/draft/','/%ZZ/'))).status,400);
});

test('route composition refuses missing host capabilities and retains every native preparation endpoint',()=>{
 const bindings={...bindingsFor(new FixtureStore()),actorId:()=> 'owner'},routes=[];
 for(const name of ['actorId','access','createService','createRelease','enabled','durableDrafts','offerings','announcementDestinations','destinations','managementUrl'])assert.throws(()=>registerContentPreparationRoutes({register(){}},{...bindings,[name]:undefined}),/actual capabilities/);
 registerContentPreparationRoutes({register:(method,path)=>routes.push([method,path])},bindings);
 const expected={
  get:['/workflows/:id/reviews/:reviewId/images/:representationId/:componentId','/intake-capabilities','/capabilities','/workflows','/collections','/standalone-images','/export','/workflows/:id','/workflows/:id/contents','/releases/:id','/presets','/presets/:id/versions'],
  patch:['/workflows/:id','/presets/:id'],
  post:['/restore','/workflows','/workflows/:id/objects','/workflows/:id/uploads','/workflows/:id/objects/:objectId/complete','/workflows/:id/announcement-draft/review','/workflows/:id/announcement-draft','/workflows/:id/previews','/workflows/:id/review','/workflows/:id/release','/releases/:id/cancel','/workflows/:id/save','/workflows/:id/refresh-references','/workflows/:id/resume','/workflows/:id/apply-changes','/workflows/:id/cancel','/workflows/:id/preset','/workflows/:id/apply-preset','/workflows/:id/apply-reviewed-preset']
 };
 assert.deepEqual(routes.map(row=>row.join(' ')).sort(),Object.entries(expected).flatMap(([method,paths])=>paths.map(path=>method+' /api/studio/content'+path)).sort());
});

test('core composition supplies actual adapters and enforces configured tenancy before an injected preparation host',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'preparation-core-host-')),local=createLocalAdapterSet({databasePath:join(directory,'core.sqlite'),dataDirectory:directory,cellId:'cell',publicBaseUrl:'http://localhost'});
 const rich=new FixtureStore();let hostCalls=0,closed=0,tenancyCalls=0,captured;
 const runtime=createCoreRuntime({instanceId:'instance',cellId:'cell',region:'local',publicBaseUrl:'http://localhost',adapters:{repositories:local.repositories,storage:local.storage,uploads:local.storage,delivery:local.storage,jobs:local.jobs,identity:local.identity,localIdentity:local.identity},
  tenancy:{mode:'single_operator',assertCanCreateCreatorUser:async()=>{},assertCanCreateCustomerAccount:async()=>{},listAccessibleCreatorIds:async()=>[],resolveCreatorRole:async()=>{tenancyCalls++;return null;},isContributorManagementEnabled:()=>false,isOrganizationManagementEnabled:()=>false},
  contentPreparation:context=>{captured=context;return {...bindingsFor(rich),runNextJob:()=>new ContentWorkflowService(rich,{tenantId:'tenant'},fixtureHost(rich,'owner')).recoverNext(),access:async()=>{hostCalls++;return true;},close:()=>{closed++;}};}});
 await new Promise(resolve=>runtime.server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{await runtime.close();local.database.close();await rm(directory,{recursive:true,force:true});});
 const credentials={email:'owner@example.test',password:'Synthetic password 123!'};await local.identity.register(credentials);const signed=await local.identity.authenticate(credentials);
 assert.equal(captured.adapters.repositories,local.repositories);assert.equal(captured.instanceId,'instance');assert.equal(captured.cellId,'cell');assert.equal(captured.region,'local');
 const base='http://127.0.0.1:'+runtime.server.address().port;
 for(const path of [url('/workflows'),'/api'+url('/workflows')]){
  const r=await fetch(base+path,{headers:{authorization:'Bearer '+signed.token}});assert.equal(r.status,403);
 }
 assert.equal(tenancyCalls,2);assert.equal(hostCalls,0);
 const forged=await fetch(base+url('/workflows'),{headers:{'x-user-id':'owner'}});assert.equal(forged.status,401);
 await runtime.close();assert.equal(closed,1);
});
