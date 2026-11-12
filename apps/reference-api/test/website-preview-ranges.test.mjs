import test from 'node:test';
import assert from 'node:assert/strict';
import {WebsiteService,buildWebsiteArtifact,websiteDigest} from '@ubeeq/portability';
import {WEBSITE_PREVIEW_CHUNK_BYTES as chunk} from '@ubeeq/core';
import {SqliteWebsiteStore} from '@ubeeq/adapter-local';
import {WebsiteClient} from '@ubeeq/ui';
import {handleWebsiteRequest} from '../dist/websites.js';
import {websitePreviewFixture} from '../../../scripts/website-preview-fixture.mjs';

async function fixture(t){
 const bytes=Buffer.alloc(33*1024*1024,32);bytes.write('%PDF-1.4\n');
 const asset={id:'pdf',workspaceId:'workspace',revision:1,checksum:websiteDigest(bytes),mimeType:'application/pdf',bytes,approvedPublic:true,metadataStripped:true};
 const snapshot=websitePreviewFixture([asset]);snapshot.website.galleryPublicationIds=[];snapshot.website.namedGalleries=[];snapshot.galleries=[];
 for(const document of snapshot.documents)document.blocks=[{id:'file',type:'file',fileId:'pdf',text:'Download PDF'}];
 const artifact=buildWebsiteArtifact(snapshot,{maxPages:2000,maxAssets:2000,maxBytes:256*1024*1024}),store=new SqliteWebsiteStore(':memory:');t.after(()=>store.close());
 await store.saveWebsite(snapshot.website,0);await store.putArtifact('workspace',artifact.digest,artifact.zip,artifact.files);
 await store.saveBuild({id:'build',workspaceId:'workspace',websiteId:'site',websiteRevision:1,creatorIdentityId:'creator',revision:1,state:'ready',dependencies:[],artifactDigest:artifact.digest,expiresAt:'2099-01-01T00:00:00Z'},0);
 store.getArtifact=async()=>assert.fail('Range previews must not read the archive');store.getArtifactFile=async()=>assert.fail('Range previews must not load whole files');
 let allowed=true,member=true;const actor={workspaceId:'workspace',actorId:'owner'},ports={store,membership:async()=>({workspaceId:'workspace',userId:'owner',role:'owner',status:member?'active':'removed'}),creatorIdentityAllowed:async()=>true,capabilities:async()=>({export:true}),evaluateRelease:async()=>({decision:allowed?'allow':'hold',revision:'1'}),dependenciesEligible:async()=>allowed,audit:async()=>{}};
 const service=new WebsiteService(ports),path=[...artifact.files.keys()].find(path=>path.endsWith('.pdf'));
 const call=async(headers={},file=path)=>{
  const values=new Map();let body,statusCode=200;
  const response={setHeader:(name,value)=>values.set(name,String(value)),get statusCode(){return statusCode;},set statusCode(value){statusCode=value;},end:value=>{body=value;}};
  await handleWebsiteRequest({service,actor,request:{method:'GET',headers},response,url:new URL('https://local/v1/websites/builds/build/preview-file?file='+encodeURIComponent(file)),body:async()=>({})});
  return {headers:values,statusCode,body};
 };
 return {bytes,artifact,store,actor,service,ports,path,call,setAllowed:value=>{allowed=value;},setMember:value=>{member=value;}};
}

test('a real 33 MiB artifact loads through authenticated binary ranges without archive or whole-file reads',async t=>{
 const f=await fixture(t),original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});let reads=0;
 globalThis.fetch=async(url,init)=>{
  assert.equal(init.headers.authorization,'Bearer session');
  if(url.endsWith('/preview-manifest'))return Response.json(await f.service.previewManifest(f.actor,'build'));
  if(url.endsWith('/preview-files')){const body=JSON.parse(init.body);const result=await f.service.previewFiles(f.actor,'build',body.paths,body.knownChecksums);return Response.json({digest:result.digest,files:result.files.map(file=>({path:file.path,checksum:file.checksum}))});}
  reads++;const result=await f.call(init.headers);return new Response(result.body,{status:result.statusCode,headers:Object.fromEntries(result.headers)});
 };
 const client=new WebsiteClient('site',()=> 'session','/v1/websites'),result=await client.previewFiles('build',[f.path]);
 assert.equal(websiteDigest(Buffer.from(result.files[f.path],'base64')),websiteDigest(f.bytes));assert.equal(reads,17);
 f.store.getArtifactFile=undefined;
 await client.previewFiles('build',[f.path]);assert.equal(reads,17,'authenticated checksum hits do not retransmit large files');
 const partial=await f.call({range:'bytes=1-7','if-match':`"${websiteDigest(f.bytes)}"`});
 assert.equal(partial.statusCode,206);assert.equal(partial.headers.get('content-range'),`bytes 1-7/${f.bytes.length}`);assert.equal(partial.headers.get('cache-control'),'private, no-store');
 assert.deepEqual(Buffer.from(partial.body),f.bytes.subarray(1,8));
});

test('range boundaries, pinned checksums and configured file limits are enforced',async t=>{
 const f=await fixture(t),etag=`"${websiteDigest(f.bytes)}"`;
 for(const range of ['bytes=0-2097152','bytes=34603008-34603009','bytes=8-7','bytes=-0','bytes=0-1,5-6','bytes=9007199254740992-9007199254740993']){
  const result=await f.call({range,'if-match':etag});assert.equal(result.statusCode,416,range);assert.equal(result.headers.get('content-range'),`bytes */${f.bytes.length}`);
 }
 assert.equal((await f.call({range:'bytes=0-3','if-match':'"wrong"'})).statusCode,412);
 assert.equal((await f.call({range:'bytes=-7','if-match':etag})).statusCode,206);
 assert.equal((await f.call({range:`bytes=${f.bytes.length-7}-`,'if-match':etag})).statusCode,206);
 await assert.rejects(new WebsiteService({...f.ports,previewMaxFileBytes:chunk}).previewFileRange(f.actor,'build',f.path,0,4,websiteDigest(f.bytes)),{code:'preview_file_too_large'});
});

test('chunk reads recheck authorization and policy after storage IO, including cache hits',async t=>{
 const f=await fixture(t),hash=websiteDigest(f.bytes),read=f.store.getArtifactFileRange.bind(f.store);
 f.store.getArtifactFileRange=async(...args)=>{const bytes=await read(...args);f.setAllowed(false);return bytes;};
 await assert.rejects(f.service.previewFileRange(f.actor,'build',f.path,0,7,hash),{code:'release_restricted'});
 f.setAllowed(true);f.store.getArtifactFileRange=async(...args)=>{const bytes=await read(...args);f.setMember(false);return bytes;};
 await assert.rejects(f.service.previewFileRange(f.actor,'build',f.path,0,7,hash),{code:'authorization_denied'});
 await assert.rejects(f.service.previewFiles(f.actor,'build',[f.path],{[f.path]:hash}),{code:'authorization_denied'});
});
