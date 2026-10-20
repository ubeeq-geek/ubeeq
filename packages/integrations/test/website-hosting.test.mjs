import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { NetlifyWebsiteHostingAdapter,CloudflarePagesWebsiteHostingAdapter,HostingHttp,createHostingPublicProbe,cloudflarePagesAssetHash,cloudflarePagesAttemptTag,WebsiteHostingConnections } from '../dist/index.js';
const goodProbe=async()=>({observedAt:new Date().toISOString(),associationConfirmed:true,publicConfirmed:true,locations:['https://example.test/'],reasons:[]});
const context=(family)=>{const marker='a'.repeat(64),files=new Map([['index.html',Buffer.from('<h1>Public</h1>')],['ubeeq-release.json',Buffer.from(JSON.stringify({release:marker}))],['_redirects',Buffer.from('/old / 301\n')]]);const target={id:'target',workspaceId:'w',websiteId:'site',revision:1,adapterId:family,family,accountId:family==='cloudflare-pages'?'a'.repeat(32):'team',remoteId:'remote',publicUrl:'https://site.example.test/',basePath:'/',ownershipMarker:'owner',config:family==='cloudflare-pages'?{projectName:'project',productionBranch:'main'}:{},desiredGeneration:1,activeGeneration:0,serving:'unpublished'};const c={target,connection:{id:'connection',workspaceId:'w',revision:1,family,accountId:target.accountId,authorization:family==='netlify'?'oauth':'api_token',state:'connected',permissions:[]},attemptId:'attempt',generation:1,operation:'publish',artifact:{digest:'d'.repeat(64),sourceArtifactDigest:'s'.repeat(64),marker,files,zip:Buffer.from('zip')},checkpoint:{},saveCheckpoint:async cp=>c.checkpoint=cp,beforeActivation:async()=>{c.guards=(c.guards??0)+1;}};return c;};
const json=value=>Response.json(value);
test('Netlify uses OAuth, a SHA1 file manifest, public draft staging and one guarded POST promotion',async()=>{
  const c=context('netlify');let production='prior',manifest,uploaded=0,promotions=0;
  const adapter=new NetlifyWebsiteHostingAdapter({credential:async()=> 'server-token',probe:goodProbe,delay:async()=>{},fetch:async(url,init)=>{assert.equal(init.headers.authorization,'Bearer server-token');const u=new URL(url);assert.equal(u.origin,'https://api.netlify.com');
    if(u.pathname==='/api/v1/sites/remote'&&!init.method)return json({id:'remote',account_id:'team',ssl_url:c.target.publicUrl,published_deploy:{id:production}});
    if(u.pathname==='/api/v1/sites/remote/deploys'){manifest=JSON.parse(init.body);assert.equal(manifest.draft,true);assert.equal(manifest.files['/index.html'],createHash('sha1').update(c.artifact.files.get('index.html')).digest('hex'));return json({id:'deploy1',site_id:'remote',state:'prepared',required:[manifest.files['/index.html']]});}
    if(u.pathname==='/api/v1/deploys/deploy1/files/index.html'){assert.equal(init.method,'PUT');uploaded++;return json({});}
    if(u.pathname==='/api/v1/deploys/deploy1')return json({id:'deploy1',site_id:'remote',state:'ready'});
    if(u.pathname==='/api/v1/sites/remote/deploys/deploy1/restore'){assert.equal(init.method,'POST');assert.equal(c.guards,1);promotions++;production='deploy1';return json({});}throw new Error('Unexpected '+url);
  }});
  await adapter.validateTarget(c.target,c.connection);c.checkpoint=await adapter.prepare(c);assert.equal(production,'prior');assert.equal(uploaded,1);assert.equal(adapter.capabilities.staging,'public');assert.equal((await adapter.activate(c)).state,'activated');assert.equal(promotions,1);assert.equal((await adapter.reconcile(c)).state,'activated');assert.equal(promotions,1);
  c.connection.authorization='api_token';await assert.rejects(adapter.validateTarget(c.target,c.connection),{code:'reconnect_required'});
});
test('Netlify refuses manual production drift and never calls restore after guard refusal',async()=>{
  const c=context('netlify');c.checkpoint={releaseId:'candidate',data:{previousReleaseId:'prior'}};let posts=0;
  const adapter=new NetlifyWebsiteHostingAdapter({credential:async()=> 'token',probe:goodProbe,fetch:async(url,init)=>{if(init.method==='POST')posts++;return json(url.includes('/deploys/')?{state:'ready'}:{id:'remote',account_id:'team',published_deploy:{id:'manual'}});}});
  await assert.rejects(adapter.activate(c),{code:'remote_drift'});assert.equal(posts,0);
});
test('Pages Direct Upload uses the official extension hash, JWT upload session, manifest and multipart production request',async()=>{
  const c=context('cloudflare-pages');let production,posts=0,manifest;const body={id:'remote',name:'project',subdomain:'site.example.test',production_branch:'main'};
  const adapter=new CloudflarePagesWebsiteHostingAdapter({credential:async()=> 'restricted-token',probe:goodProbe,fetch:async(url,init)=>{const path=new URL(url).pathname;const result=value=>json({success:true,result:value});
    if(path.endsWith('/upload-token'))return result({jwt:'upload-jwt'});
    if(path.endsWith('/check-missing')){assert.equal(init.headers.authorization,'Bearer upload-jwt');return result(JSON.parse(init.body).hashes);}
    if(path.endsWith('/assets/upload')){const [item]=JSON.parse(init.body);assert.equal(item.base64,true);assert.equal(item.key,cloudflarePagesAssetHash(item.metadata.contentType==='text/html'?'index.html':'ubeeq-release.json',Buffer.from(item.value,'base64')));return result({});}
    if(path.endsWith('/upsert-hashes'))return result({});
    if(path.endsWith('/deployments')&&init.method==='POST'){assert.equal(c.guards,1);assert.equal(init.headers.authorization,'Bearer restricted-token');posts++;manifest=JSON.parse(init.body.get('manifest'));assert.equal(init.body.get('branch'),'main');assert.equal(init.body.get('commit_hash'),c.artifact.marker.slice(0,40));assert.equal(await init.body.get('_redirects').text(),'/old / 301\n');production='deployment';return result({id:production});}
    if(path.endsWith('/deployments/deployment'))return result({id:'deployment',environment:'production',latest_stage:{status:'success'},deployment_trigger:{metadata:{commit_hash:c.artifact.marker.slice(0,40),commit_message:cloudflarePagesAttemptTag(c)}}});
    if(path.endsWith('/project'))return result({...body,canonical_deployment:production?{id:production}:undefined});throw new Error('Unexpected '+url);
  }});
  await adapter.validateTarget(c.target,c.connection);c.checkpoint=await adapter.prepare(c);assert.equal(posts,0);assert.equal((await adapter.activate(c)).state,'activated');assert.equal(manifest['/index.html'],cloudflarePagesAssetHash('index.html',c.artifact.files.get('index.html')));assert.equal(manifest['/_redirects'],undefined);assert.equal((await adapter.reconcile(c)).state,'activated');assert.equal(posts,1);
  const gitAdapter=new CloudflarePagesWebsiteHostingAdapter({credential:async()=> 'token',probe:goodProbe,fetch:async()=>json({success:true,result:{...body,source:{type:'github'}}})});await assert.rejects(gitAdapter.validateTarget(c.target,c.connection),{code:'unsupported_project'});
});
test('provider failures redact bodies; public probes reject unrelated HTTP 200 markers and forward no credentials',async()=>{
  const http=new HostingHttp('https://api.netlify.com',async()=>new Response('PRIVATE TOKEN AND PROVIDER DETAIL',{status:429,headers:{'retry-after':'45'}}));
  await assert.rejects(http.request('/api/v1/sites','secret'),e=>e.code==='rate_limited'&&e.retryAfterSeconds===45&&!e.message.includes('PRIVATE'));
  const c=context('netlify');const probe=createHostingPublicProbe({authorizeUrl:async()=>{},fetch:async(url,init)=>{assert.equal(init.headers.authorization,undefined);return json({release:'wrong'});}});assert.equal((await probe(c)).publicConfirmed,false);
});
test('Netlify OAuth state is durable, bound to actor/account and one-use; disconnect revokes the server vault',async()=>{
  const states=new Map(),secrets=new Map(),connections=new Map();let revoked=0;
  const service=new WebsiteHostingConnections({cellId:'installation',netlify:{clientId:'app',redirectUri:'https://editor.test/websites'},states:{create:async s=>states.set(s.id,s),consume:async id=>{const s=states.get(id);states.delete(id);return s;}},vault:{write:async({value})=>{secrets.set('ref',value);return {reference:'ref'};},read:async()=>secrets.get('ref'),revoke:async()=>{revoked++;secrets.delete('ref');}},authorize:async()=>{},get:async(_w,id)=>connections.get(id),list:async()=>[...connections.values()],save:async c=>connections.set(c.id,c),fetch:async()=>json([{id:'team'}])});
  const actor={workspaceId:'w',actorId:'manager'},begin=await service.beginNetlify(actor,'team'),url=new URL(begin.authorizationUrl);assert.equal(url.searchParams.get('response_type'),'token');
  const state=url.searchParams.get('state'),saved=await service.completeNetlify(actor,state,'oauth-token');assert.equal(saved.credentialReference,undefined);assert.equal((await service.list(actor))[0].credentialReference,undefined);
  await assert.rejects(service.completeNetlify(actor,state,'oauth-token'),{code:'invalid_oauth_state'});await service.disconnect(actor,saved.id);assert.equal(revoked,1);
  const other=await service.beginNetlify(actor,'team');await assert.rejects(service.completeNetlify({...actor,actorId:'other'},new URL(other.authorizationUrl).searchParams.get('state'),'token'),{code:'invalid_oauth_state'});
});

test('provider domain requests preserve the current public URL and expose DNS/certificate readiness separately',async()=>{
 const c=context('netlify'),domain={hostname:'custom.example.test',mode:'alias'},aliases=[];const adapter=new NetlifyWebsiteHostingAdapter({credential:async()=> 'token',probe:goodProbe,fetch:async(url,init)=>{if(init.method==='PATCH'){aliases.push(...JSON.parse(init.body).domain_aliases);return json({});}if(url.endsWith('/ssl'))return json({domains:['custom.example.test'],expires_at:'2099-01-01T00:00:00Z'});return json({id:'remote',account_id:'team',ssl_url:c.target.publicUrl,domain_aliases:aliases});}});
 const before=c.target.publicUrl;assert.equal((await adapter.domain({target:c.target,connection:c.connection,domain,operation:'request'})).state,'dns_pending');assert.equal((await adapter.domain({target:c.target,connection:c.connection,domain,operation:'verify'})).state,'ready');assert.equal(c.target.publicUrl,before);assert.equal(adapter.capabilities.unpublish,'operator_required');assert.equal(adapter.unpublish,undefined);
 const pages=context('cloudflare-pages'),cf=new CloudflarePagesWebsiteHostingAdapter({credential:async()=> 'token',probe:goodProbe,fetch:async url=>json({success:true,result:url.includes('/domains')?{id:'domain',status:'pending',validation_data:{status:'pending'}}:{id:'remote',production_branch:'main',subdomain:'site.example.test'}})});
 assert.equal((await cf.domain({target:pages.target,connection:pages.connection,domain,operation:'request'})).state,'verification_pending');assert.equal(pages.target.publicUrl,'https://site.example.test/');
});

test('Pages lost-response reconciliation distinguishes repeated identical content by the exact opaque attempt tag',async()=>{
 const c=context('cloudflare-pages');let posts=0;
 const metadata={commit_hash:c.artifact.marker.slice(0,40),commit_message:cloudflarePagesAttemptTag(c)};
 const adapter=new CloudflarePagesWebsiteHostingAdapter({credential:async()=> 'token',probe:goodProbe,fetch:async(url,init)=>{if(init.method==='POST')posts++;const u=new URL(url);const result=u.pathname.endsWith('/deployments')?[{id:'old',environment:'production',deployment_trigger:{metadata:{...metadata,commit_message:'older-attempt'}}},{id:'new',environment:'production',deployment_trigger:{metadata}}]:u.pathname.endsWith('/deployments/new')?{id:'new',environment:'production',latest_stage:{status:'success'},deployment_trigger:{metadata}}:{id:'remote',canonical_deployment:{id:'new'}};return json({success:true,result});}});
 assert.equal((await adapter.reconcile(c)).releaseId,'new');assert.equal(posts,0);
});
