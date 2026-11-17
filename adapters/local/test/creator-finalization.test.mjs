import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, copyFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createLocalAdapterSet} from '../dist/index.js';
import {finalizeRetainedCreatorRemoval, protectCreatorContentAuthority} from '@ubeeq/persistence';
import {createIntakeCreator, persistIntakeCreator} from '../../../packages/runtime/dist/creator-intake.js';
import {createRetainedRepositoryCreator} from '../../../packages/runtime/dist/retained-repository-store.js';

async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'creator-finalization-'));
  const configuration={databasePath:join(root,'records.sqlite'),dataDirectory:root,cellId:'cell',publicBaseUrl:'http://127.0.0.1'};
  const local=createLocalAdapterSet(configuration),repositories=local.repositories;
  let localClosed=false;
  const closeLocal=()=>{if(!localClosed){local.database.close();localClosed=true;}};
  const closers=[closeLocal],track=adapter=>{closers.push(()=>adapter.database.close());return adapter;};
  t.after(async()=>{try{for(const close of closers.reverse())close();}finally{await rm(root,{recursive:true,force:true});}});
  const principal=await local.identity.register({email:'finalization@unit.test',password:'Actual Local finalization password123!'});
  const input={instanceId:'unit',cellId:'cell',region:'local',actorId:principal.subjectId,handle:'actual-finalization-owner',displayName:'Actual owner',idempotencyKey:'actual-birth'};
  const creator=await createIntakeCreator(repositories,input,(transaction,id)=>persistIntakeCreator(repositories,{id,instanceId:input.instanceId,homeCellId:'cell',dataHomeRegion:'local',dataHomeAssignedAt:new Date().toISOString(),routingRevision:1,subjectId:principal.subjectId,handle:input.handle,displayName:input.displayName},principal.subjectId,transaction,actual=>createRetainedRepositoryCreator(repositories,actual.record,'unit',actual.transaction)));
  const record=(id,namespace,value)=>({id,instanceId:creator.instanceId,homeCellId:creator.homeCellId,dataHomeRegion:creator.dataHomeRegion,dataHomeAssignedAt:creator.dataHomeAssignedAt,routingRevision:creator.routingRevision,namespace,scopeId:creator.id,key:id,value});
  const marker=await repositories.hostRecords.create(record('actual-removal-marker','test-removal-command',{creatorId:creator.id,requestedByUserId:principal.subjectId}));
  return {root,configuration,local,repositories,creator,principal,record,marker,closeLocal,track};
}

test('ordinary retained removal remains denied and actual coordinator finalization retains the host archive atomically',async t=>{
  const f=await fixture(t),repositories=protectCreatorContentAuthority(f.repositories),before=structuredClone(f.creator);
  await assert.rejects(repositories.creators.remove(f.creator.id,f.creator.revision),{code:'creator_content_authority_conflict'});
  const snapshot=await repositories.hostRecords.snapshot();let called=0;
  await finalizeRetainedCreatorRemoval(repositories,{expected:f.creator,authorize:async(actual,transaction)=>{
    called++;assert.equal(Object.isFrozen(actual),true);assert.notEqual(actual,f.creator);assert.deepEqual(actual,f.creator);
    await snapshot.bind(transaction);
    const marker=await repositories.hostRecords.get(f.marker.id,{transaction});assert.deepEqual(marker,f.marker);
    const subject=await f.local.identity.getAuthorizationSubject(marker.value.requestedByUserId);assert.equal(subject.id,actual.subjectId);
    await repositories.hostRecords.create(f.record('actual-removal-archive','test-removal-archive',{creator:actual,command:marker.value}),{transaction});
  }});
  assert.equal(called,1);assert.deepEqual(f.creator,before);
  assert.equal(await repositories.creators.get(f.creator.id),undefined);
  assert.deepEqual((await repositories.hostRecords.get('actual-removal-archive')).value.creator,before);
  assert.deepEqual(await repositories.hostRecords.get(f.marker.id),f.marker);
  assert.equal((await f.local.identity.getAuthorizationSubject(f.principal.subjectId)).id,f.principal.subjectId);
});

test('current host denial and a stale full Creator roll back or prevent finalization without accepting an unregistered port',async t=>{
  const f=await fixture(t),r=f.repositories;
  await assert.rejects(finalizeRetainedCreatorRemoval(r,{expected:f.creator,authorize:async(_actual,transaction)=>{await r.hostRecords.create(f.record('denied-archive','test-removal-archive',{denied:true}),{transaction});throw Error('Actual host authority denied');}}),/Actual host authority denied/);
  assert.deepEqual(await r.creators.get(f.creator.id),f.creator);assert.equal(await r.hostRecords.get('denied-archive'),undefined);
  const current=await r.creators.update(f.creator.id,f.creator.revision,{displayName:'Changed actual profile'});let called=false;
  await assert.rejects(finalizeRetainedCreatorRemoval(r,{expected:f.creator,authorize:async()=>{called=true;}}),{code:'creator_content_authority_conflict'});
  assert.equal(called,false);assert.deepEqual(await r.creators.get(current.id),current);
  await assert.rejects(finalizeRetainedCreatorRemoval({...r,creators:Object.create(r.creators)},{expected:current,authorize:async()=>{called=true;}}),{code:'creator_content_authority_conflict'});
  assert.equal(called,false);
});

test('a caught cross-coordinator removal cannot borrow the permit even for a physical clone of the same full Creator',async t=>{
  const f=await fixture(t);f.closeLocal();
  const clonePath=join(f.root,'clone.sqlite');await copyFile(f.configuration.databasePath,clonePath);
  const original=f.track(createLocalAdapterSet(f.configuration)),foreign=f.track(createLocalAdapterSet({...f.configuration,databasePath:clonePath}));
  const r=original.repositories,other=foreign.repositories,expected=await r.creators.get(f.creator.id);
  assert.deepEqual(await other.creators.get(expected.id),expected);
  const remove=r.creators.remove.bind(r.creators);let rejected=false;
  r.creators.remove=async(...args)=>{
    try{await other.creators.remove(expected.id,expected.revision);}catch(error){assert.equal(error.code,'creator_content_authority_conflict');rejected=true;}
    return remove(...args);
  };
  await assert.rejects(finalizeRetainedCreatorRemoval(r,{expected,authorize:async()=>{}}),{code:'creator_content_authority_conflict'});
  assert.equal(rejected,true);
  assert.deepEqual(await r.creators.get(expected.id),expected);assert.deepEqual(await other.creators.get(expected.id),expected);
});
