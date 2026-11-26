import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {WEBSITE_PREVIEW_CHUNK_BYTES as chunk} from '@ubeeq/core';
import {WebsiteClient} from '../dist/website-client.js';
const hash=value=>createHash('sha256').update(value).digest('hex');
function fixture(size=chunk*2+17){
  const bytes=Buffer.alloc(size,7),path='assets/large.pdf',manifest={digest:hash('artifact'),files:{'index.html':{checksum:hash('Home'),byteLength:4},[path]:{checksum:hash(bytes),byteLength:size}}};
  const ranges=[];let active=0,peak=0;
  const response=async(url,init)=>{
    if(url.endsWith('/preview-manifest'))return Response.json(manifest);
    assert.equal(init.cache,'no-store');assert.equal(init.redirect,'error');
    assert.equal(init.headers['if-match'],`"${manifest.files[path].checksum}"`);
    const match=/^bytes=(\d+)-(\d+)$/.exec(init.headers.range);assert.ok(match);
    const start=Number(match[1]),end=Number(match[2])+1;assert.ok(end-start<=chunk);ranges.push(start);
    peak=Math.max(peak,++active);await new Promise(resolve=>setImmediate(resolve));active--;
    const body=bytes.subarray(start,end);
    return new Response(body,{status:206,headers:{'content-range':`bytes ${start}-${end-1}/${size}`,etag:`"${manifest.files[path].checksum}"`,'x-website-artifact-digest':manifest.digest,'x-website-chunk-checksum':hash(body)}});
  };
  return {bytes,path,manifest,ranges,response,peak:()=>peak};
}

test('33 MiB files use two bounded range requests, retry only failed chunks and reuse authenticated cached bytes',async t=>{
  const f=fixture(33*1024*1024),original=globalThis.fetch;let failed=false,denied=false,conditional=0;
  t.after(()=>{globalThis.fetch=original;});
  globalThis.fetch=async(url,init)=>{
    if(denied)return Response.json({error:{message:'Access revoked'}},{status:403});
    if(url.endsWith('/preview-files')){conditional++;const body=JSON.parse(init.body);assert.equal(body.knownChecksums[f.path],f.manifest.files[f.path].checksum);return Response.json({digest:f.manifest.digest,files:[{path:f.path,checksum:f.manifest.files[f.path].checksum}]});}
    if(init?.headers.range===`bytes=${chunk*2}-${chunk*3-1}`&&!failed){failed=true;return Response.json({error:{message:'Try again'}},{status:503});}
    return f.response(url,init);
  };
  const client=new WebsiteClient('site',()=> 'session','/websites');
  let progress=0;const result=await client.previewFiles('build',[f.path],()=>{progress++;});
  assert.equal(hash(Buffer.from(result.files[f.path],'base64')),f.manifest.files[f.path].checksum);
  assert.equal(f.ranges.length,Math.ceil(f.bytes.length/chunk));assert.equal(f.peak(),2);assert.equal(failed,true);
  assert.ok(progress>0,'active transfers notify the preview idle timer');
  const reads=f.ranges.length;
  await client.previewFiles('next-build',[f.path]);assert.equal(f.ranges.length,reads);assert.equal(conditional,1);
  denied=true;await assert.rejects(client.previewFiles('next-build',[f.path]),/Access revoked/);assert.equal(f.ranges.length,reads);
});

test('file limits are enforced before fetching and can be configured below the server limit',async t=>{
  const f=fixture(),original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
  globalThis.fetch=f.response;
  const client=new WebsiteClient('site',()=> 'session','/websites',{previewMaxFileBytes:chunk});
  await assert.rejects(client.previewFiles('build',[f.path]),/file size limit/);assert.equal(f.ranges.length,0);
  f.manifest.maxFileBytes=chunk;
  await assert.rejects(new WebsiteClient('site',()=> 'session','/websites').previewFiles('build',[f.path]),/file size limit/);
  delete f.manifest.maxFileBytes;
  f.manifest.files[f.path].byteLength=129*1024*1024;
  await assert.rejects(new WebsiteClient('site',()=> 'session','/websites').previewFiles('build',[f.path]),/file size limit/);assert.equal(f.ranges.length,0);
  assert.throws(()=>new WebsiteClient('site',()=> 'session','/websites',{previewMaxFileBytes:Infinity}));
});

test('bad ranges and corrupt chunks are rejected without caching partial files',async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
  for(const mode of ['ignored','offset','etag','digest','short','oversized','chunk-checksum','file-checksum'])await t.test(mode,async()=>{
    const f=fixture();let corrupt=true;
    globalThis.fetch=async(url,init)=>{
      const response=await f.response(url,init);if(url.endsWith('/preview-manifest')||!corrupt)return response;
      const headers=new Headers(response.headers);let bytes=new Uint8Array(await response.arrayBuffer()),status=206;
      if(mode==='ignored')status=200;
      if(mode==='offset')headers.set('content-range','bytes 1-2/3');
      if(mode==='etag')headers.set('etag',`"${hash('different')}"`);
      if(mode==='digest')headers.set('x-website-artifact-digest',hash('different'));
      if(mode==='short')bytes=bytes.subarray(1);
      if(mode==='oversized')bytes=new Uint8Array(bytes.length+1);
      if(mode==='chunk-checksum')headers.set('x-website-chunk-checksum',hash('different'));
      if(mode==='file-checksum'){bytes[0]^=1;headers.set('x-website-chunk-checksum',hash(bytes));}
      return new Response(bytes,{status,headers});
    };
    const client=new WebsiteClient('site',()=> 'session','/websites');
    await assert.rejects(client.previewFiles('build',[f.path]),/Invalid|corrupt|byte limit/);
    const reads=f.ranges.length;corrupt=false;
    assert.equal(hash(Buffer.from((await client.previewFiles('build',[f.path])).files[f.path],'base64')),f.manifest.files[f.path].checksum);
    assert.ok(f.ranges.length>reads,'partial failures must not enter the file cache');
  });
});

test('revocation and sign-in changes cancel chunk loading without retrying forbidden reads',async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
  for(const mode of ['revoked','credential'])await t.test(mode,async()=>{
    const f=fixture(),requests=[];let credential='first';
    globalThis.fetch=async(url,init)=>{
      if(url.endsWith('/preview-manifest'))return Response.json(f.manifest);
      requests.push(init.headers.authorization);
      if(mode==='revoked'&&init.headers.range.startsWith(`bytes=${chunk}-`))return Response.json({error:{message:'Access revoked'}},{status:403});
      const response=await f.response(url,init);if(mode==='credential')credential='second';return response;
    };
    await assert.rejects(new WebsiteClient('site',()=>credential,'/websites').previewFiles('build',[f.path]),mode==='revoked'?/Access revoked/:/Sign-in changed/);
    assert.ok(requests.length<=2);assert.ok(requests.every(value=>value==='Bearer first'));
  });
});

test('concurrent files share a two-request range limit',async t=>{
  const f=fixture(),original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});globalThis.fetch=f.response;
  const client=new WebsiteClient('site',()=> 'session','/websites');
  await Promise.all([client.previewFiles('one',[f.path]),client.previewFiles('two',[f.path])]);
  assert.equal(f.peak(),2);assert.equal(f.ranges.length,6);
});
