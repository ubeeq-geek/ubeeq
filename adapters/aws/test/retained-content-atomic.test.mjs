import assert from 'node:assert/strict';
import test from 'node:test';
import {createDynamoRetainedContentAtomic} from '../dist/index.js';

function fixture(){
 const transactions=[],reads=[];
 const transport={
  get:async input=>{reads.push(input);return {$metadata:{}};},query:async()=>({Items:[],$metadata:{}}),scan:async()=>({Items:[],$metadata:{}}),
  put:async()=>{throw Error('Unexpected direct write');},delete:async()=>{throw Error('Unexpected direct delete');},update:async()=>{throw Error('Unexpected direct update');},
  transactWrite:async input=>{transactions.push(structuredClone(input));return {};}
 };
 const bindings={publicationItem:value=>({...value,PK:'publication',SK:'PROFILE',entityType:'PUBLICATION'})};
 return {...createDynamoRetainedContentAtomic(transport,'records','tenant',bindings),transport,bindings,transactions,reads};
}

test('retained hosted transactions require every actual transport and the publication mapping',()=>{
 const f=fixture();
 for(const kind of ['get','query','scan','put','delete','update','transactWrite'])assert.throws(()=>createDynamoRetainedContentAtomic({...f.transport,[kind]:undefined},'records','tenant',f.bindings),/actual transport/);
 for(const [table,tenant,bindings] of [['','tenant',f.bindings],['records','',f.bindings],['records','tenant',{}]])assert.throws(()=>createDynamoRetainedContentAtomic(f.transport,table,tenant,bindings),/table, tenant and publication mapping/);
});

test('host fallback cannot escape an accepting or expired transaction scope',async()=>{
 const f=fixture();let forwarded=0,release,late;
 assert.equal(await f.client.unmanaged(async()=>{forwarded++;return 'outside';}),'outside');
 await assert.rejects(f.atomic.run(async()=>{
  await f.atomic.put('outbox','partial',{state:'pending'});
  try{await f.client.unmanaged(async()=>{forwarded++;});}catch{}
 }),/failed/);
 assert.equal(forwarded,1);assert.equal(f.transactions.length,0);
 const gate=new Promise(resolve=>{release=resolve;});
 await f.atomic.run(async()=>{late=(async()=>{await gate;return f.client.unmanaged(async()=>{forwarded++;});})().catch(error=>error);});
 release();assert.match((await late).message,/ended/);assert.equal(forwarded,1);
});

test('rich publication data, preparation progress and policy fence share one conditional commit',async()=>{
 const f=fixture(),publication={tenantId:'tenant',creatorId:'creator',publicationId:'p',workId:'w',destination:'custom',status:'draft',configurationRevision:7,metadataOverrides:{fields:{nested:['retained']}}};
 await f.atomic.run(async()=>{await f.atomic.savePublication(publication);await f.atomic.put('outbox','operation',{state:'pending'});});
 assert.equal(f.transactions.length,1);
 const writes=f.transactions[0].TransactItems;
 assert.deepEqual(writes.find(row=>row.Put?.Item.PK==='publication').Put.Item,{...publication,PK:'publication',SK:'PROFILE',entityType:'PUBLICATION'});
 assert.ok(writes.some(row=>row.Put?.Item.PK==='TENANT#tenant#PUBLICATION_COMMAND#outbox'));
 assert.ok(writes.some(row=>row.Put?.Item.PK==='TENANT#tenant#PUBLICATION_POLICY'));
 assert.ok(writes.every(row=>(row.Put??row.ConditionCheck).ConditionExpression));
 assert.ok(f.reads.every(read=>read.ConsistentRead===true));
});
