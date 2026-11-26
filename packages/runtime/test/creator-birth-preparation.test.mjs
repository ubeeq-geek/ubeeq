import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createLocalAdapterSet} from '@ubeeq/adapter-local';
import {createCoreRuntime} from '../dist/index.js';
import {createIntakeCreator,persistIntakeCreator} from '../dist/creator-intake.js';
import {createRetainedRepositoryCreator} from '../dist/retained-repository-store.js';

async function fixture(t){
 const directory=await mkdtemp(join(tmpdir(),'creator-birth-preparation-'));
 const local=createLocalAdapterSet({databasePath:join(directory,'state.sqlite'),dataDirectory:directory,cellId:'cell',publicBaseUrl:'http://localhost'});
 t.after(async()=>{local.database.close();await rm(directory,{recursive:true,force:true});});
 const repositories=local.repositories,home={homeCellId:'cell',dataHomeRegion:'local',dataHomeAssignedAt:new Date().toISOString(),routingRevision:1};
 const intent={instanceId:'instance',cellId:'cell',region:'local',actorId:'actual-actor',handle:'actual-creator',displayName:'Actual Creator',idempotencyKey:'actual-intent'};
 const record=(id,input=intent)=>({id,instanceId:input.instanceId,...home,subjectId:input.actorId,handle:input.handle,displayName:input.displayName});
 const hostRecord=(id,kind,value)=>({id:kind+'-'+id,instanceId:intent.instanceId,...home,namespace:kind,scopeId:id,key:kind,value});
 return {local,repositories,home,intent,record,hostRecord};
}

test('real Local pre-transaction birth preparation and financial facts commit once, and lost-reply replay preserves edited profile defaults',async t=>{
 const f=await fixture(t),transaction=f.repositories.transaction.bind(f.repositories);let active=0,prepared=0,written=0,births=0,lost=true,admittedId;
 f.repositories.transaction=run=>transaction(async tx=>{active++;try{return await run(tx);}finally{active--;}}).then(result=>{if(lost&&result?.contentAuthority==='retained-v1'){lost=false;throw Error('Synthetic accepted reply lost');}return result;});
 const prepare=async({intent,creatorId,repositories})=>{
  prepared++;assert.equal(active,0);assert.equal(repositories,f.repositories);assert.equal(Object.isFrozen(intent),true);assert.deepEqual(intent,f.intent);admittedId=creatorId;
  const snapshot=await repositories.creators.snapshot();
  return async input=>{written++;assert.equal(active,1);assert.equal(input.record.id,admittedId);await snapshot.bind(input.transaction);
   const creator=await createRetainedRepositoryCreator(repositories,input.record,'tenant',input.transaction);
   await repositories.hostRecords.create(f.hostRecord(creator.id,'rich-profile',{opaque:{defaults:['original']},sortOrder:-.5}),{transaction:input.transaction});return creator;};
 };
 const create=async(transaction,id,factory)=>{
  const creator=await persistIntakeCreator(f.repositories,f.record(id),f.intent.actorId,transaction,factory);births++;
  await f.repositories.hostRecords.create(f.hostRecord(id,'financial-birth',{creatorId:id,actorId:f.intent.actorId}),{transaction});return creator;
 };
 const creator=await createIntakeCreator(f.repositories,f.intent,create,prepare);
 assert.equal(lost,false);assert.equal(prepared,1);assert.equal(written,1);assert.equal(births,1);
 const edited=await f.repositories.creators.update(creator.id,creator.revision,{displayName:'Edited name'}),profile=await f.repositories.hostRecords.get('rich-profile-'+creator.id);
 await f.repositories.hostRecords.update(profile.id,profile.revision,{value:{opaque:{defaults:['edited']},sortOrder:-2.25}});
 const replay=await createIntakeCreator(f.repositories,f.intent,create,prepare);
 assert.equal(replay.displayName,edited.displayName);assert.deepEqual((await f.repositories.hostRecords.get(profile.id)).value,{opaque:{defaults:['edited']},sortOrder:-2.25});
 assert.equal(prepared,1);assert.equal(written,1);assert.equal(births,1);
 assert.equal((await f.repositories.hostRecords.list({limit:100})).items.filter(row=>row.namespace==='financial-birth').length,1);
});

test('a receipt committed during preparation wins both returned-factory and preparation-error races',async t=>{
 for(const throws of [false,true]){
  const f=await fixture(t);let prepared=0,written=0,created;
  const direct=(transaction,id)=>persistIntakeCreator(f.repositories,f.record(id),f.intent.actorId,transaction);
  const actual=await createIntakeCreator(f.repositories,f.intent,async(transaction,id,factory)=>{assert.fail('The accepting receipt recheck must skip this duplicate writer.');},async()=>{
   prepared++;created=await createIntakeCreator(f.repositories,f.intent,direct);
   if(throws)throw Error('Preparation observed a stale inventory');
   return async()=>{written++;throw Error('Duplicate factory must not run');};
  });
  assert.equal(actual.id,created.id);assert.equal(prepared,1);assert.equal(written,0);
  assert.equal((await f.repositories.creators.list({limit:100})).items.length,1);
 }
});

test('a real Local Creator inventory guard rolls back another birth after a competing Creator changes it',async t=>{
 const f=await fixture(t);let competitor;
 await assert.rejects(createIntakeCreator(f.repositories,f.intent,(transaction,id,factory)=>persistIntakeCreator(f.repositories,f.record(id),f.intent.actorId,transaction,factory),async()=>{
  const snapshot=await f.repositories.creators.snapshot(),other={...f.intent,idempotencyKey:'competing',handle:'competing',displayName:'Competing'};
  competitor=await createIntakeCreator(f.repositories,other,(transaction,id)=>persistIntakeCreator(f.repositories,f.record(id,other),other.actorId,transaction));
  return async input=>{await snapshot.bind(input.transaction);const creator=await createRetainedRepositoryCreator(f.repositories,input.record,'tenant',input.transaction);await f.repositories.hostRecords.create(f.hostRecord(creator.id,'financial-birth',{creatorId:creator.id}),{transaction:input.transaction});return creator;};
 }),error=>error.constructor.name==='OptimisticConcurrencyError');
 assert.deepEqual((await f.repositories.creators.list({limit:100})).items.map(row=>row.id),[competitor.id]);
 assert.equal((await f.repositories.hostRecords.list({limit:100})).items.some(row=>row.namespace==='financial-birth'||row.namespace==='rich-profile'||row.namespace==='retained-creator-content'),false);
});

test('unkeyed preparation and persistence share one admitted UUID and invalid returned writers fail before persistence',async t=>{
 const f=await fixture(t);let admitted;
 const intent={...f.intent,idempotencyKey:undefined};
 const creator=await createIntakeCreator(f.repositories,intent,(transaction,id,factory)=>{assert.equal(id,admitted);return persistIntakeCreator(f.repositories,f.record(id),intent.actorId,transaction,factory);},async({creatorId})=>{admitted=creatorId;return input=>f.repositories.creators.create(input.record,{transaction:input.transaction});});
 assert.equal(creator.id,admitted);assert.match(admitted,/^[0-9a-f-]{36}$/);
 const before=(await f.repositories.creators.list({limit:100})).items;
 await assert.rejects(createIntakeCreator(f.repositories,{...f.intent,idempotencyKey:'invalid-writer'},()=>{assert.fail('No creation callback may run');},async()=>({})),{code:'creator_creation_invalid'});
 assert.deepEqual((await f.repositories.creators.list({limit:100})).items,before);
});

test('an existing canonical Creator without its intake receipt cannot be bootstrapped by a prepared writer',async t=>{
 const f=await fixture(t),key=createHash('sha256').update(JSON.stringify([f.intent.instanceId,f.intent.actorId,f.intent.idempotencyKey])).digest('hex'),id='creator-'+key;
 const existing=await f.repositories.creators.create(f.record(id));let writes=0;
 await assert.rejects(createIntakeCreator(f.repositories,f.intent,(transaction,creatorId,factory)=>persistIntakeCreator(f.repositories,f.record(creatorId),f.intent.actorId,transaction,factory),async()=>async input=>{
  writes++;await f.repositories.hostRecords.create(f.hostRecord(id,'rich-profile',{invented:true}),{transaction:input.transaction});return existing;
 }),{code:'creator_intake_requires_reconciliation'});
 assert.equal(writes,0);assert.deepEqual(await f.repositories.creators.get(id),existing);assert.deepEqual((await f.repositories.hostRecords.list({limit:100})).items,[]);
});

test('prepared writers cannot replace the admitted identity or report an unpersisted or forged birth',async t=>{
 for(const flaw of ['changed-identity','unpersisted','forged-reply']){
  const f=await fixture(t);
  await assert.rejects(createIntakeCreator(f.repositories,f.intent,(transaction,id,factory)=>persistIntakeCreator(f.repositories,f.record(id),f.intent.actorId,transaction,factory),async()=>async input=>{
   await f.repositories.hostRecords.create(f.hostRecord(input.record.id,'rich-profile',{staged:true}),{transaction:input.transaction});
   if(flaw==='unpersisted')return {...input.record,revision:1,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
   const creator=await f.repositories.creators.create({...input.record,...(flaw==='changed-identity'?{subjectId:'another-actor'}:{})},{transaction:input.transaction});
   return flaw==='forged-reply'?{...creator,displayName:'Fabricated reply'}:creator;
  }),{code:'creator_creation_invalid'},flaw);
  assert.deepEqual((await f.repositories.creators.list({limit:100})).items,[],flaw);
  assert.deepEqual((await f.repositories.hostRecords.list({limit:100})).items,[],flaw);
 }
});

test('actual HTTP prepared birth preserves verified actor, persisted identity checks and the host lifecycle transaction',async t=>{
 const f=await fixture(t),account=await f.local.identity.register({email:'prepared-http@example.test',password:'Synthetic password 123!'}),signed=await f.local.identity.authenticate({email:'prepared-http@example.test',password:'Synthetic password 123!'});let prepared=0,written=0,births=0;
 const unavailable=()=>{throw Error('This birth test does not install a content service.');};
 const bindings={access:async()=>false,createService:unavailable,createRelease:unavailable,enabled:()=>true,durableDrafts:()=>true,offerings:async()=>[],announcementDestinations:async()=>[],destinations:async()=>[],managementUrl:()=>'/works',runNextJob:async()=>undefined};
 const configuration={instanceId:'instance',cellId:'cell',region:'local',publicBaseUrl:'http://localhost',adapters:{repositories:f.repositories,identity:f.local.identity,localIdentity:f.local.identity,storage:f.local.storage,uploads:f.local.storage,delivery:f.local.storage,jobs:f.local.jobs}};
 assert.throws(()=>createCoreRuntime({...configuration,contentPreparation:()=>({...bindings,createCreator:unavailable,prepareCreatorCreation:unavailable})}),/one trusted writer/);
 const runtime=createCoreRuntime({...configuration,contentPreparation:()=>({...bindings,prepareCreatorCreation:async({intent,repositories})=>{prepared++;assert.equal(intent.actorId,account.subjectId);const snapshot=await repositories.creators.snapshot();return async input=>{written++;await snapshot.bind(input.transaction);return createRetainedRepositoryCreator(repositories,input.record,'tenant',input.transaction);};}}),creatorLifecycle:{prepare:async input=>{births++;assert.equal(input.actorUserId,account.subjectId);assert.equal(input.creator.contentAuthority,'retained-v1');await input.repositories.hostRecords.create(f.hostRecord(input.creator.id,'financial-birth',{creatorId:input.creator.id}),{transaction:input.transaction});}}});
 t.after(()=>runtime.close());await new Promise(resolve=>runtime.server.listen(0,'127.0.0.1',resolve));
 const call=async()=>{const response=await fetch(`http://127.0.0.1:${runtime.server.address().port}/v1/creators`,{method:'POST',headers:{authorization:'Bearer '+signed.token,'content-type':'application/json'},body:JSON.stringify({handle:'prepared-http',displayName:'Prepared HTTP',idempotencyKey:'prepared-http'})});return {status:response.status,body:await response.json()};};
 const first=await call(),second=await call();assert.equal(first.status,202,JSON.stringify(first.body));assert.equal(second.body.creator.id,first.body.creator.id);assert.equal(prepared,1);assert.equal(written,1);assert.equal(births,1);
});
