import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,realpath,readdir,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {NativeWebsiteHostingAdapter,nativeWebsiteKey} from '../dist/index.js';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fixture(t){
 const root=await realpath(await mkdtemp(join(tmpdir(),'ubeeq-native-upload-authorization-')));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const adapter=new NativeWebsiteHostingAdapter({id:'local',root,publicUrlTemplate:'https://sites.example/{site}/',persistent:true,writerMode:'single'});
 const target={id:'target',workspaceId:'owner',accountId:'local',remoteId:nativeWebsiteKey('owner','target'),publicUrl:adapter.publicUrl('owner','target'),ownershipMarker:'owner-marker'};
 await adapter.validateTarget(target);
 const bytes=Buffer.from('approved public image'),asset='assets/'+hash(bytes)+'.jpg';
 const artifact={digest:hash('release'),files:new Map([[asset,bytes],['index.html',Buffer.from('Approved content')]])};
 const site=join(root,'targets',target.remoteId);
 return {adapter,target,artifact,site,asset,context:{target,artifact,operation:'publish',generation:1,checkpoint:{},beforeActivation:async()=>{}}};
}
test('native rejects revoked authorization before writing the first payload',async t=>{
 const f=await fixture(t);let calls=0;
 await assert.rejects(f.adapter.prepare({...f.context,beforeUpload:async()=>{calls++;throw Error('revoked');}}),/revoked/);
 assert.equal(calls,1);assert.deepEqual(await readdir(join(f.site,'assets')),[]);
 assert.deepEqual(await readdir(join(f.site,'releases')),[]);
 assert.ok(!(await readdir(f.site)).some(name=>name.startsWith('.staging-')));
});
test('native stops between payloads and removes its private stage while retaining accepted shared bytes',async t=>{
 const f=await fixture(t);let calls=0;
 await assert.rejects(f.adapter.prepare({...f.context,beforeUpload:async()=>{if(++calls===2)throw Error('writer fenced');}}),/writer fenced/);
 assert.equal(calls,2);assert.deepEqual(await readFile(join(f.site,f.asset)),f.artifact.files.get(f.asset));
 assert.deepEqual(await readdir(join(f.site,'releases')),[]);
 assert.ok(!(await readdir(f.site)).some(name=>name.startsWith('.staging-')));
});
test('native rechecks authorization immediately before committing the completed release',async t=>{
 const f=await fixture(t);let calls=0;
 await assert.rejects(f.adapter.prepare({...f.context,beforeUpload:async()=>{if(++calls===f.artifact.files.size+1)throw Error('superseded');}}),/superseded/);
 assert.equal(calls,3);assert.deepEqual(await readdir(join(f.site,'releases')),[]);
 assert.ok(!(await readdir(f.site)).some(name=>name.startsWith('.staging-')));
});
test('native checks authorization when reusing an immutable release without changing retained bytes',async t=>{
 const f=await fixture(t);await f.adapter.prepare(f.context);let calls=0;
 await assert.rejects(f.adapter.prepare({...f.context,beforeUpload:async()=>{calls++;throw Error('revoked');}}),/revoked/);
 assert.equal(calls,1);
 assert.equal(await readFile(join(f.site,'releases',f.artifact.digest,'index.html'),'utf8'),'Approved content');
 let allowedCalls=0;assert.equal((await f.adapter.prepare({...f.context,beforeUpload:async()=>{allowedCalls++;}})).releaseId,f.artifact.digest);
 assert.equal(allowedCalls,2);
});
