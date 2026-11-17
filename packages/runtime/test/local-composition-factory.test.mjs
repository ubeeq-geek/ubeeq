import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {existsSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createLocalAdapterSet} from '@ubeeq/adapter-local';
import {createReferenceApi} from '../dist/index.js';

async function directory(){return mkdtemp(join(tmpdir(),'local-composition-factory-'));}
async function listen(runtime){await new Promise(resolve=>runtime.server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+runtime.server.address().port;return async(path,{token,method='GET',body}={})=>{
 const response=await fetch(base+path,{method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
 return {status:response.status,body:response.status===204?undefined:await response.json()};
};}
const credentials={email:'operator@local-composition.test',password:'Synthetic local composition password123!'};
async function register(request){assert.equal((await request('/v1/auth/sign-up',{method:'POST',body:credentials})).status,201);const signed=await request('/v1/auth/sign-in',{method:'POST',body:credentials});assert.equal(signed.status,200);assert.ok(signed.body.token);return signed.body.token;}

test('trusted factory runs once before the real local constructor and retains shared identity/repository ownership',async t=>{
 const root=await directory(t),dataDirectory=join(root,'not-created-yet'),databasePath=join(dataDirectory,'state.sqlite'),marker=join(dataDirectory,'host-before-local'),configuration={databasePath,dataDirectory,publicBaseUrl:'http://127.0.0.1:0',instanceId:'factory-instance',cellId:'factory-cell',sessionTtlSeconds:900,credentialEncryptionKey:'Synthetic local encryption key at least32 characters'};
 let calls=0,local,closed=0,normalized;
 const runtime=createReferenceApi({...configuration,createLocalAdapters:input=>{
  calls++;normalized=input;assert.equal(existsSync(databasePath),false);assert.equal(existsSync(dataDirectory),false);
  // Representative host O_EXCL preparation occurs before any SDK SQLite/files.
  mkdirSync(dataDirectory,{recursive:true});writeFileSync(marker,'host preparation precedes local construction',{flag:'wx',mode:0o600});
  local=createLocalAdapterSet(input);const close=local.database.close.bind(local.database);local.database.close=()=>{closed++;close();};return local;
 }});
 t.after(async()=>{await runtime.close();await rm(root,{recursive:true,force:true});});assert.equal(calls,1);assert.equal(readFileSync(marker,'utf8'),'host preparation precedes local construction');
 assert.deepEqual(normalized,{databasePath,dataDirectory,publicBaseUrl:configuration.publicBaseUrl,cellId:configuration.cellId,sessionTtlSeconds:900,credentialEncryptionKey:configuration.credentialEncryptionKey});
 const request=await listen(runtime),token=await register(request),session=await local.identity.verifySession({credential:token});assert.ok(session);
 const created=await request('/v1/creators',{token,method:'POST',body:{handle:'factory-owner',displayName:'Factory owner'}});assert.equal(created.status,201);assert.equal(created.body.creator.subjectId,session.subject.id);
 assert.deepEqual(await local.repositories.creators.get(created.body.creator.id),created.body.creator);
 const account=local.database.database.prepare('SELECT id,email FROM ubeeq_accounts WHERE id = ?').get(session.subject.id);assert.equal(account.email,credentials.email);
 const diagnostic=await request('/diagnostics');assert.equal(diagnostic.status,200);assert.deepEqual(diagnostic.body.dependencies,[{name:'sqlite',status:'ok'}]);
 await runtime.close();assert.equal(closed,1);await runtime.close();assert.equal(closed,1);assert.throws(()=>local.database.database.prepare('SELECT 1').get(),/closed|not open/i);assert.equal(calls,1);
});

test('factory-owned local composition keeps default websites and optional durable commerce/vault',async t=>{
 const root=await directory(t),dataDirectory=join(root,'data'),key='Synthetic commerce vault and token key at least32 characters';let local;
 const runtime=createReferenceApi({databasePath:join(dataDirectory,'state.sqlite'),dataDirectory,publicBaseUrl:'http://127.0.0.1:0',cellId:'local',credentialEncryptionKey:key,
  createLocalAdapters:configuration=>(local=createLocalAdapterSet(configuration)),
  commerce:{tokenKey:key,publicBaseUrl:'https://shop.local-composition.test',environments:['sandbox'],financialRetentionDays:2555,mail:{async send(){throw Error('No outbound mail is authorized or needed by this local defaults test.');}},fetch:async()=>{throw Error('No external commerce provider is authorized or needed by this local defaults test.');}}
 });t.after(async()=>{await runtime.close();await rm(root,{recursive:true,force:true});});
 const request=await listen(runtime),token=await register(request),created=await request('/v1/creators',{token,method:'POST',body:{handle:'default-owner',displayName:'Default owner'}});assert.equal(created.status,201);const creator=created.body.creator;
 const capabilities=await request('/v1/websites/capabilities',{token});assert.equal(capabilities.status,200);assert.ok(capabilities.body.capabilities.maxPages>1000);
 const document={id:'document',workspaceId:creator.id,revision:1,blocks:[{id:'paragraph',type:'paragraph',text:'Durable default website document.'}]};
 assert.equal((await request('/v1/websites/documents/document',{token,method:'PUT',body:{expectedRevision:0,document}})).status,200);
 assert.deepEqual((await request('/v1/websites/documents/document',{token})).body.document,document);assert.equal(existsSync(join(dataDirectory,'websites.sqlite')),true);
 const connections=await request('/api/connections/paypal',{token});assert.equal(connections.status,200);assert.deepEqual(connections.body.connections,[]);assert.equal(existsSync(join(dataDirectory,'commerce.sqlite')),true);
 const secret=Buffer.from('Synthetic local credential; never an external provider token'),stored=await local.credentials.write({cellId:'local',ownerId:creator.id,value:secret});assert.deepEqual(Buffer.from(await local.credentials.read({cellId:'local',reference:stored.reference})),secret);
 const ciphertext=local.database.database.prepare('SELECT ciphertext FROM ubeeq_credentials').get().ciphertext;assert.notDeepEqual(Buffer.from(ciphertext),secret);
 assert.equal((await request('/diagnostics')).body.dependencies[0].name,'sqlite');
});

test('omitting the factory preserves the existing concrete local path and defaults',async t=>{
 const root=await directory(t),runtime=createReferenceApi({databasePath:join(root,'state.sqlite'),dataDirectory:root,publicBaseUrl:'http://127.0.0.1:0'});t.after(async()=>{await runtime.close();await rm(root,{recursive:true,force:true});});
 const request=await listen(runtime),token=await register(request),created=await request('/v1/creators',{token,method:'POST',body:{handle:'ordinary-owner',displayName:'Ordinary owner'}});assert.equal(created.status,201);
 assert.equal((await request('/v1/websites/capabilities',{token})).status,200);assert.deepEqual((await request('/diagnostics')).body.dependencies,[{name:'sqlite',status:'ok'}]);
});

test('invalid or mixed factory configuration fails before callback, filesystem or any local constructor',async t=>{
 const root=await directory(t);t.after(()=>rm(root,{recursive:true,force:true}));let calls=0;
 for(const [index,configuration]of [
  {createLocalAdapters:null},{createLocalAdapters:{}},{createLocalAdapters:[]},{createLocalAdapters:'factory'},
  {createLocalAdapters:()=>{calls++;throw Error('Mixed factory must not run.');},adapters:{}},
  {createLocalAdapters:()=>{calls++;throw Error('Mixed factory must not run.');},adapters:null},
 ].entries()){
  const dataDirectory=join(root,'invalid-'+index),databasePath=join(dataDirectory,'state.sqlite');
  assert.throws(()=>createReferenceApi({databasePath,dataDirectory,publicBaseUrl:'http://127.0.0.1:0',...configuration}),/trusted factory|either runtime-owned/);
  assert.equal(existsSync(dataDirectory),false);assert.equal(existsSync(databasePath),false);
 }
 assert.equal(calls,0);
});

test('a trusted factory preparation failure cannot fall through to an SDK local constructor',async t=>{
 const root=await directory(t),dataDirectory=join(root,'unopened'),databasePath=join(dataDirectory,'state.sqlite');t.after(()=>rm(root,{recursive:true,force:true}));let calls=0;
 assert.throws(()=>createReferenceApi({databasePath,dataDirectory,publicBaseUrl:'http://127.0.0.1:0',createLocalAdapters:()=>{calls++;throw Error('Actual host pre-construction preparation failed.');}}),/pre-construction preparation failed/);
 assert.equal(calls,1);assert.equal(existsSync(dataDirectory),false);assert.equal(existsSync(databasePath),false);
});
