import test from 'node:test';import assert from 'node:assert/strict';import { createHash } from 'node:crypto';import { posix } from 'node:path';
import ssh2 from 'ssh2';const {Server,utils}=ssh2;import { once } from 'node:events';
import { SftpWebsiteHostingAdapter,connectWebsiteSftp } from '../dist/index.js';
const hash=b=>createHash('sha256').update(b).digest('hex');
function fixture(mode){const records=new Map([['/managed',{directory:true}]]),operations=[];let interrupt=false;
 const session={realpath:async p=>p,stat:async p=>records.get(p)?{directory:!!records.get(p).directory,symlink:!!records.get(p).link}:undefined,list:async p=>[...records.keys()].filter(k=>posix.dirname(k)===p).map(k=>posix.basename(k)),mkdir:async p=>records.set(p,{directory:true}),read:async p=>{const r=records.get(p);if(!r?.bytes)throw new Error('missing '+p);return r.bytes;},write:async(p,bytes)=>{if(interrupt&&p.includes('about')){interrupt=false;throw new Error('connection lost');}operations.push(['write',p]);records.set(p,{bytes});},rename:async(a,b,pointer)=>{operations.push(['rename',b,pointer]);if(!records.has(a))throw new Error('missing temp');records.set(b,records.get(a));records.delete(a);},symlink:async(link,p)=>records.set(p,{link}),readlink:async p=>{if(!records.get(p)?.link)throw new Error('not a link');return records.get(p).link;},remove:async p=>records.delete(p),rmdir:async p=>records.delete(p),close:async()=>{}};
 const target={id:'target',workspaceId:'workspace',accountId:'ssh-user@host',config:{root:'/managed',hostname:'sftp.example.test',port:'22',stagingProtected:'confirmed',retainedAssetsMapping:'confirmed'},ownershipMarker:'owner',publicUrl:'https://public.example.test/',basePath:'/'};
 target.remoteId=hash(JSON.stringify([target.accountId,target.config.hostname,22,'/managed']));
 const connection={family:'sftp',authorization:'ssh_key',state:'connected'},managed=new Set();const adapter=new SftpWebsiteHostingAdapter(mode,{connect:async()=>session,managedFiles:async()=>[...managed],probe:async()=>({associationConfirmed:true,publicConfirmed:false,locations:[],reasons:['public_probe_pending'],observedAt:'now'})});
 const context=(id,text)=>{const digest=hash(id),marker=hash('marker'+id),files=new Map([['assets/'+hash('image')+'.jpg',Buffer.from('image')],['index.html',Buffer.from(text)],['about/index.html',Buffer.from(text)],['ubeeq-release.json',Buffer.from(JSON.stringify({release:marker}))]]);for(const f of files.keys())managed.add(f);const c={target,connection,attemptId:id,generation:1,operation:'publish',artifact:{digest,marker,files},checkpoint:{},beforeActivation:async()=>{},saveCheckpoint:async cp=>c.checkpoint=cp};return c;};
 return {adapter,target,connection,records,operations,context,session,interrupt:()=>interrupt=true};}
test('SFTP pointer capability is probed on the actual protocol; immutable staging and repeat publication switch only current',async()=>{
 const f=fixture('pointer');await f.adapter.validateTarget(f.target,f.connection);assert.ok(f.operations.some(([op,,pointer])=>op==='rename'&&pointer));
 const c=f.context('one','Approved');c.checkpoint=await f.adapter.prepare(c);assert.equal(f.records.has('/managed/current'),false);assert.equal((await f.adapter.activate(c)).state,'activated');assert.equal((await f.adapter.reconcile(c)).state,'activated');
 f.target.activeReleaseId=c.artifact.digest;const next=f.context('two','Updated');next.checkpoint=await f.adapter.prepare(next);assert.equal((await f.adapter.activate(next)).state,'activated');assert.equal((await f.adapter.reconcile(next)).state,'activated');
 f.records.set('/managed/current',{link:'../../private'});await assert.rejects(f.adapter.reconcile(next),{code:'unsafe_sftp_path'});
});
test('in-place SFTP discloses mixed interruption, repairs the same artifact, preserves unrelated files and removes only its private manifest inventory',async()=>{
 const f=fixture('in_place');await f.adapter.validateTarget(f.target,f.connection);assert.equal(f.adapter.capabilities.activation,'in_place');f.records.set('/managed/unrelated.txt',{bytes:Buffer.from('untouched')});
 const c=f.context('one','Approved');await f.adapter.activate(c);f.records.set('/managed/stale.html',{bytes:Buffer.from('old')}); // no managed inventory entry: it must survive.
 const next=f.context('two','Updated');f.interrupt();await assert.rejects(f.adapter.activate(next));assert.equal((await f.adapter.reconcile(next)).state,'unknown');
 await f.adapter.activate(next);assert.equal((await f.adapter.reconcile(next)).state,'activated');assert.equal(Buffer.from(f.records.get('/managed/unrelated.txt').bytes).toString(),'untouched');assert.ok(f.records.has('/managed/stale.html'));
 next.operation='unpublish';await f.adapter.unpublish(next);assert.equal((await f.adapter.reconcile(next)).state,'disabled');assert.ok(f.records.has('/managed/unrelated.txt'));assert.ok(f.records.has('/managed/ubeeq-owner.txt'));
});
test('SFTP rejects symlink roots, unknown ownership and unconfirmed pointer server setup',async()=>{
 const f=fixture('pointer');f.target.config.stagingProtected='';await assert.rejects(f.adapter.validateTarget(f.target,f.connection),{code:'sftp_server_configuration_required'});f.records.set('/managed/ubeeq-owner.txt',{bytes:Buffer.from('another-owner')});await assert.rejects(f.adapter.validateTarget(f.target,f.connection),{code:'hosting_ownership'});f.records.set('/managed',{link:'/private'});await assert.rejects(f.adapter.validateTarget(f.target,f.connection),{code:'unsafe_sftp_root'});
});
test('real SSH transport refuses a changed host key before authentication and requires outbound approval',async t=>{
 const key=utils.generateKeyPairSync('ed25519'),server=new Server({hostKeys:[key.private]},client=>{client.on('error',()=>{});client.on('authentication',ctx=>ctx.reject());});server.on('error',()=>{});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(r=>server.close(r)));
 const target={config:{hostname:'127.0.0.1',port:String(server.address().port),hostKeyFingerprint:'SHA256:'+'A'.repeat(43)}};let authorized=0;
 await assert.rejects(connectWebsiteSftp({target,credential:{username:'test',privateKey:key.private},authorizeHost:async()=>authorized++}),{code:'host_key_changed'});assert.equal(authorized,1);
 await assert.rejects(connectWebsiteSftp({target,credential:{username:'test',privateKey:key.private},authorizeHost:async()=>{throw new Error('outbound denied');}}),/outbound denied/);
});
