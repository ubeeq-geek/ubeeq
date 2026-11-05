import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {SqliteWebsiteStore} from '../adapters/local/dist/index.js';
import {WebsiteService,websiteDigest} from '../packages/portability/dist/index.js';
import {websitePreviewFixture} from './website-preview-fixture.mjs';

const count=Number(process.argv[2]??1000),payloadKiB=Number(process.argv[3]??40);
if(!Number.isInteger(count)||count<1||count>2000||!Number.isInteger(payloadKiB)||payloadKiB<1||payloadKiB>120)throw Error('Use 1–2000 images and 1–120 KiB per processed payload.');
// Already-processed synthetic bytes isolate build/storage/delivery costs. Decoding and network latency are excluded.
const assets=Array.from({length:count},(_,index)=>{const bytes=randomBytes(payloadKiB*1024);return {id:'image-'+index,workspaceId:'workspace',revision:1,checksum:websiteDigest(bytes),mimeType:'image/jpeg',bytes,alt:'Image '+index,width:1600,height:1067,approvedPublic:true,metadataStripped:true};});
const snapshot=websitePreviewFixture(assets),store=new SqliteWebsiteStore(':memory:'),actor={actorId:'owner',workspaceId:'workspace'};
const limits={apiVersion:'1',export:true,maxPages:200,maxAssets:2000,maxBytes:256*1024*1024,deploymentAdapters:[]};
const service=new WebsiteService({store,membership:async()=>({...actor,userId:actor.actorId,role:'owner',status:'active'}),creatorIdentityAllowed:async()=>true,capabilities:async()=>limits,resolveSnapshot:async()=>snapshot,evaluateRelease:async()=>({decision:'allow',revision:'policy-1',reasons:[]}),dependenciesEligible:async()=>true,enqueue:async()=>{},audit:async()=>{}});
const timed=async operation=>{const start=performance.now(),value=await operation();return {value,ms:+(performance.now()-start).toFixed(1)};};
try{
 for(const document of snapshot.documents)await store.saveDocument(document,0);await store.saveWebsite(snapshot.website,0);
 const requested=await service.requestBuild(actor,'site',1,'benchmark'),build=await timed(()=>service.execute('workspace',requested.id));assert.equal(build.value.state,'ready');
 // Any accidental fallback to archive retrieval fails this benchmark.
 store.getArtifact=async()=>assert.fail('Preview retrieved the entire archive');
 const manifest=await timed(()=>service.previewManifest(actor,requested.id)),paths=['index.html','assets/theme.css','assets/gallery-viewer.js'].filter(path=>Object.hasOwn(manifest.value.files,path));
 const initial=await timed(()=>service.previewFiles(actor,requested.id,paths));
 const imagePath='assets/'+assets[0].checksum+'.jpg',firstImage=await timed(()=>service.previewFiles(actor,requested.id,[imagePath]));
 const cached=await timed(()=>service.previewFiles(actor,requested.id,[imagePath],{[imagePath]:assets[0].checksum}));
 assert.equal(cached.value.files[0].bytes,undefined);
 console.log(JSON.stringify({images:count,processedPayloadKiB:payloadKiB,buildIncludingStorageMs:build.ms,outputMiB:+(build.value.report.bytes/1024/1024).toFixed(2),files:build.value.report.files,manifestMs:manifest.ms,initialFilesMs:initial.ms,initialFiles:paths,initialBytes:initial.value.files.reduce((sum,file)=>sum+(file.bytes?.length??0),0),firstImageMs:firstImage.ms,cachedImageMs:cached.ms,cachedImageTransferredBytes:0,archiveReads:0},null,2));
}finally{store.close();}
