import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {SqliteWebsiteStore} from '../dist/index.js';
import {createWebsiteZip} from '../../../packages/portability/dist/index.js';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');

test('artifacts and frozen publish snapshots share blobs across releases, survive restart and isolate workspaces',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'website-blobs-')),path=join(directory,'websites.sqlite');t.after(()=>rmSync(directory,{recursive:true,force:true}));
 let store=new SqliteWebsiteStore(path);const sql=new DatabaseSync(path);t.after(()=>{store.close();sql.close();});
 const media=new Uint8Array([1,2,3,4]),mediaPath='assets/'+hash(media)+'.jpg';
 const files=new Map([['index.html',Buffer.from('First')],[mediaPath,media]]),zip=createWebsiteZip(files),digest=hash(zip);
 await store.putArtifact('one',digest,zip,files);
 const second=new Map(files);second.set('index.html',Buffer.from('Second'));const secondZip=createWebsiteZip(second);
 await store.putArtifact('one',hash(secondZip),secondZip,second);
 const plan={id:'plan',workspaceId:'one',snapshotReference:'snapshot'};
 await store.putPlan(plan,{assets:[{id:'image',bytes:media}]});
 assert.equal(sql.prepare('SELECT count(*) AS count FROM website_blobs').get().count,3);
 assert.equal(sql.prepare('SELECT count(*) AS count FROM website_artifacts').get().count,0);
 assert.ok(!sql.prepare("SELECT payload FROM website_records WHERE kind='publish_snapshot'").get().payload.includes('__websiteBytes'));
 const before=store.cacheRevision();sql.prepare("INSERT INTO website_records(workspace,kind,id,revision,payload) VALUES('one','test','revision',1,'{}')").run();assert.notEqual(store.cacheRevision(),before);
 store.close();store=new SqliteWebsiteStore(path);
 assert.deepEqual(await store.getArtifactFile('one',digest,mediaPath),media);assert.equal(await store.getArtifactFile('other',digest,mediaPath),undefined);
 assert.deepEqual((await store.getSnapshot('one','snapshot')).assets[0].bytes,media);
 await store.removeArtifact('one',digest);assert.equal(await store.getArtifactManifest('one',digest),undefined);
 assert.deepEqual((await store.getSnapshot('one','snapshot')).assets[0].bytes,media);
 assert.deepEqual(await store.getArtifactFile('one',hash(secondZip),mediaPath),media);
 sql.prepare('UPDATE website_blobs SET bytes=? WHERE workspace=? AND checksum=?').run(Buffer.from('corrupt'),'one',hash(media));
 await assert.rejects(store.getArtifactFile('one',hash(secondZip),mediaPath),{code:'artifact_unavailable'});
});

test('legacy artifacts migrate once, and mismatched ZIP/file projections are rejected',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'website-legacy-')),path=join(directory,'websites.sqlite'),store=new SqliteWebsiteStore(path),sql=new DatabaseSync(path);
 t.after(()=>{store.close();sql.close();rmSync(directory,{recursive:true,force:true});});
 const files=new Map([['index.html',Buffer.from('Legacy')]]),zip=createWebsiteZip(files),digest=hash(zip);
 sql.prepare('INSERT INTO website_artifacts(workspace,digest,zip,files) VALUES(?,?,?,?)').run('one',digest,zip,JSON.stringify([...files].map(([name,bytes])=>[name,bytes.toString('base64')])));
 assert.equal((await store.getArtifactManifest('one',digest)).files['index.html'].checksum,hash(files.get('index.html')));
 sql.prepare('DELETE FROM website_artifacts').run();assert.equal(Buffer.from(await store.getArtifactFile('one',digest,'index.html')).toString(),'Legacy');
 await assert.rejects(store.putArtifact('one',digest,zip,new Map([['index.html',Buffer.from('Wrong')]])),{code:'artifact_conflict'});
});

test('review cleanup collects orphaned blobs while preserving accepted frozen sources',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'website-blob-retention-')),path=join(directory,'websites.sqlite'),store=new SqliteWebsiteStore(path),sql=new DatabaseSync(path);
 t.after(()=>{store.close();sql.close();rmSync(directory,{recursive:true,force:true});});
 const discarded=Buffer.from('unaccepted media'),accepted=Buffer.from('accepted source');
 for(const [id,bytes]of [['discarded',discarded],['accepted',accepted]])await store.putPlan({id,workspaceId:'one',snapshotReference:id+'-snapshot',expiresAt:'2020-01-01T00:00:00.000Z'},{assets:[{bytes}]});
 sql.prepare("INSERT INTO website_records(workspace,kind,id,revision,payload) VALUES('one','publish_intent','intent',1,?)").run(JSON.stringify({planId:'accepted'}));
 assert.equal(await store.cleanupUnacceptedPlans('2026-11-05T00:00:00.000Z',100),1);
 assert.equal(await store.getSnapshot('one','discarded-snapshot'),undefined);
 assert.deepEqual(Buffer.from((await store.getSnapshot('one','accepted-snapshot')).assets[0].bytes),accepted);
 assert.equal(sql.prepare('SELECT count(*) AS count FROM website_blobs').get().count,1);
});
