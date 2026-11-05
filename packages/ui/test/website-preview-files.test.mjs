import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createWebsitePreviewFileBroker,validateWebsitePreviewManifest} from '../dist/website-preview-files.js';
import {WebsiteClient} from '../dist/website-client.js';
import {openWebsitePreview} from '../dist/website-workspace.js';
const hash=value=>createHash('sha256').update(value).digest('hex');
const fixture=()=>{
 const files=Object.fromEntries([['index.html',Buffer.from('<h1>Home</h1>')],['about/index.html',Buffer.from('<h1>About</h1>')],['assets/theme.css',Buffer.from('body{color:black}')],...Array.from({length:1000},(_,index)=>['assets/image-'+index+'.jpg',Buffer.from('image-'+index)])]);
 return {files,manifest:{digest:hash('artifact'),files:Object.fromEntries(Object.entries(files).map(([path,bytes])=>[path,{checksum:hash(bytes),byteLength:bytes.length}]))}};
};

test('preview file broker batches demand, bounds concurrency, and rejects files outside the registered artifact',async()=>{
 const {manifest,files}=fixture();let active=0,peak=0;const calls=[];
 const broker=createWebsitePreviewFileBroker(async(buildId,paths)=>{calls.push({buildId,paths});peak=Math.max(peak,++active);await new Promise(resolve=>setImmediate(resolve));active--;return {digest:manifest.digest,files:Object.fromEntries(paths.map(path=>[path,files[path].toString('base64')]))};});
 broker.register('build',manifest);
 const values=await Promise.all(Array.from({length:23},(_,index)=>broker.request('build','assets/image-'+index+'.jpg')));
 assert.equal(values.length,23);assert.equal(calls.length,3);assert.equal(peak,2);assert.ok(calls.every(call=>call.paths.length<=8));
 await assert.rejects(broker.request('build','../secret'));
 await assert.rejects(broker.request('other','index.html'));assert.equal(calls.length,3);
 const wrong=createWebsitePreviewFileBroker(async()=>({digest:hash('different'),files:{'index.html':'AA=='}}));wrong.register('build',manifest);await assert.rejects(wrong.request('build','index.html'),/expired/);
});

test('browser media cache uses fresh authenticated conditional reads across builds and rejects corrupt bytes',async()=>{
 const {manifest,files}=fixture(),original=globalThis.fetch;let credential='first',restricted=false,corrupt=false,switchCredential=false,bytesTransferred=0;const requests=[];
 globalThis.fetch=async(url,init)=>{
  assert.equal(init.headers.authorization,'Bearer '+credential);assert.equal(init.cache,'no-store');
  if(restricted)return Response.json({error:{message:'Current release is restricted'}},{status:403});
  if(url.endsWith('/preview-manifest'))return Response.json(manifest);
  const body=JSON.parse(init.body);requests.push(body);
  if(switchCredential)credential='third';
  return Response.json({digest:manifest.digest,files:body.paths.map(path=>{
   const entry=manifest.files[path],known=body.knownChecksums[path]===entry.checksum;if(!known)bytesTransferred+=entry.byteLength;
   return {path,checksum:entry.checksum,...(!known?{base64:corrupt?'AAAA':files[path].toString('base64')}:{})};
  })});
 };
 try{
  const client=new WebsiteClient('site',()=>credential,'/v1/websites');await client.previewManifest('build');
  const path='assets/image-0.jpg';assert.equal(atob((await client.previewFiles('build',[path])).files[path]),'image-0');const firstBytes=bytesTransferred;
  await client.previewFiles('build',[path]);assert.equal(bytesTransferred,firstBytes);assert.equal(requests.at(-1).knownChecksums[path],manifest.files[path].checksum);
  await client.previewManifest('next-build');await client.previewFiles('next-build',[path]);assert.equal(bytesTransferred,firstBytes);
  restricted=true;await assert.rejects(client.previewFiles('next-build',[path]),/restricted/);restricted=false;
  credential='second';await client.previewManifest('next-build');await client.previewFiles('next-build',[path]);assert.equal(bytesTransferred,firstBytes*2);
  corrupt=true;await assert.rejects(client.previewFiles('next-build',['assets/image-1.jpg']),/corrupt/);
  corrupt=false;switchCredential=true;await assert.rejects(client.previewFiles('next-build',[path]),/Sign-in changed/);
 }finally{globalThis.fetch=original;}
});

test('opening a 1000-image preview fetches only shell files and never downloads its archive',async()=>{
 const {manifest,files}=fixture(),requested=[];
 const site={id:'site',workspaceId:'workspace',creatorIdentityId:'creator',revision:7,title:'Website',locale:'en',homePageId:'home',theme:{id:'neutral',version:'1',settings:{}},galleryDefault:{destination:{mode:'local'}},mediaMode:'bundled',basePath:'/',pages:[{id:'home',websiteId:'site',workspaceId:'workspace',revision:1,documentId:'doc',kind:'home',title:'Home',slug:'',order:0,state:'ready',navigation:true}],galleryPublicationIds:[],redirects:[]};
 let output='';const popup={closed:false,document:{open(){},write(html){output=html;},close(){},getElementById(){return {textContent:''};},body:{textContent:''}}};
 const client={get:async()=>site,builds:async()=>[{id:'cached',state:'ready',websiteRevision:7,stale:false}],build:async()=>assert.fail('Reusable build'),requestBuild:async()=>assert.fail('Reusable build'),previewSite:async()=>assert.fail('Archive must not be fetched'),previewManifest:async()=>manifest,previewFiles:async(_id,paths)=>{requested.push(...paths);return {digest:manifest.digest,files:Object.fromEntries(paths.map(path=>[path,files[path].toString('base64')]))};}};
 await openWebsitePreview(client,popup,'https://editor.example/');
 assert.deepEqual(requested,['index.html','assets/theme.css']);assert.match(output,/file-request/);assert.match(output,/IntersectionObserver/);assert.doesNotMatch(output,/aW1hZ2UtMA==/);
 assert.match(output,/connect-src 'none'/);assert.match(output,/frame.setAttribute\('sandbox', 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads'\)/);
 assert.ok(output.length<250000,'the preview shell must contain a manifest rather than all image bytes');
});

test('preview manifests reject traversal and oversized projections before fetching bytes',()=>{
 const {manifest}=fixture();assert.equal(validateWebsitePreviewManifest(manifest),manifest);
 for(const path of ['../secret','/secret','a\\secret'])assert.throws(()=>validateWebsitePreviewManifest({...manifest,files:{...manifest.files,[path]:{checksum:hash('x'),byteLength:1}}}));
 assert.throws(()=>validateWebsitePreviewManifest({...manifest,files:{'index.html':{checksum:hash('x'),byteLength:513*1024*1024}}}));
});
