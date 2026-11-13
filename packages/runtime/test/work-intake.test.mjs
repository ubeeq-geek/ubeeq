import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalAdapterSet } from '@ubeeq/adapter-local';
import { createCoreRuntime } from '../dist/index.js';
import { createIntakeWork } from '../dist/work-intake.js';
async function fixture(t){
 const directory=await mkdtemp(join(tmpdir(),'work-intake-')),config={databasePath:join(directory,'data.sqlite'),dataDirectory:directory,cellId:'cell',publicBaseUrl:'http://127.0.0.1'};
 const local=createLocalAdapterSet(config),home={homeCellId:'cell',dataHomeRegion:'local',dataHomeAssignedAt:new Date().toISOString(),routingRevision:1};
 const creator=await local.repositories.creators.create({id:'creator',instanceId:'instance',...home,handle:'creator',displayName:'Creator'});
 t.after(async()=>{local.database.close();await rm(directory,{recursive:true,force:true});});
 return {local,creator,config};
}

test('draft and request receipt roll back together and retry with the same stable ID',async t=>{
 const {local,creator}=await fixture(t),create=local.repositories.hostRecords.create.bind(local.repositories.hostRecords);
 local.repositories.hostRecords.create=async()=>{throw Error('Receipt unavailable');};
 await assert.rejects(createIntakeWork(local.repositories,creator,'actor','Title','intent'),/Receipt unavailable/);
 assert.equal((await local.repositories.works.list({limit:100})).items.length,0);
 local.repositories.hostRecords.create=create;
 const work=await createIntakeWork(local.repositories,creator,'actor','Title','intent');
 assert.equal((await createIntakeWork(local.repositories,creator,'actor','Title','intent')).id,work.id);
 assert.equal((await local.repositories.works.list({limit:100})).items.length,1);
});

test('concurrent creation and a lost transaction reply recover one draft while changed input conflicts',async t=>{
 const {local,creator}=await fixture(t),transaction=local.repositories.transaction.bind(local.repositories);let lost=true;
 local.repositories.transaction=async operation=>{const result=await transaction(operation);if(lost){lost=false;throw Error('Lost commit reply');}return result;};
 const works=await Promise.all([createIntakeWork(local.repositories,creator,'actor','Title','intent'),createIntakeWork(local.repositories,creator,'actor','Title','intent')]);
 assert.equal(works[0].id,works[1].id);assert.equal((await local.repositories.works.list({limit:100})).items.length,1);
 await assert.rejects(createIntakeWork(local.repositories,creator,'actor','Changed title','intent'),error=>error.status===409);
 await local.repositories.works.update(works[0].id,works[0].revision,{title:'Edited title',status:'deleted'});
 assert.equal((await createIntakeWork(local.repositories,creator,'actor','Title','intent')).status,'deleted','replay must not recreate or resurrect an edited/deleted Work');
});

test('request receipts isolate actors and creators while unkeyed creation preserves intentional new drafts',async t=>{
 const {local,creator}=await fixture(t);
 const first=await createIntakeWork(local.repositories,creator,'actor','Title','intent');
 const otherActor=await createIntakeWork(local.repositories,creator,'other-actor','Title','intent');
 const secondCreator=await local.repositories.creators.create({id:'second-creator',instanceId:creator.instanceId,homeCellId:creator.homeCellId,dataHomeRegion:creator.dataHomeRegion,dataHomeAssignedAt:creator.dataHomeAssignedAt,routingRevision:creator.routingRevision,handle:'second',displayName:'Second Creator'});
 const otherCreator=await createIntakeWork(local.repositories,secondCreator,'actor','Title','intent');
 assert.equal(new Set([first.id,otherActor.id,otherCreator.id]).size,3);
 const legacy=await createIntakeWork(local.repositories,creator,'actor','Title'),another=await createIntakeWork(local.repositories,creator,'actor','Title');
 assert.notEqual(legacy.id,another.id);
 await assert.rejects(createIntakeWork(local.repositories,creator,'actor','Title','bad/key'),error=>error.status===400);
});

test('the authenticated Work API preserves a keyed draft on retry and rejects changed intent input',async t=>{
 const {local,config}=await fixture(t);
 const runtime=createCoreRuntime({instanceId:'instance',...config,adapters:{repositories:local.repositories,storage:local.storage,uploads:local.storage,delivery:local.storage,jobs:local.jobs,identity:local.identity,localIdentity:local.identity}});
 await new Promise(resolve=>runtime.server.listen(0,'127.0.0.1',resolve));t.after(()=>runtime.close());
 await local.identity.register({email:'operator@example.test',password:'Synthetic password 123!'});
 const {token}=await local.identity.authenticate({email:'operator@example.test',password:'Synthetic password 123!'});
 const base='http://127.0.0.1:'+runtime.server.address().port;
 const request=(path,body,credential=token)=>fetch(base+path,{method:'POST',headers:{authorization:'Bearer '+credential,'content-type':'application/json'},body:JSON.stringify(body)});
 const creator=await (await request('/v1/creators',{handle:'http-creator',displayName:'HTTP Creator'})).json();
 const body={creatorId:creator.creator.id,title:'Retry draft',idempotencyKey:'intake'};
 const first=await request('/v1/works',body);assert.equal(first.status,201);const saved=(await first.json()).work;
 const repeated=await request('/v1/works',body);assert.equal(repeated.status,201);assert.equal((await repeated.json()).work.id,saved.id);
 assert.equal((await request('/v1/works',{...body,title:'Changed'})).status,409);
 assert.equal((await request('/v1/works',body,'invalid-session')).status,401);
});
