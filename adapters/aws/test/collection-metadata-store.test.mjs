import test from 'node:test';
import assert from 'node:assert/strict';
import {DynamoCollectionMetadataStore} from '../dist/collection-metadata-store.js';
import {collectionMetadata as metadata} from '@ubeeq/core';
const guard={ConditionCheck:{TableName:'content',Key:{PK:'creator',SK:'member'},ConditionExpression:'#role = :role',ExpressionAttributeNames:{'#role':'role'},ExpressionAttributeValues:{':role':'owner'}}};
const input=()=>({tenantId:'tenant',creatorId:'creator',collectionId:'collection',expectedRevision:0,expectedCollectionRevision:4,state:{...metadata.emptyMetadataState(),revision:1,initialized:true}});
const fixture=(rows=[],boundaryItems=async()=>[guard])=>{
  const calls=[],client={async send(command){calls.push(command);return command.constructor.name==='QueryCommand'?{Items:rows}:{};}};
  return {store:new DynamoCollectionMetadataStore({client,tableName:'content',boundaryItems}),calls};
};
test('writes require a trusted host boundary and an empty authorization plan cannot commit',async()=>{
  assert.throws(()=>new DynamoCollectionMetadataStore({client:{send(){}},tableName:'content'}),/transaction-bound host authorization/);
  const {store,calls}=fixture([],async()=>[]);await assert.rejects(store.commitCollectionMetadata(input()),{code:'permission_denied'});
  assert.ok(!calls.some(command=>command.constructor.name==='TransactWriteCommand'));
});
test('paged history reads are strong and retain native partitions; graph is installation-wide',async()=>{
  const calls=[],snapshot={id:'retained',opaque:'unchanged'},client={async send(command){calls.push(command.input);if(command.constructor.name==='GetCommand')return {};return calls.length===1?{Items:[{SK:'STATE',header:{revision:9,initialized:true,published:{},opaqueHeader:'retained'}}],LastEvaluatedKey:{PK:'cursor',SK:'last'}}:{Items:[{SK:'snapshots#retained',group:'snapshots',value:snapshot}]};}};
  const store=new DynamoCollectionMetadataStore({client,tableName:'content',boundaryItems:async()=>[guard]});
  const state=await store.getCollectionMetadata('tenant','collection');assert.equal(state.revision,9);assert.equal(state.opaqueHeader,'retained');assert.deepEqual(state.snapshots,[snapshot]);
  assert.ok(calls.slice(0,2).every(call=>call.ConsistentRead===true&&!call.IndexName));assert.equal(calls[0].ExpressionAttributeValues[':pk'],'TENANT#tenant#COLLECTION_METADATA#collection');assert.deepEqual(calls[1].ExclusiveStartKey,{PK:'cursor',SK:'last'});
  await store.getCollectionMetadataGraph('one');await store.getCollectionMetadataGraph('two');assert.deepEqual(calls.at(-1).Key,calls.at(-2).Key);assert.deepEqual(calls.at(-1).Key,{PK:'COLLECTION_METADATA_GRAPH#INSTALLATION',SK:'ROUTES'});
  assert.deepEqual(await store.getCollectionMetadataPresentation('tenant','collection'),{});assert.deepEqual(calls.at(-1).Key,{PK:'TENANT#tenant#COLLECTION_METADATA#collection',SK:'STATE'});
});
test('metadata, graph and exact host boundary items share one atomic commit',async()=>{
  const commit=input();commit.graph={revision:1,routes:[]};commit.expectedGraphRevision=0;
  commit.collection={tenantId:'tenant',creatorId:'creator',collectionId:'collection',title:'Saved',revision:5,updatedAt:'now',opaque:{retained:true}};
  let observed;const {store,calls}=fixture([],async value=>{observed=value;return [guard];});
  await store.commitCollectionMetadata(commit);assert.equal(observed,commit);assert.deepEqual(observed.collection.opaque,{retained:true});
  const writes=calls.at(-1).input.TransactItems;assert.equal(writes.length,3);assert.deepEqual(writes[2],guard);
  for(const write of writes.slice(0,2))assert.equal(write.Put.ConditionExpression,'attribute_not_exists(PK)');
  assert.equal(writes[0].Put.Item.creatorId,'creator');assert.deepEqual(writes[0].Put.Item.header,{revision:1,initialized:true,published:{}});
  assert.ok(!JSON.stringify(writes).match(/WORK#|MEMBERSHIP|EXTERNAL_SYNC_JOB|ORDER/));
});
test('every historical group is append-only; equivalent canonical hashes produce no rewrite',async()=>{
  for(const group of ['snapshots','provenance','audit','executions','commands']){
    const old={id:'record',opaque:{b:2,a:1}},rows=[{SK:'STATE',header:{revision:1,initialized:true,published:{}}},{SK:group+'#record',group,value:old}];
    for(const changed of [[],[{...old,opaque:{a:9}}]]){
      const {store,calls}=fixture(rows),commit=input();commit.expectedRevision=1;commit.state.revision=2;commit.state[group]=changed;
      await assert.rejects(store.commitCollectionMetadata(commit),{code:'invalid_request'});assert.ok(!calls.some(command=>command.constructor.name==='TransactWriteCommand'));
    }
    const {store}=fixture(rows),commit=input();commit.expectedRevision=1;commit.state.revision=2;commit.state[group]=[{opaque:{a:1,b:2},id:'record'}];
    const writes=await store.transactionItems(commit);assert.equal(writes.length,1);
  }
});
test('sidecar planning never commits, invokes host authorization, or drops graph/revision guards',async()=>{
  let authorized=0;const {store,calls}=fixture([],async()=>{authorized++;return [guard];});const commit=input();commit.graph={revision:1,routes:[]};
  const writes=await store.transactionItems(commit);assert.equal(writes.length,2);assert.equal(authorized,0);assert.ok(calls.every(command=>command.constructor.name==='QueryCommand'));
  assert.equal(writes[0].Put.ConditionExpression,'attribute_not_exists(PK)');assert.equal(writes[1].Put.Item.SK,'ROUTES');
});
test('transaction budget includes all host guards; valid hundred-item commit remains supported',async()=>{
  const makeGuard=index=>({ConditionCheck:{...guard.ConditionCheck,Key:{PK:'guard-'+index,SK:'current'}}});
  const {store,calls}=fixture([],async()=>Array.from({length:99},(_,index)=>makeGuard(index)));await store.commitCollectionMetadata(input());assert.equal(calls.at(-1).input.TransactItems.length,100);
  const denied=fixture([],async()=>Array.from({length:100},(_,index)=>makeGuard(index)));await assert.rejects(denied.store.commitCollectionMetadata(input()),{code:'storage_budget'});assert.ok(denied.calls.every(command=>command.constructor.name!=='TransactWriteCommand'));
});
test('stale state, immutable record and graph budgets fail before any writes',async()=>{
  const stale=fixture([{SK:'STATE',header:{revision:3}}]);await assert.rejects(stale.store.commitCollectionMetadata(input()),{code:'stale_revision'});
  for(const kind of ['record','graph']){
    const {store,calls}=fixture(),commit=input();
    if(kind==='record')commit.state.commands=[{id:'large',hash:'x'.repeat(350001)}];else commit.graph={revision:1,routes:[],opaque:'x'.repeat(350001)};
    await assert.rejects(store.commitCollectionMetadata(commit),{code:'storage_budget'});assert.ok(calls.every(command=>command.constructor.name!=='TransactWriteCommand'));
  }
});
test('conditional transaction cancellation is a retryable stale revision; other failures retain identity',async()=>{
  for(const name of ['TransactionCanceledException','ServiceUnavailableException']){
    const error=Object.assign(new Error('failure'),{name}),client={async send(command){if(command.constructor.name==='QueryCommand')return {Items:[]};throw error;}};
    const store=new DynamoCollectionMetadataStore({client,tableName:'content',boundaryItems:async()=>[guard]});
    await assert.rejects(store.commitCollectionMetadata(input()),value=>name==='TransactionCanceledException'?value.code==='stale_revision':value===error);
  }
});
