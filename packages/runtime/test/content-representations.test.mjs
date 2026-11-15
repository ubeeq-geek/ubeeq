import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import sharp from 'sharp';
import {MemoryCreatorContentStore} from '@ubeeq/persistence';
import {defaultContentPreparation} from '@ubeeq/core';
import {ContentRepresentations,contentPublicationBinding} from '../dist/content-representations.js';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),at='2026-11-15T00:00:00.000Z';
async function fixture(t){
 const directory=await mkdtemp(join(tmpdir(),'content-representations-'));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 const path=key=>{const value=resolve(directory,key);assert.ok(value.startsWith(directory+'/'));return value;};
 const original=await sharp({create:{width:128,height:96,channels:3,background:'#2176a0'}}).png().toBuffer();
 const work={workId:'work',tenantId:'tenant',creatorId:'creator',kind:'image',title:'Original Work',slug:'original',slugHistory:['original'],tags:[],contentRating:'general',aiDisclosure:'none',heavyTopics:[],status:'draft',origin:{type:'upload'},revision:1,createdAt:at,updatedAt:at};
 const asset={assetId:'asset',tenantId:'tenant',creatorId:'creator',kind:'image',status:'ready',mimeType:'image/png',originalFilename:'original.png',sizeBytes:original.length,checksumSha256:hash(original),storage:{mode:'hosted',objectKey:'source.png'},createdAt:at,updatedAt:at};
 class FixtureStore extends MemoryCreatorContentStore {
  sourceFiles=[];
  async getSourceFileById(id){return this.sourceFiles.find(file=>file.fileId===id)??null;}
 }
 const store=new FixtureStore();store.works=[work];store.canonicalAssets=[asset];store.workAssets=[{tenantId:'tenant',workId:'work',assetId:'asset',role:'primary',position:0,altText:'Original blue square'}];
 await writeFile(path('source.png'),original);
 let allowed=true,privateReads=0,sourceReads=0,watermarks=0;const writes=[];
 const descriptor=asset=>({objectKey:asset.storage.objectKey,checksumSha256:asset.checksumSha256,sizeBytes:asset.sizeBytes,mimeType:asset.mimeType,filename:asset.originalFilename});
 const verifiedRead=async(key,size,checksum)=>{const bytes=await readFile(path(key));assert.equal(bytes.length,size);assert.equal(hash(bytes),checksum);return bytes;};
 const host={
  isNativeDestination:destination=>destination==='configured-native',
  // This fixture selects canonical originals; native rendition selection is
  // exercised by the consuming application's unchanged acceptance tests.
  prepareImageRenditions:async()=>[],
  readPublishingSource:async source=>{sourceReads++;assert.equal(source.creatorId,'creator');assert.equal(source.tenantId,'tenant');assert.equal(source.status,'ready');return verifiedRead(source.storage.objectKey,source.sizeBytes,source.checksumSha256);},
  originalFile:descriptor,
  inspectOriginal:async file=>{await verifiedRead(file.storageKey,file.sizeBytes,file.checksumSha256);return file.checksumSha256;},
  creatorWatermark:async()=>({text:'Fixture watermark'}),
  watermarkOverlay:async(mark,width,height)=>{watermarks++;assert.equal(mark.text,'Fixture watermark');return {input:Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="8" fill="white"/></svg>`)};},
  writePrivate:async(key,bytes,mime)=>{assert.equal(mime,'image/png');await mkdir(dirname(path(key)),{recursive:true});await writeFile(path(key),bytes);writes.push({key,checksum:hash(bytes)});},
  readPrivate:async(key,size,checksum)=>{privateReads++;return verifiedRead(key,size,checksum);},
  file:value=>value,
  canReadRepresentation:async(current,sourceIds)=>{assert.equal(current.creatorId,'creator');assert.ok(sourceIds.every(id=>['asset','prepared'].includes(id)));return allowed;}
 };
 const service=new ContentRepresentations(store,{tenantId:'tenant'},host);
 const draft={schemaVersion:1,id:'draft',tenantId:'tenant',creatorId:'creator',actorId:'owner',revision:1,createdAt:at,updatedAt:at,entry:{intent:'work'},checkpoint:'preview',state:'draft',title:work.title,arrangement:'work',arrangementConfirmed:true,collectionType:'gallery',units:[{kind:'work',id:'work',revision:1}],objects:[],previews:[],operationIds:[],settings:{...defaultContentPreparation(),preview:'generated',previewMaxWidth:64,previewWatermark:true}};
 return {store,work,asset,original,draft,host,service,writes,path,deny:()=>{allowed=false;},get privateReads(){return privateReads;},get sourceReads(){return sourceReads;},get watermarks(){return watermarks;}};
}

test('shared previews produce real bounded PNGs, retain private immutable identities and preserve original bytes',async t=>{
 const f=await fixture(t),prepared=await f.service.previews(f.draft),output=prepared.outputs[0],component=output.assets[0];
 assert.equal(prepared.relationships[0].representationIds[0],output.id);assert.equal(component.sourceChecksum,hash(f.original));assert.equal(component.file.mimeType,'image/png');assert.equal(f.watermarks,1);
 const result=await f.service.read(output,component.id),metadata=await sharp(result.bytes).metadata();
 assert.equal(metadata.format,'png');assert.equal(metadata.width,64);assert.equal(metadata.height,48);assert.equal(hash(result.bytes),component.file.checksumSha256);assert.notEqual(hash(result.bytes),hash(f.original));
 assert.deepEqual(await readFile(f.path('source.png')),f.original);
 assert.ok(component.file.objectKey.startsWith('works/tenant/creator/asset/content-previews/'));assert.equal(f.store.publications.length,0);
 const repeated=await f.service.previews(f.draft);assert.deepEqual(repeated,prepared);assert.equal(f.writes[0].key,f.writes[1].key);
});

test('uploaded previews remain byte-for-byte independent and cannot read after source revocation',async t=>{
 const f=await fixture(t),bytes=await sharp({create:{width:8,height:8,channels:3,background:'red'}}).png().toBuffer();
 await writeFile(f.path('prepared.png'),bytes);
 f.store.sourceFiles.push({fileId:'prepared',creatorId:'creator',sourceKind:'image',mimeType:'image/png',storageKey:'prepared.png',originalFilename:'prepared.png',sizeBytes:bytes.length,checksumSha256:hash(bytes),uploadState:'ready',createdAt:at,updatedAt:at});
 f.draft.objects.push({id:'intake',media:'image',role:'preview',targets:['work'],state:'ready',sourceFileId:'prepared',checksum:hash(bytes)});
 const output=(await f.service.previews(f.draft)).outputs[0];assert.equal(output.assets[0].recipe.kind,'uploaded_prepared');assert.equal(f.writes.length,0);assert.equal(f.watermarks,0);
 assert.deepEqual((await f.service.read(output,'intake')).bytes,bytes);
 f.store.sourceFiles[0].restricted=true;
 await assert.rejects(f.service.read(output,'intake'),/Source unavailable/);assert.equal(f.privateReads,1);
 await assert.rejects(f.service.previews(f.draft),error=>error.code==='content_held');
});

test('protected full placements use the configured native destination and cannot become a free reference',async t=>{
 const f=await fixture(t),manifest={schemaVersion:1,id:'retained-preview',subject:f.draft.units[0],kind:'preview',assets:[]};
 const binding={manifest,placements:{protected:{...manifest,id:'protected-full',kind:'full'}}};
 f.store.publications.push({tenantId:'tenant',workId:'work',publicationId:'native',destination:'configured-native',updatedAt:at,providerData:{contentRepresentation:binding}});
 assert.deepEqual(contentPublicationBinding(f.store.publications[0]),binding);
 await assert.rejects(f.service.full(f.work),error=>error.code==='access_unresolved');assert.equal(f.sourceReads,0);
 const full=await f.service.full(f.work,true);assert.equal(full.kind,'full');assert.equal(full.assets[0].file.objectKey,'source.png');assert.equal(f.sourceReads,1);
});

test('every representation read rechecks current policy and source revision before reading private output',async t=>{
 const f=await fixture(t),output=(await f.service.previews(f.draft)).outputs[0];
 f.deny();await assert.rejects(f.service.read(output,'asset'),/Source unavailable/);assert.equal(f.privateReads,0);
 f.host.canReadRepresentation=async()=>true;f.asset.checksumSha256='0'.repeat(64);
 await assert.rejects(f.service.read(output,'asset'),/Source unavailable/);assert.equal(f.privateReads,0);
 await assert.rejects(f.service.read(output,'unapproved'),/Unapproved component/);assert.equal(f.privateReads,0);
});

test('text previews preserve exact chosen ranges and stale content or unavailable recipes cannot create outputs',async t=>{
 const f=await fixture(t);f.work.kind='article';f.work.body=[{blockId:'text',type:'paragraph',text:'Keep the complete original text.'}];
 const output=(await f.service.previews(f.draft,{work:{kind:'text',start:5,end:17}})).outputs[0];
 assert.equal(output.body[0].text,'the complete');assert.equal(output.assets.length,0);assert.equal(f.writes.length,0);assert.equal(f.work.body[0].text,'Keep the complete original text.');
 await assert.rejects(f.service.previews(f.draft,{work:{kind:'text',start:0,end:500}}),error=>error.code==='invalid_input');
 f.work.revision=2;await assert.rejects(f.service.previews(f.draft),error=>error.code==='revision_conflict');assert.equal(f.writes.length,0);
});

test('missing private media and policy host bindings fail before any processing or storage effect',async t=>{
 const f=await fixture(t);
 for(const name of ['isNativeDestination','prepareImageRenditions','readPublishingSource','originalFile','inspectOriginal','creatorWatermark','watermarkOverlay','writePrivate','readPrivate','file','canReadRepresentation'])assert.throws(()=>new ContentRepresentations(f.store,{tenantId:'tenant'},{...f.host,[name]:undefined}),error=>error.code==='unsupported_operation'&&error.status===503);
 assert.equal(f.sourceReads,0);assert.equal(f.writes.length,0);
});
