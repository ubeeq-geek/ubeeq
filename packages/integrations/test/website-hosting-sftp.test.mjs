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
test('SFTP pointer checks upload authority before the first payload and between private release files',async()=>{
 const f=fixture('pointer');await f.adapter.validateTarget(f.target,f.connection);f.operations.length=0;
 const c=f.context('revoked','Approved');c.beforeUpload=async()=>{throw Error('revoked');};
 await assert.rejects(f.adapter.prepare(c),/revoked/);assert.deepEqual(f.operations,[]);
 let checks=0;c.beforeUpload=async()=>{if(++checks===2)throw Error('writer fenced');};
 await assert.rejects(f.adapter.prepare(c),/writer fenced/);
 assert.equal(checks,2);assert.equal(f.operations.length,1);
 const asset=[...c.artifact.files.keys()][0];
 assert.ok(f.records.has('/managed/releases/'+c.artifact.digest+'/'+asset));
 assert.equal(f.records.has('/managed/'+asset),false);assert.equal(f.records.has('/managed/current'),false);
});
test('SFTP pointer stops between files, closes its session and can resume the same immutable artifact',async()=>{
 const f=fixture('pointer');await f.adapter.validateTarget(f.target,f.connection);
 const c=f.context('interrupted','Approved');let checks=0,closed=0;
 f.session.close=async()=>{closed++;};c.beforeUpload=async()=>{if(++checks===3)throw Error('superseded');};
 await assert.rejects(f.adapter.prepare(c),/superseded/);assert.equal(closed,1);
 assert.equal(f.records.has('/managed/releases/'+c.artifact.digest+'/index.html'),true);
 assert.equal(f.records.has('/managed/releases/'+c.artifact.digest+'/about/index.html'),false);
 const retained=f.operations.filter(([op])=>op==='write').length;
 c.beforeUpload=async()=>{};c.checkpoint=await f.adapter.prepare(c);
 assert.equal((await f.adapter.activate(c)).state,'activated');assert.equal((await f.adapter.reconcile(c)).state,'activated');
 assert.equal(f.operations.filter(([op,path])=>op==='write'&&path.endsWith('.jpg')).length,1);
 assert.ok(f.operations.some(([op,path])=>op==='rename'&&path.startsWith('/managed/assets/')));
 assert.ok(f.operations.filter(([op])=>op==='write').length>retained);
 const writes=f.operations.length;c.beforeUpload=async()=>{throw Error('offboarded');};
 await assert.rejects(f.adapter.prepare(c),/offboarded/);assert.equal(f.operations.length,writes);
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
 await assert.rejects(connectWebsiteSftp({target:{...target,config:{...target.config,hostname:'must-not-resolve.invalid'}},credential:{username:'test',privateKey:key.private},authorizeHost:async()=> '127.0.0.1'}),{code:'host_key_changed'});
});


test('pointer SFTP never exposes a newly prepared asset through an already-active retained mapping', async()=>{
 const f=fixture('pointer');await f.adapter.validateTarget(f.target,f.connection);
 const first=f.context('active','Approved');first.checkpoint=await f.adapter.prepare(first);await f.adapter.activate(first);f.target.activeReleaseId=first.artifact.digest;
 const next=f.context('private-next','Next'),bytes=Buffer.from('new staged image'),asset='assets/'+hash(bytes)+'.jpg';next.artifact.files.set(asset,bytes);
 next.checkpoint=await f.adapter.prepare(next);
 assert.equal(f.records.has('/managed/'+asset),false);
 next.beforeActivation=async()=>{throw Error('approval revoked');};await assert.rejects(f.adapter.activate(next),/approval revoked/);
 assert.equal(f.records.has('/managed/'+asset),false);
 let checks=0;next.beforeActivation=async()=>{if(++checks===2)throw Error('revoked after private temp write');};
 await assert.rejects(f.adapter.activate(next),/revoked after private temp write/);
 assert.equal(f.records.has('/managed/'+asset),false);
 assert.ok(![...f.records.keys()].some(path=>path.includes('/.asset-')));
 next.beforeActivation=async()=>{};await f.adapter.activate(next);
 assert.deepEqual(f.records.get('/managed/'+asset).bytes,bytes);
 assert.ok(!f.operations.some(([op,path])=>op==='write'&&path.startsWith('/managed/assets/')),'public assets are promoted atomically from protected private bytes');
});

test('pointer SFTP refuses changed staged assets before publishing retained bytes',async()=>{
 const f=fixture('pointer');await f.adapter.validateTarget(f.target,f.connection);
 const c=f.context('tampered','Approved');c.checkpoint=await f.adapter.prepare(c);
 const asset=[...c.artifact.files.keys()][0];f.records.set('/managed/releases/'+c.artifact.digest+'/'+asset,{bytes:Buffer.from('tampered')});
 await assert.rejects(f.adapter.activate(c),{code:'release_drift'});
 assert.equal(f.records.has('/managed/'+asset),false);assert.equal(f.records.has('/managed/current'),false);
});
