import test from 'node:test';import assert from 'node:assert/strict';import { createHash } from 'node:crypto';
import { AwsWebsiteHostingAdapter,routeAwsWebsite,awsWebsiteRouterSource,awsWebsiteEmbeddingResponseSource } from '../dist/index.js';
const hash=b=>createHash('sha256').update(b).digest('hex');
test('AWS host and release keys isolate tenants, retain only approved hashed assets and deny disabled/missing/traversal paths before cache lookup',async()=>{
 const one='1'.repeat(32),two='2'.repeat(32),release='a'.repeat(64),asset='assets/'+hash('image')+'.jpg';const data=new Map();
 for(const [host,site] of [['one.example',one],['two.example',two]]){data.set('host:'+host,JSON.stringify({site,release,state:'active',basePath:'/portfolio/'}));data.set('file:'+site+':'+release+':'+hash('index.html'),'1');data.set('file:'+site+':'+release+':'+hash('nested/index.html'),'1');data.set('asset:'+site+':'+hash(asset),'1');}
 const req=(host,uri)=>({uri,headers:{host:{value:host}}}),route=(h,p)=>routeAwsWebsite(req(h,p),async k=>data.get(k),hash);
 assert.equal((await route('one.example','/portfolio/')).uri,`/sites/${one}/releases/${release}/index.html`);assert.equal((await route('two.example','/portfolio/')).uri,`/sites/${two}/releases/${release}/index.html`);
 assert.equal((await route('unknown.example','/portfolio/')).statusCode,404);assert.equal((await route('one.example','/portfolio/%2e%2e/')).statusCode,400);assert.equal((await route('one.example','/portfolio/releases/private/')).statusCode,404);assert.equal((await route('one.example','/portfolio/missing/')).statusCode,404);
 assert.equal((await route('one.example','/portfolio/'+asset)).uri,`/sites/${one}/${asset}`);
 data.set('host:one.example',JSON.stringify({site:one,release:'b'.repeat(64),state:'active',basePath:'/portfolio/'}));assert.equal((await route('one.example','/portfolio/'+asset)).uri,`/sites/${one}/${asset}`);
 data.set('host:one.example',JSON.stringify({site:one,state:'disabled',basePath:'/portfolio/'}));assert.equal((await route('one.example','/portfolio/'+asset)).statusCode,410);
 assert.equal((await routeAwsWebsite(req('one.example','/portfolio/'),async()=>{throw new Error('KVS unavailable');},hash)).statusCode,503);
 assert.match(awsWebsiteRouterSource('arn:example'),/cf\.kvs/);
});
test('AWS adapter privately stages immutable bytes, uses Describe KVS ETag and makes one guarded serving update',async()=>{
 const data=new Map(),objects=new Map();let etag=0,activated=0,guarded=0,embeddingReady=false;
 const profile={id:'managed',accountId:'account',bucket:'private-bucket',keyValueStoreArn:'arn:kvs'},target={id:'target',workspaceId:'w',websiteId:'site',accountId:'account',remoteId:hash(JSON.stringify(['w','target'])).slice(0,32),ownershipMarker:'owner',publicUrl:'https://one.example/',basePath:'/',config:{}};
 const kvs={send:async command=>{const x=command.input;switch(command.constructor.name){case 'GetKeyCommand':if(!data.has(x.Key))throw Object.assign(new Error('missing'),{name:'ResourceNotFoundException'});return {Value:data.get(x.Key)};case 'DescribeKeyValueStoreCommand':return {ETag:String(etag)};case 'UpdateKeysCommand':assert.equal(x.IfMatch,String(etag));etag++;for(const p of x.Puts){data.set(p.Key,p.Value);if(p.Key.startsWith('host:')){assert.equal(guarded,1);activated++;}}return {};default:throw new Error(command.constructor.name);}}};
 const s3={send:async command=>{const x=command.input;assert.equal(x.Bucket,'private-bucket');if(command.constructor.name==='PutObjectCommand'){assert.equal(x.IfNoneMatch,'*');assert.equal(x.ACL,undefined);objects.set(x.Key,x);return {};}if(command.constructor.name==='HeadObjectCommand'){const o=objects.get(x.Key);return {ChecksumSHA256:o.ChecksumSHA256,ContentLength:o.Body.length};}throw new Error(command.constructor.name);}};
 const adapter=new AwsWebsiteHostingAdapter(profile,{s3,kvs,inspect:async()=>({privateBucket:true,originAccessControl:true,hostnameAssociated:true,functionAssociated:true,embeddingPolicyAssociated:embeddingReady}),probe:async()=>({associationConfirmed:true,publicConfirmed:true,observedAt:'now',locations:[],reasons:[]})});
 const c={target,attemptId:'attempt',generation:1,operation:'publish',artifact:{digest:'a'.repeat(64),marker:'b'.repeat(64),files:new Map([['index.html',Buffer.from('Approved')],['embedding.json',Buffer.from(JSON.stringify({mode:'selected',origins:['https://parent.example']}))]]),zip:Buffer.from('zip')},checkpoint:{},beforeActivation:async()=>guarded++,saveCheckpoint:async()=>{}};
 await assert.rejects(adapter.prepare(c),{code:'aws_embedding_infrastructure_required'});embeddingReady=true;c.checkpoint=await adapter.prepare(c);assert.equal(activated,0);assert.equal((await adapter.activate(c)).state,'activated');assert.equal(activated,1);assert.equal(JSON.parse(data.get('host:one.example')).frameAncestors,'https://parent.example');assert.equal((await adapter.reconcile(c)).state,'activated');assert.equal(activated,1);
 // Host ownership is checked again at activation, never inferred solely from account permission.
 data.set('host:one.example',JSON.stringify({owner:'different',site:target.remoteId}));await assert.rejects(adapter.activate(c),{code:'hosting_ownership'});
});
test('standard CloudFront construct synthesizes private OAC origin, JS2 KVS viewer routing and access logs',async()=>{
 const {App,Stack}=await import('aws-cdk-lib');const {Template}=await import('aws-cdk-lib/assertions');const {WebsiteHosting}=await import('../../../deployments/aws-serverless/single-cell/dist/lib/website-hosting.js');
 const app=new App(),stack=new Stack(app,'Hosting',{env:{account:'123456789012',region:'us-east-1'}});new WebsiteHosting(stack,'Websites',{routerSource:awsWebsiteRouterSource,embeddingResponseSource:awsWebsiteEmbeddingResponseSource});const template=Template.fromStack(stack);
 template.resourceCountIs('AWS::CloudFront::OriginAccessControl',1);template.resourceCountIs('AWS::CloudFront::KeyValueStore',1);template.hasResourceProperties('AWS::CloudFront::Function',{FunctionConfig:{Runtime:'cloudfront-js-2.0'}});
 const json=template.toJSON(),bucket=Object.values(json.Resources).filter(r=>r.Type==='AWS::S3::Bucket');assert.equal(bucket.length,2);for(const b of bucket)assert.equal(b.Properties.PublicAccessBlockConfiguration.BlockPublicPolicy,true);
 const distribution=Object.values(json.Resources).find(r=>r.Type==='AWS::CloudFront::Distribution').Properties.DistributionConfig;assert.ok(distribution.Logging);assert.equal(distribution.DefaultCacheBehavior.FunctionAssociations.length,2);assert.ok(distribution.DefaultCacheBehavior.FunctionAssociations.some(a=>a.EventType==='viewer-response'));assert.equal(distribution.CustomErrorResponses[0].ResponseCode,undefined);
});

test('viewer-response embedding policy is per-host, cache-independent, and fails closed',async()=>{
 const {awsWebsiteEmbeddingResponse,awsWebsiteEmbeddingResponseSource}=await import('../dist/index.js');
 const data=new Map([['host:one.example',JSON.stringify({state:'active',frameAncestors:'https://allowed.example https://other.example:8443'})],['host:two.example',JSON.stringify({state:'active',frameAncestors:'*'})]]);
 const response=host=>awsWebsiteEmbeddingResponse({headers:{host:{value:host}}},{statusCode:200,headers:{'content-security-policy':{value:"default-src 'none'; frame-ancestors *"},'x-frame-options':{value:'DENY'}}},async key=>data.get(key));
 assert.equal((await response('one.example')).headers['content-security-policy'].value,"default-src 'none'; frame-ancestors https://allowed.example https://other.example:8443");assert.equal((await response('two.example')).headers['content-security-policy'].value,"default-src 'none'; frame-ancestors *");assert.equal((await response('unknown.example')).headers['content-security-policy'].value,"default-src 'none'; frame-ancestors 'none'");
 data.set('host:one.example',JSON.stringify({state:'active',frameAncestors:"https://allowed.example; script-src *"}));assert.match((await response('one.example')).headers['content-security-policy'].value,/frame-ancestors 'none'$/);assert.equal((await response('two.example')).headers['x-frame-options'],undefined);
 assert.match(awsWebsiteEmbeddingResponseSource('arn:test'),/event.request,event.response/);
});
