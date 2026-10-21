import test from 'node:test';
import assert from 'node:assert/strict';
import {HostingerWebsiteHostingAdapter, createHostingPublicProbe, WebsiteHostingConnections} from '../dist/index.js';
const website={domain:'artist.example',username:'u123',client_id:42,website_type:'other',vhost_type:'main',is_enabled:true};
const probe=async()=>({observedAt:new Date().toISOString(),associationConfirmed:true,publicConfirmed:true,locations:[],reasons:[]});
function fixture({site=website,files=[],marker,host='uploads.example',uncertain=false,git=[],throttleUpload=false,uploadHosts=['uploads.example'],authorizeUploadUrl}={}){
 const calls=[];let offset,deploys=0;
 const c={target:{id:'target',family:'hostinger',accountId:'42',remoteId:website.domain,publicUrl:'https://artist.example/',basePath:'/',config:{username:'u123',adoption:'replace_root'},activeReleaseId:marker},connection:{family:'hostinger',authorization:'api_token',state:'connected',accountId:'42'},attemptId:'attempt',artifact:{marker:'b'.repeat(64),zip:Buffer.from('public zip'),files:new Map([['index.html',Buffer.from('public')]])},checkpoint:{},beforeUpload:async()=>{},beforeActivation:async()=>{c.guarded=true;},saveCheckpoint:async cp=>c.checkpoint=cp};
 const adapter=new HostingerWebsiteHostingAdapter({credential:async()=> 'private-token',probe,uploadHosts,authorizeUploadUrl,requestIntervalMs:0,fetch:async(url,init={})=>{
  const u=new URL(url);calls.push({url,method:init.method??'GET',headers:init.headers});
  if(u.hostname==='uploads.example'){
   assert.equal(init.headers.Authorization,undefined);assert.equal(init.headers.authorization,undefined);assert.equal(init.headers['X-Auth'],'temporary');
   if(init.method==='HEAD')return new Response(null,{status:offset===undefined?404:200,headers:offset===undefined?{}:{'upload-offset':String(offset),'upload-length':String(c.artifact.zip.length)}});
   if(init.method==='POST'){offset=0;return new Response(null,{status:201});}
   if(init.method==='PATCH'&&throttleUpload)return new Response(null,{status:429,headers:{'retry-after':'30'}});
   if(init.method==='PATCH'){assert.equal(Number(init.headers['Upload-Offset']),offset);offset+=init.body.length;return new Response(null,{status:204,headers:{'upload-offset':String(offset)}});}
  }
  assert.equal(u.origin,'https://developers.hostinger.com');assert.equal(init.headers.authorization,'Bearer private-token');
  if(u.pathname.endsWith('/websites'))return Response.json({data:[site],meta:{last_page:1}});
  if(u.pathname.endsWith('/onboardings'))return Response.json([]);
  if(u.pathname.endsWith('/git/auto-deployments/settings'))return Response.json({is_enabled:false});
  if(u.pathname.endsWith('/git/repositories'))return Response.json(git);
  if(u.pathname.endsWith('/files/content'))return Response.json({content:JSON.stringify({release:marker})});
  if(u.pathname.endsWith('/files'))return Response.json({items:files,total_items:files.length});
  if(u.pathname.endsWith('/upload-urls'))return Response.json({url:'https://'+host+'/tus',auth_key:'temporary',rest_auth_key:'temporary-rest'});
  if(u.pathname.endsWith('/deploy')){assert.equal(c.guarded,true);assert.equal(c.checkpoint.data.deployRequested,'true');deploys++;if(uncertain)throw Error('transport timeout');return Response.json({});}
  throw Error('Unexpected request '+url);
 }});
 return {adapter,c,calls,get deploys(){return deploys;},setOffset:value=>offset=value};
}
test('Hostinger root publishes the exact artifact through TUS and reconciles without another mutation',async()=>{
 const f=fixture();await f.adapter.validateAdoption(f.c.target,f.c.connection);f.c.checkpoint=await f.adapter.prepare(f.c);
 assert.equal(f.deploys,0);assert.equal(f.c.checkpoint.data.uploaded,'true');assert.ok(!JSON.stringify(f.c.checkpoint).includes('temporary'));
 assert.equal((await f.adapter.activate(f.c)).state,'pending');assert.equal(f.deploys,1);
 assert.equal((await f.adapter.reconcile(f.c)).state,'activated');assert.equal(f.deploys,1);
});
test('unsupported website types and occupied roots cannot reach uploads or deployment',async()=>{
 for(const type of ['builder','wordpress','nodejs','horizons',undefined]){const f=fixture({site:{...website,website_type:type}});await assert.rejects(f.adapter.validateAdoption(f.c.target,f.c.connection),{code:'unsupported_target'});assert.equal(f.deploys,0);}
 const f=fixture({files:[{name:'index.php',type:'file'}]});await assert.rejects(f.adapter.prepare(f.c),{code:'root_not_empty'});assert.ok(!f.calls.some(c=>c.method==='POST'));
});
test('upload endpoint allowlist prevents temporary credential leakage',async()=>{
 const f=fixture({host:'attacker.example'});await assert.rejects(f.adapter.prepare(f.c),{code:'unsafe_upload_host'});assert.ok(!f.calls.some(c=>c.url.includes('attacker.example')));
});
test('resumes an interrupted upload at the authoritative TUS offset without recreating it',async()=>{
 const f=fixture();f.c.checkpoint=await f.adapter.prepare(f.c);const archive=f.c.checkpoint.data.archive;
 f.c.checkpoint={data:{archive,uploaded:'false',uploadStartedAt:new Date().toISOString()}};f.setOffset(3);f.calls.length=0;
 await f.adapter.prepare(f.c);assert.ok(f.calls.some(c=>c.method==='HEAD'));assert.ok(!f.calls.some(c=>c.method==='POST'&&c.url.includes('/tus/')));
});
test('an uncertain deployment is reconciled read-only and drift blocks replacement',async()=>{
 const f=fixture({uncertain:true});f.c.checkpoint=await f.adapter.prepare(f.c);await assert.rejects(f.adapter.activate(f.c));assert.equal(f.deploys,1);await f.adapter.reconcile(f.c);assert.equal(f.deploys,1);
 const changed=fixture({files:[{name:'ubeeq-release.json',type:'file'}],marker:'old'});changed.c.target.activeReleaseId='expected';await assert.rejects(changed.adapter.prepare(changed.c),{code:'remote_drift'});
});
test('strict public verification rejects correct markers with stale page or image contents',async()=>{
 const f=fixture();f.c.artifact.files.set('assets/picture.webp',new Uint8Array([0,255,12]));
 const check=createHostingPublicProbe({authorizeUrl:async()=>{},verifyContents:true,fetch:async url=>{
  const path=new URL(url).pathname;
  if(path.endsWith('ubeeq-release.json'))return Response.json({release:f.c.artifact.marker});
  if(path.includes('ubeeq-missing-'))return new Response(null,{status:404});
  return new Response(path==='/'?'stale':new Uint8Array([0,255,12]),{headers:{'content-type':path==='/'?'text/html':'image/webp'}});
 }});
 assert.ok((await check(f.c)).reasons.includes('file_hash_mismatch'));
});
test('invalid replacement token leaves the working Hostinger credential untouched',async()=>{
 const writes=[],service=new WebsiteHostingConnections({cellId:'cell',authorize:async()=>{},vault:{write:async x=>{writes.push(x);return {reference:'new'};},read:async()=>{},revoke:async()=>{}},states:{},get:async()=>({id:'connection',family:'hostinger',accountId:'42',credentialReference:'old',revision:1}),list:async()=>[],save:async()=>{},fetch:async()=>new Response(null,{status:401})});
 await assert.rejects(service.connectHostinger({workspaceId:'creator',actorId:'owner'},{id:'connection',accountId:'42',token:'invalid'}));assert.equal(writes.length,0);
});

test('legacy Git repositories block adoption even when auto-deployment settings are empty',async()=>{
 const f=fixture({git:[{repository:'other-project',directory:'blog'}]});await assert.rejects(f.adapter.prepare(f.c),{code:'remote_git_conflict'});assert.ok(!f.calls.some(call=>call.method==='POST'));
});

test('TUS rate limits retain the upload checkpoint and propagate the provider retry deadline',async()=>{
 const f=fixture({throttleUpload:true});await assert.rejects(f.adapter.prepare(f.c),{code:'rate_limited',retryAfterSeconds:30});assert.equal(f.c.checkpoint.data.uploaded,'false');assert.ok(f.c.checkpoint.data.archive);assert.equal(f.deploys,0);
});

test('a discovered file-based website is selectable without a per-domain allowlist',async()=>{
 const f=fixture();const rows=await f.adapter.sites(f.c.connection);assert.equal(rows[0].eligible,true);assert.ok(!rows[0].reason.includes('operator'));
 f.c.target.remoteId='another.example';f.c.target.publicUrl='https://another.example/';
 const other=fixture({site:{...website,domain:'another.example'}});Object.assign(other.c.target,{remoteId:'another.example',publicUrl:'https://another.example/'});
 await other.adapter.validateAdoption(other.c.target,other.c.connection);
});
test('validation reports each completed check without uploading files or leaking temporary credentials',async()=>{
 const f=fixture({host:'srv12345-files.hstgr.io',uploadHosts:[],authorizeUploadUrl:async url=>assert.equal(url.hostname,'srv12345-files.hstgr.io')});
 const result=await f.adapter.validateDestination(f.c.target,f.c.connection);assert.equal(result.valid,true);assert.equal(result.checks.length,6);assert.ok(result.checks.every(check=>check.status==='passed'));
 assert.ok(!JSON.stringify(result).includes('temporary'));assert.ok(!JSON.stringify(result).includes('private-token'));
 assert.ok(!f.calls.some(call=>new URL(call.url).hostname!=='developers.hostinger.com'));assert.equal(f.deploys,0);
});
test('validation explains occupied roots and does not request an upload session',async()=>{
 const f=fixture({files:[{name:'index.html',type:'file'}]});const result=await f.adapter.validateDestination(f.c.target,f.c.connection);
 assert.equal(result.valid,false);assert.equal(result.checks.at(-1).code,'root_not_empty');assert.match(result.checks.at(-1).message,/Back up/);assert.ok(!f.calls.some(call=>call.method==='POST'));
});
test('validation rejects lookalike upload hosts and failed public-address checks',async()=>{
 for(const host of ['srv12345-files.hstgr.io.attacker.example','srv12345-files.attacker.io','attacker.example']){
  const f=fixture({host,uploadHosts:[]}),result=await f.adapter.validateDestination(f.c.target,f.c.connection);
  assert.equal(result.valid,false);assert.equal(result.checks.at(-1).code,'unsafe_upload_host');assert.ok(!f.calls.some(call=>new URL(call.url).hostname===host));
 }
 const f=fixture({host:'srv12345-files.hstgr.io',uploadHosts:[],authorizeUploadUrl:async()=>{throw Error('Private address');}});
 assert.equal((await f.adapter.validateDestination(f.c.target,f.c.connection)).valid,false);
});
test('a successful preflight does not bypass a later occupied-root check',async()=>{
 const files=[],f=fixture({files});assert.equal((await f.adapter.validateDestination(f.c.target,f.c.connection)).valid,true);
 files.push({name:'index.php',type:'file'});await assert.rejects(f.adapter.prepare(f.c),{code:'root_not_empty'});assert.equal(f.deploys,0);
});

test('explicit initial overwrite consent permits occupied file-based roots through publishing',async()=>{
 const f=fixture({files:[{name:'index.html',type:'file'}]});
 await assert.rejects(f.adapter.validateAdoption(f.c.target,f.c.connection),{code:'root_not_empty'});
 f.c.target.config.adoption='replace_existing_root';assert.equal((await f.adapter.validateDestination(f.c.target,f.c.connection)).valid,true);assert.equal(f.deploys,0);
 f.c.checkpoint=await f.adapter.prepare(f.c);await f.adapter.activate(f.c);assert.equal(f.deploys,1);
});
test('overwrite consent never permits unsupported hosting or conflicting Git deployments',async()=>{
 for(const type of ['builder','wordpress','nodejs']){const f=fixture({site:{...website,website_type:type}});f.c.target.config.adoption='replace_existing_root';await assert.rejects(f.adapter.validateAdoption(f.c.target,f.c.connection),{code:'unsupported_target'});assert.equal(f.deploys,0);}
 const f=fixture({git:[{repository:'existing'}]});f.c.target.config.adoption='replace_existing_root';await assert.rejects(f.adapter.prepare(f.c),{code:'remote_git_conflict'});
});
test('initial overwrite consent does not bypass drift checks after a managed release exists',async()=>{
 const f=fixture({files:[{name:'ubeeq-release.json',type:'file'}],marker:'unrelated'});f.c.target.activeReleaseId='verified';f.c.target.config.adoption='replace_existing_root';
 await assert.rejects(f.adapter.prepare(f.c),{code:'remote_drift'});assert.equal(f.deploys,0);
});
