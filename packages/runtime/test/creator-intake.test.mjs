import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalAdapterSet } from '@ubeeq/adapter-local';
import { createCoreRuntime } from '../dist/index.js';
import { createIntakeCreator } from '../dist/creator-intake.js';

async function localFixture(t) {
 const directory=await mkdtemp(join(tmpdir(),'creator-intake-')),local=createLocalAdapterSet({databasePath:join(directory,'data.sqlite'),dataDirectory:directory,cellId:'cell',publicBaseUrl:'http://localhost'});
 t.after(async()=>{local.database.close();await rm(directory,{recursive:true,force:true});});
 const home={homeCellId:'cell',dataHomeRegion:'local',dataHomeAssignedAt:new Date().toISOString(),routingRevision:1},input={instanceId:'instance',cellId:'cell',region:'local',actorId:'actor',handle:'actor',displayName:'Actor',idempotencyKey:'request'};
 let creates=0;const create=(selected=input)=>async(transaction,id)=>{creates++;const creator=await local.repositories.creators.create({id,instanceId:input.instanceId,...home,subjectId:selected.actorId,handle:selected.handle,displayName:selected.displayName},{transaction});return creator;};
 return {local,home,input,create,creates:()=>creates};
}
test('Creator and request receipt roll back together when receipt persistence fails',async t=>{
 const f=await localFixture(t),records=f.local.repositories.hostRecords,save=records.create.bind(records);records.create=async()=>{throw Error('Receipt unavailable');};
 await assert.rejects(createIntakeCreator(f.local.repositories,f.input,f.create()),/Receipt unavailable/);assert.equal((await f.local.repositories.creators.list({limit:100})).items.length,0);
 records.create=save;const creator=await createIntakeCreator(f.local.repositories,f.input,f.create());assert.equal((await createIntakeCreator(f.local.repositories,f.input,f.create())).id,creator.id);assert.equal((await f.local.repositories.creators.list({limit:100})).items.length,1);
});
test('unknown commit replies and concurrent keyed creation recover one Creator without repeating preparation',async t=>{
 const f=await localFixture(t),transaction=f.local.repositories.transaction.bind(f.local.repositories);let lost=true;
 f.local.repositories.transaction=async run=>{const result=await transaction(run);if(lost){lost=false;throw Error('Accepted response lost');}return result;};
 const result=await Promise.all([createIntakeCreator(f.local.repositories,f.input,f.create()),createIntakeCreator(f.local.repositories,f.input,f.create())]);assert.equal(result[0].id,result[1].id);assert.equal(f.creates(),1);
 const edited=await f.local.repositories.creators.update(result[0].id,result[0].revision,{displayName:'Edited profile'});assert.equal((await createIntakeCreator(f.local.repositories,f.input,f.create())).displayName,edited.displayName);
 await assert.rejects(createIntakeCreator(f.local.repositories,{...f.input,handle:'changed'},f.create()),error=>error.status===409);assert.equal(f.creates(),1);
});
test('Creator request identities isolate actors and unkeyed calls retain intentional new profiles',async t=>{
 const f=await localFixture(t),first=await createIntakeCreator(f.local.repositories,f.input,f.create()),other={...f.input,actorId:'other',handle:'other'};
 const second=await createIntakeCreator(f.local.repositories,other,f.create(other));assert.notEqual(first.id,second.id);
 const a=await createIntakeCreator(f.local.repositories,{...f.input,idempotencyKey:undefined,handle:'a'},f.create({...f.input,handle:'a'})),b=await createIntakeCreator(f.local.repositories,{...f.input,idempotencyKey:undefined,handle:'b'},f.create({...f.input,handle:'b'}));assert.notEqual(a.id,b.id);
 await assert.rejects(createIntakeCreator(f.local.repositories,{...f.input,idempotencyKey:'invalid/key'},f.create()),error=>error.status===400);
});

async function httpFixture(t,creatorLifecycle,overrides={}){
 const directory=await mkdtemp(join(tmpdir(),'creator-lifecycle-http-')),runtime=createCoreRuntime({databasePath:join(directory,'data.sqlite'),dataDirectory:directory,cellId:'cell',region:'local',instanceId:'instance',publicBaseUrl:'http://localhost',...overrides,creatorLifecycle});
 await new Promise(resolve=>runtime.server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await runtime.close();await rm(directory,{recursive:true,force:true});});
 const request=async(path,body,token)=>{const r=await fetch(`http://127.0.0.1:${runtime.server.address().port}`+path,{method:body?'POST':'GET',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json()};};
 const signIn=async email=>{assert.equal((await request('/v1/auth/sign-up',{email,password:'Synthetic password 123!'})).status,201);return(await request('/v1/auth/sign-in',{email,password:'Synthetic password 123!'})).body.token;};return {request,signIn};
}
const writeBirth=async({creator,actorUserId,repositories,transaction})=>{assert.equal(Object.isFrozen(creator),true);assert.equal(creator.subjectId,actorUserId);await repositories.hostRecords.create({id:'birth-'+creator.id,instanceId:creator.instanceId,homeCellId:creator.homeCellId,dataHomeRegion:creator.dataHomeRegion,dataHomeAssignedAt:creator.dataHomeAssignedAt,routingRevision:creator.routingRevision,namespace:'test-birth',scopeId:creator.id,key:'birth',value:{actorUserId,creatorId:creator.id}},{transaction});};
test('failed host preparation rolls back Creator, birth receipt and first-operator claim',async t=>{
 let fail=true,repositories,prepares=0,activations=0;
 const f=await httpFixture(t,{prepare:async input=>{repositories=input.repositories;prepares++;await writeBirth(input);if(fail)throw Error('Preparation unavailable');},activate:async()=>{activations++;return{state:'ready'};}}),first=await f.signIn('first@example.test'),second=await f.signIn('second@example.test');
 assert.equal((await f.request('/v1/creators',{handle:'first',displayName:'First',idempotencyKey:'first'},first)).status,500);assert.equal((await repositories.creators.list({limit:100})).items.length,0);assert.equal((await repositories.hostRecords.list({limit:100})).items.length,0);assert.equal(activations,0);
 fail=false;const body={handle:'second',displayName:'Second',idempotencyKey:'second'},result=await f.request('/v1/creators',body,second);assert.equal(result.status,201);assert.equal(result.body.provisioning.state,'ready');assert.equal((await f.request('/v1/creators',body,second)).body.creator.id,result.body.creator.id);assert.equal(prepares,2);assert.equal(activations,2);
});
test('deferred post-commit activation returns the persisted Creator and retries the same receipt',async t=>{
 let prepares=0,activations=0;const f=await httpFixture(t,{prepare:async input=>{prepares++;await writeBirth(input);},activate:async input=>{assert.equal(Object.isFrozen(input.creator),true);activations++;if(activations===1)throw Error('Synthetic activation outage');return{state:'ready'};}}),token=await f.signIn('owner@example.test'),body={handle:'owner',displayName:'Owner',idempotencyKey:'creation'};
 const pending=await f.request('/v1/creators',body,token);assert.equal(pending.status,202);assert.equal(pending.body.provisioning.state,'pending');const ready=await f.request('/v1/creators',body,token);assert.equal(ready.status,201);assert.equal(ready.body.creator.id,pending.body.creator.id);assert.equal(ready.body.provisioning.state,'ready');assert.equal(prepares,1);assert.equal(activations,2);assert.equal((await f.request('/v1/creators',undefined,token)).body.creators.length,1);
 assert.equal((await f.request('/v1/creators',{...body,displayName:'Changed'},token)).status,409);
});
test('host preparation without synchronous activation reports pending and does not claim readiness',async t=>{
 let prepares=0;const f=await httpFixture(t,{prepare:async input=>{prepares++;await writeBirth(input);}}),token=await f.signIn('pending@example.test'),result=await f.request('/v1/creators',{handle:'pending',displayName:'Pending',idempotencyKey:'pending'},token);
 assert.equal(result.status,202);assert.equal(result.body.provisioning.state,'pending');assert.equal(prepares,1);
});
test('replaying a saved Creator request cannot reactivate it after the host revokes access',async t=>{
 let allowed=true,activations=0,prepares=0;const tenancy={mode:'multi_tenant_saas',async assertCanCreateCreatorUser(){},async assertCanCreateCustomerAccount(){},async listAccessibleCreatorIds(){return[];},async resolveCreatorRole(){return allowed?'owner':null;},isContributorManagementEnabled:()=>true,isOrganizationManagementEnabled:()=>true};
 const f=await httpFixture(t,{prepare:async input=>{prepares++;await writeBirth(input);},activate:async()=>{activations++;return{state:'ready'};}},{tenancy}),token=await f.signIn('revoked@example.test'),body={handle:'revoked',displayName:'Revoked',idempotencyKey:'same-request'};
 assert.equal((await f.request('/v1/creators',body,token)).status,201);allowed=false;const denied=await f.request('/v1/creators',body,token);assert.equal(denied.status,403);assert.equal(denied.body.error.code,'creator_not_accessible');assert.equal(activations,1);assert.equal(prepares,1);
});
