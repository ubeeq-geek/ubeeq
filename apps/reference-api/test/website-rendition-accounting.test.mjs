import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import sharp from 'sharp';
import {createReferenceApi} from '../dist/server.js';
import {createDefaultOpenCorePorts,createSingleOperatorTenancyPort} from '@ubeeq/extension-sdk';
async function fixture(t,denyPrewarm=false,options={}){
 const directory=await mkdtemp(join(tmpdir(),'website-owned-rendition-')),calls=[],closed=new Set(),settled=new Map();let adapters,api,origin,deny=denyPrewarm,loseSettlement=Boolean(options.loseSettlement);
 const source=await sharp({create:{width:16,height:12,channels:3,background:'#0000ff'}}).jpeg().withMetadata({exif:{IFD0:{Artist:'PRIVATE ORIGINAL OWNER'}}}).toBuffer();
 const approved=options.samePublic?source:await sharp({create:{width:8,height:6,channels:3,background:'#ff0000'}}).jpeg().withMetadata({exif:{IFD0:{Artist:'PUBLISHED VARIANT METADATA'}}}).toBuffer();
 const quota={async checkAndReserveQuota(input){calls.push(['reserve',input]);return {allowed:!closed.has(input.idempotencyKey)&&!(deny&&input.operation==='website.rendition'),reasonCode:'STORAGE_QUOTA_EXCEEDED'};},async recordUsageSettlement(input){calls.push(['settle',input]);if(settled.has(input.idempotencyKey))assert.deepEqual(settled.get(input.idempotencyKey),input);settled.set(input.idempotencyKey,structuredClone(input));if(loseSettlement&&input.operation==='website.rendition')throw Error('Committed cache settlement reply lost');},async closeStorageReservation(input){closed.add(input.idempotencyKey);calls.push(['close',input]);}};
 const configuration={instanceId:'website-instance',cellId:'website-cell',databasePath:join(directory,'core.sqlite'),dataDirectory:directory,publicBaseUrl:'http://127.0.0.1',hostPorts:ports=>{
  adapters=ports;const creators=async()=>(await ports.repositories.creators.list({limit:100})).items;
  return createDefaultOpenCorePorts({usageQuota:quota,tenancyAndAccess:createSingleOperatorTenancyPort({getOperatorUserId:async()=>(await creators())[0]?.subjectId??null,listOperatorCreatorIds:async actor=>(await creators()).filter(c=>c.subjectId===actor).map(c=>c.id)}),watermarkAndTransform:{async applyDerivativeTransform(){return {bytes:approved,mimeType:'image/jpeg'};}}});
 }};
 const start=async()=>{api=createReferenceApi(configuration);await new Promise(resolve=>api.server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+api.server.address().port;};await start();t.after(async()=>{await api.close();await rm(directory,{recursive:true,force:true});});let token;
 const call=async(path,body,method=body?'POST':'GET')=>{const res=await fetch(origin+path,{method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:res.status,body:res.status===204?undefined:await res.json()};};
 await call('/v1/auth/sign-up',{email:'owner@example.test',password:'Synthetic website password 123!'});token=(await call('/v1/auth/sign-in',{email:'owner@example.test',password:'Synthetic website password 123!'})).body.token;
 const creator=(await call('/v1/creators',{handle:'owner',displayName:'Owner'})).body.creator,work=(await call('/v1/works',{title:'Approved public image'})).body.work;
 const checksum=createHash('sha256').update(source).digest('hex'),upload=(await call('/v1/uploads',{workId:work.id,mimeType:'image/jpeg',checksum,byteLength:source.length})).body.upload;
 await call('/v1/uploads/'+upload.uploadId+'/content',{base64:source.toString('base64')},'PUT');const completed=await call('/v1/uploads/'+upload.uploadId+'/complete',{workId:work.id,checksum,byteLength:source.length});assert.equal(completed.status,202);
 await api.runNextJob('image-worker');const asset=await adapters.repositories.assets.get(completed.body.asset.id);
 const cacheRows=async()=>(await adapters.repositories.hostRecords.list({limit:100})).items.filter(row=>row.namespace==='runtime-owned-object'&&row.value.operation==='website.rendition');
 const checkPixels=async bytes=>{const metadata=await sharp(bytes).metadata();assert.equal(metadata.width,8);assert.equal(metadata.height,6);assert.equal(metadata.exif,undefined);const pixels=await sharp(bytes).removeAlpha().raw().toBuffer();assert.ok(pixels[0]>200&&pixels[2]<30,'website pixels must retain the approved red crop, not the private blue original');};
 const build=async(expectReady=true)=>{
  const publication=(await call('/v1/works/'+work.id+'/publications',{destination:'local'})).body.publication,w=creator.id;
  await call('/v1/websites/documents/doc',{expectedRevision:0,document:{id:'doc',workspaceId:w,revision:1,blocks:[{id:'p',type:'paragraph',text:'Public gallery'}]}},'PUT');
  await call('/v1/websites/site',{expectedRevision:0,website:{id:'site',workspaceId:w,creatorIdentityId:w,revision:1,title:'Gallery',locale:'en',homePageId:'home',theme:{id:'neutral',version:'1',settings:{}},galleryDefault:{destination:{mode:'local'}},mediaMode:'bundled',basePath:'/',pages:[{id:'home',workspaceId:w,websiteId:'site',documentId:'doc',revision:1,kind:'home',title:'Home',slug:'',order:0,state:'ready',navigation:true}],galleryPublicationIds:[publication.id],redirects:[]}},'PUT');
  const build=(await call('/v1/websites/site/builds',{expectedRevision:1,idempotencyKey:'gallery'})).body.build;await api.runNextJob('website-worker');const saved=(await call('/v1/websites/builds/'+build.id)).body.build;if(!expectReady)return saved;assert.equal(saved.state,'ready',JSON.stringify(saved));
  const manifest=(await call('/v1/websites/builds/'+build.id+'/preview-manifest')).body,image=Object.keys(manifest.files).find(path=>path.endsWith('.jpg'));
  const response=await call('/v1/websites/builds/'+build.id+'/preview-files',{paths:[image]});assert.equal(response.status,200);return Buffer.from(response.body.files[0].base64,'base64');
 };
 return {get api(){return api;},get adapters(){return adapters;},asset,source,approved,calls,settled,cacheRows,checkPixels,build,async restart(){await api.close();await start();},restoreSettlement(){loseSettlement=false;},async seedLegacy(bytes,width,height){const db=new DatabaseSync(join(directory,'websites.sqlite'));try{db.prepare('INSERT OR REPLACE INTO website_renditions(workspace,source,bytes,width,height) VALUES(?,?,?,?,?)').run(creator.id,'website-jpeg-1600-v1:'+asset.id+':'+asset.checksum,bytes,width,height);}finally{db.close();}},allow(){deny=false;},clearLegacyCache(){const db=new DatabaseSync(join(directory,'websites.sqlite'));try{db.prepare('DELETE FROM website_renditions').run();}finally{db.close();}},legacyCacheCount(){const db=new DatabaseSync(join(directory,'websites.sqlite'));try{return db.prepare('SELECT COUNT(*) AS n FROM website_renditions').get().n;}finally{db.close();}}};
}
test('a cold website cache uses the approved public variant after prewarming was unavailable',async t=>{
 const f=await fixture(t,true);assert.notEqual(f.asset.storage.checksum,f.asset.checksum);f.clearLegacyCache();f.allow();const bytes=await f.build();await f.checkPixels(bytes);
 const rows=await f.cacheRows(),completed=rows.filter(row=>row.value.phase==='completed');assert.equal(completed.length,1);assert.equal(f.legacyCacheCount(),0);
 const object=completed[0].value.completedObject;assert.equal(object.scope,'private');assert.equal(object.byteLength,bytes.length);assert.equal(createHash('sha256').update(bytes).digest('hex'),object.checksum);
 const settlement=f.calls.filter(([kind,input])=>kind==='settle'&&input.operation==='website.rendition');assert.equal(settlement.length,1);assert.equal(settlement[0][1].storageBytesDelta,bytes.length);assert.equal(settlement[0][1].observedAt,object.writtenAt);
});
test('prewarming preserves the approved crop and creates one metered private cache object without a duplicate SQLite blob',async t=>{
 const f=await fixture(t),rows=await f.cacheRows();assert.equal(rows.filter(row=>row.value.phase==='completed').length,1);
 const object=rows.find(row=>row.value.phase==='completed').value.completedObject;await f.checkPixels((await f.adapters.storage.get(object)).body);assert.equal(f.legacyCacheCount(),0);
 const bytes=await f.build();await f.checkPixels(bytes);assert.equal((await f.cacheRows()).filter(row=>row.value.phase==='completed').length,1);assert.equal(f.calls.filter(([kind,input])=>kind==='settle'&&input.operation==='website.rendition').length,1);
 assert.deepEqual((await f.adapters.storage.get(f.asset.originalStorage)).body,f.source);
});
test('an older cache of private original pixels is retained but never substituted for the approved public variant',async t=>{
 const f=await fixture(t,true),legacy=await sharp(f.source).jpeg().toBuffer();await f.seedLegacy(legacy,16,12);f.allow();const bytes=await f.build();await f.checkPixels(bytes);
 assert.equal(f.legacyCacheCount(),1,'retained legacy bytes require the inventory/deletion protocol');assert.equal((await f.cacheRows()).filter(row=>row.value.phase==='completed').length,1);
});
test('a legacy cache with the same approved input is reused without writing or charging a second copy',async t=>{
 const f=await fixture(t,true,{samePublic:true}),legacy=await sharp(f.source).jpeg().toBuffer();await f.seedLegacy(legacy,16,12);f.allow();assert.deepEqual(await f.build(),legacy);
 assert.equal(f.legacyCacheCount(),1);assert.equal((await f.cacheRows()).filter(row=>row.value.phase==='completed').length,0);assert.equal([...f.settled.values()].filter(input=>input.operation==='website.rendition').length,0);
});
test('cache receipts survive a lost settlement acknowledgement and restart without another physical version',async t=>{
 const f=await fixture(t,false,{loseSettlement:true}),row=(await f.cacheRows()).find(row=>row.value.phase==='completed'),object=row.value.completedObject;
 assert.equal((await f.adapters.repositories.hostRecords.get(row.value.usageIntentId)).value.state,'pending');assert.equal([...f.settled.values()].filter(input=>input.operation==='website.rendition').length,1);
 f.restoreSettlement();await f.restart();await f.checkPixels(await f.build());const saved=(await f.cacheRows()).find(row=>row.value.phase==='completed');assert.equal(saved.value.completedObject.versionId,object.versionId);assert.equal((await f.adapters.repositories.hostRecords.get(saved.value.usageIntentId)).value.state,'settled');assert.equal([...f.settled.values()].filter(input=>input.operation==='website.rendition').length,1);
});
test('corrupt cache bytes fail closed instead of being exported or silently replaced under the same receipt',async t=>{
 const f=await fixture(t),row=(await f.cacheRows()).find(row=>row.value.phase==='completed');await f.adapters.storage.put({object:row.value.completedObject,body:Buffer.from('Corrupted fixture bytes')});
 const failed=await f.build(false);assert.equal(failed.state,'failed');assert.equal(failed.errorCode,'invalid_media');assert.equal((await f.cacheRows()).filter(row=>row.value.phase==='completed').length,1);assert.equal([...f.settled.values()].filter(input=>input.operation==='website.rendition').length,1);
 assert.deepEqual((await f.adapters.storage.get(f.asset.originalStorage)).body,f.source);
});
