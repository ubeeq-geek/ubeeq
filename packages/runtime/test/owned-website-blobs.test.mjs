import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createLocalAdapterSet,SqliteWebsiteStore} from '@ubeeq/adapter-local';
import {WEBSITE_PREVIEW_CHUNK_BYTES as chunk} from '@ubeeq/core';
import {createWebsiteZip} from '@ubeeq/portability';
import {OwnedObjectWrites} from '../dist/owned-object-writes.js';
import {OwnedWebsiteBlobs} from '../dist/owned-website-blobs.js';
const hash=body=>createHash('sha256').update(body).digest('hex');
const home={homeCellId:'cell',dataHomeRegion:'local',dataHomeAssignedAt:'2026-01-01T00:00:00.000Z',routingRevision:1};
async function fixture(t){
 const directory=await mkdtemp(join(tmpdir(),'owned-website-bytes-')),grants=new Map(),settled=new Map(),closed=new Set();let local,writer,blobs,store,deny=false,versions=0;
 const quota={async checkAndReserveQuota(input){if(closed.has(input.idempotencyKey)||deny&&!grants.has(input.idempotencyKey)&&grants.size>=1)return {allowed:false,reasonCode:'STORAGE_QUOTA_EXCEEDED'};grants.set(input.idempotencyKey,input);return {allowed:true};},async recordUsageSettlement(input){const prior=settled.get(input.idempotencyKey);if(prior)assert.deepEqual(prior,input);settled.set(input.idempotencyKey,input);},async closeStorageReservation(input){closed.add(input.idempotencyKey);}};
 const start=()=>{local=createLocalAdapterSet({databasePath:join(directory,'core.sqlite'),dataDirectory:directory,cellId:'cell',publicBaseUrl:'http://localhost'});const complete=local.storage.complete.bind(local.storage);local.storage.complete=async input=>{versions++;return complete(input);};writer=new OwnedObjectWrites(local.repositories,local.storage,quota,'instance','cell');blobs=new OwnedWebsiteBlobs(local.repositories,writer,local.storage,'instance','cell','cell');store=new SqliteWebsiteStore(join(directory,'websites.sqlite'),blobs);};
 start();for(const id of ['creator','other'])await local.repositories.creators.create({id,instanceId:'instance',...home,subjectId:'owner',handle:id,displayName:id});
 t.after(async()=>{store.close();local.database.close();await rm(directory,{recursive:true,force:true});});
 const rows=async()=>(await local.repositories.hostRecords.list({limit:100})).items;
 return {directory,get local(){return local;},get writer(){return writer;},get blobs(){return blobs;},get store(){return store;},get versions(){return versions;},settled,closed,rows,deny(value){deny=value;},restart(){store.close();local.database.close();start();},total(){return [...settled.values()].reduce((sum,v)=>sum+v.storageBytesDelta,0);}};
}
test('website files, ZIP and frozen sources use owned bytes with bounded range reads across restart',async t=>{
 const f=await fixture(t),media=Buffer.alloc(chunk*2+17,5),files=new Map([['index.html',Buffer.from('Home')],['media.pdf',media]]),zip=createWebsiteZip(files),digest=hash(zip);
 await f.store.putArtifact('creator',digest,zip,files);await f.store.putPlan({id:'plan',workspaceId:'creator',snapshotReference:'snapshot',expiresAt:'2020-01-01T00:00:00.000Z'},{assets:[{bytes:media}]});
 assert.equal(f.total(),zip.length+media.length+4);assert.equal(f.store.db.prepare('SELECT sum(length(bytes)) AS n FROM website_blobs').get().n,0);assert.equal(f.store.db.prepare('SELECT sum(length(zip)) AS n FROM website_archives').get().n,0);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM website_blob_chunks').get().n,0);
 const count=f.versions;f.restart();let reads=0;const get=f.local.storage.get.bind(f.local.storage);f.local.storage.get=async input=>{reads++;return get(input);};
 assert.deepEqual(Buffer.from(await f.store.getArtifactFileRange('creator',digest,'media.pdf',chunk-3,chunk+9)),media.subarray(chunk-3,chunk+9));assert.equal(reads,2);
 assert.deepEqual(Buffer.from((await f.store.getSnapshot('creator','snapshot')).assets[0].bytes),media);assert.deepEqual(Buffer.from((await f.store.getArtifact('creator',digest)).zip),zip);
 await f.store.putArtifact('creator',digest,zip,files);assert.equal(f.versions,count);assert.equal(f.total(),zip.length+media.length+4);
 await f.store.removeArtifact('creator',digest);assert.deepEqual(Buffer.from((await f.store.getSnapshot('creator','snapshot')).assets[0].bytes),media);await f.store.cleanupUnacceptedPlans('2026-11-13T00:00:00.000Z',100);
 assert.equal(await f.store.getSnapshot('creator','snapshot'),undefined);assert.deepEqual(Buffer.from(await f.blobs.get('creator',hash(media))),media);assert.equal(f.total(),zip.length+media.length+4,'logical retention cleanup cannot refund retained provider versions');
});
test('a lost manifest commit recovers independently counted chunks without another physical version',async t=>{
 const f=await fixture(t),body=Buffer.from('Accepted before the website manifest commit'),checksum=hash(body),create=f.local.repositories.hostRecords.create.bind(f.local.repositories.hostRecords);let fail=true;
 f.local.repositories.hostRecords.create=async(input,options)=>{if(fail&&input.namespace==='runtime-website-blob'){fail=false;throw Error('Manifest commit unavailable');}return create(input,options);};
 await assert.rejects(f.blobs.put('creator',checksum,body),/Manifest commit unavailable/);assert.equal(f.versions,1);assert.equal(f.total(),body.length);assert.equal(await f.blobs.get('creator',checksum),undefined);
 f.restart();await f.blobs.put('creator',checksum,body);assert.equal(f.versions,1);assert.equal(f.total(),body.length);assert.deepEqual(Buffer.from(await f.blobs.get('creator',checksum)),body);
});
test('a failed website metadata transaction retains charged outputs and retries the same physical versions',async t=>{
 const f=await fixture(t),files=new Map([['index.html',Buffer.from('Home')]]),zip=createWebsiteZip(files),digest=hash(zip),prepare=f.store.db.prepare.bind(f.store.db);let fail=true;
 f.store.db.prepare=sql=>{if(fail&&sql.startsWith('INSERT OR IGNORE INTO website_artifact_manifests')){fail=false;throw Error('Website metadata unavailable');}return prepare(sql);};
 await assert.rejects(f.store.putArtifact('creator',digest,zip,files),/Website metadata unavailable/);assert.equal(f.total(),zip.length+4);assert.equal(await f.store.getArtifactManifest('creator',digest),undefined);const count=f.versions;
 f.restart();await f.store.putArtifact('creator',digest,zip,files);assert.equal(f.versions,count);assert.equal(f.total(),zip.length+4);assert.deepEqual(Buffer.from((await f.store.getArtifact('creator',digest)).zip),zip);
});
test('quota denial midway through a large blob retains accepted bytes without publishing a partial manifest',async t=>{
 const f=await fixture(t),body=Buffer.alloc(chunk+7,9),checksum=hash(body);f.deny(true);
 await assert.rejects(f.blobs.put('creator',checksum,body),{code:'quota_exceeded'});assert.equal(f.versions,1);assert.equal(f.total(),chunk);assert.equal(await f.blobs.get('creator',checksum),undefined);assert.equal(f.closed.size,1);
 f.deny(false);f.restart();await f.blobs.put('creator',checksum,body);assert.equal(f.versions,2);assert.equal(f.total(),body.length);assert.deepEqual(Buffer.from(await f.blobs.get('creator',checksum)),body);
});
test('owned ranges reject corrupt chunks and isolate workspace, instance and immutable identity',async t=>{
 const f=await fixture(t),body=Buffer.from('Private website content'),checksum=hash(body);await f.blobs.put('creator',checksum,body);
 assert.equal(await f.blobs.get('other',checksum),undefined);const foreign=new OwnedWebsiteBlobs(f.local.repositories,f.writer,f.local.storage,'other-instance','cell','cell');await assert.rejects(foreign.get('creator',checksum),{code:'foreign_reference'});
 await assert.rejects(f.blobs.put('creator',checksum,Buffer.from('changed')),{code:'invalid_media'});await assert.rejects(f.blobs.getRange('creator',checksum,0,chunk+1),{code:'invalid_range'});
 const row=(await f.rows()).find(row=>row.namespace==='runtime-owned-object'&&row.value.operation==='website.blob'),object=row.value.completedObject;await f.local.storage.put({object,body:Buffer.from('corrupt')});await assert.rejects(f.blobs.getRange('creator',checksum,0,3),{code:'artifact_unavailable'});assert.equal(f.total(),body.length);assert.equal(f.versions,1);
});
test('website images share owned blobs with frozen sources and retain image references during cleanup',async t=>{
 const f=await fixture(t),bytes=Buffer.from('immutable image bytes'),checksum=hash(bytes),image={id:'website-image-'+checksum,workspaceId:'creator',revision:1,title:'Image',mimeType:'image/webp',checksum,sizeBytes:bytes.length,width:1,height:1};
 await f.store.putWebsiteImage(image,bytes);await f.store.putPlan({id:'plan',workspaceId:'creator',snapshotReference:'snapshot',expiresAt:'2020-01-01T00:00:00.000Z'},{bytes});assert.equal(f.total(),bytes.length);assert.equal(f.versions,1);assert.equal(f.store.db.prepare('SELECT length(bytes) AS n FROM website_images').get().n,0);
 await f.store.cleanupUnacceptedPlans('2026-11-13T00:00:00.000Z',100);f.restart();assert.deepEqual(Buffer.from((await f.store.getWebsiteImage('creator',image.id)).bytes),bytes);assert.equal(await f.store.getWebsiteImage('other',image.id),undefined);assert.equal((await f.store.listWebsiteImages('creator')).length,1);await f.store.putWebsiteImage(image,bytes);assert.equal(f.versions,1);
});
test('retained large SQL blobs remain readable after enabling owned storage without a duplicate legacy copy',async t=>{
 const f=await fixture(t),body=Buffer.alloc(chunk+10,6),checksum=hash(body),files=new Map([['legacy.pdf',body]]),zip=createWebsiteZip(files),digest=hash(zip);
 const legacy=new SqliteWebsiteStore(':memory:');try{await legacy.putArtifact('creator',digest,zip,files);const row=legacy.db.prepare('SELECT manifest,checksum FROM website_artifact_manifests').get();f.store.db.prepare('INSERT INTO website_artifact_manifests(workspace,digest,manifest,checksum) VALUES(?,?,?,?)').run('creator',digest,row.manifest,row.checksum);f.store.db.prepare('INSERT INTO website_artifact_files VALUES(?,?,?,?,?)').run('creator',digest,'legacy.pdf',checksum,body.length);f.store.db.prepare('INSERT INTO website_blobs VALUES(?,?,?)').run('creator',checksum,body);f.store.db.prepare('INSERT INTO website_archives VALUES(?,?,?)').run('creator',digest,zip);}finally{legacy.close();}
 assert.deepEqual(Buffer.from(await f.store.getArtifactFileRange('creator',digest,'legacy.pdf',chunk,chunk+10)),body.subarray(chunk));await f.store.putArtifact('creator',digest,zip,files);assert.equal(f.versions,0);assert.equal(f.total(),0,'retained legacy bytes use the cutover baseline, not a second charge');assert.deepEqual(Buffer.from((await f.store.getArtifact('creator',digest)).zip),zip);
});

test('legacy retention racing a new build fails before dangling references commit and recovers on retry',async t=>{
 const f=await fixture(t),body=Buffer.from('Retained legacy source'),oldFiles=new Map([['media.pdf',body]]),oldZip=createWebsiteZip(oldFiles),oldDigest=hash(oldZip),legacy=new SqliteWebsiteStore(join(f.directory,'websites.sqlite'));
 try{await legacy.putArtifact('creator',oldDigest,oldZip,oldFiles);}finally{legacy.close();}
 const files=new Map([['media.pdf',body],['index.html',Buffer.from('New page')]]),zip=createWebsiteZip(files),digest=hash(zip),put=f.blobs.put.bind(f.blobs);let remove=true;
 f.blobs.put=async(workspace,checksum,bytes)=>{await put(workspace,checksum,bytes);if(remove&&checksum===digest){remove=false;await f.store.removeArtifact('creator',oldDigest);}};
 await assert.rejects(f.store.putArtifact('creator',digest,zip,files),{code:'revision_conflict'});assert.equal(await f.store.getArtifactManifest('creator',digest),undefined);const count=f.versions;
 await f.store.putArtifact('creator',digest,zip,files);assert.equal(f.versions,count+1);assert.deepEqual(Buffer.from(await f.store.getArtifactFile('creator',digest,'media.pdf')),body);assert.equal(f.total(),body.length+zip.length+8);
});

test('an asynchronous provider cannot capture later caller mutations as different website chunks',async t=>{
 const f=await fixture(t),body=Buffer.alloc(chunk+11,7),expected=Buffer.from(body),checksum=hash(body),accept=f.local.storage.accept.bind(f.local.storage);let first=true;
 f.local.storage.accept=async input=>{await accept(input);if(first){first=false;body.fill(9);}};
 await f.blobs.put('creator',checksum,body);assert.deepEqual(Buffer.from(await f.blobs.get('creator',checksum)),expected);assert.equal(f.total(),expected.length);
});

test('legacy inline ZIP projections migrate within the SQL baseline without creating charged owned copies',async t=>{
 const f=await fixture(t),files=new Map([['index.html',Buffer.from('Legacy home')]]),zip=createWebsiteZip(files),digest=hash(zip);
 f.store.db.prepare('INSERT INTO website_artifacts(workspace,digest,zip,files) VALUES(?,?,?,?)').run('creator',digest,zip,JSON.stringify([...files].map(([name,bytes])=>[name,bytes.toString('base64')])));
 assert.equal((await f.store.getArtifactManifest('creator',digest)).files['index.html'].checksum,hash(files.get('index.html')));assert.equal(f.versions,0);assert.equal(f.total(),0);assert.deepEqual(Buffer.from(await f.store.getArtifactFile('creator',digest,'index.html')),files.get('index.html'));assert.deepEqual(Buffer.from((await f.store.getArtifact('creator',digest)).zip),zip);
});
