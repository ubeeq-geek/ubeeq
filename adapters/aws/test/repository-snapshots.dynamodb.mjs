import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DynamoDBClient,CreateTableCommand,DeleteTableCommand} from '@aws-sdk/client-dynamodb';
import {DynamoDBDocumentClient,PutCommand,ScanCommand} from '@aws-sdk/lib-dynamodb';
import {createDynamoRepositories} from '../dist/index.js';
import {createLocalAdapterSet} from '@ubeeq/adapter-local';
import {createReferenceApi} from '@ubeeq/runtime';

const endpoint=process.env.TEST_DYNAMODB_ENDPOINT;
if(!endpoint||!/^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(endpoint))throw Error('An explicit loopback DynamoDB test endpoint is required.');
async function fixture(t){
 const credentials={accessKeyId:'DUMMYLOCALTEST',secretAccessKey:'DUMMYLOCALTEST'},region='ca-central-1',raw=new DynamoDBClient({region,endpoint,credentials}),otherRaw=new DynamoDBClient({region,endpoint,credentials}),client=DynamoDBDocumentClient.from(raw),other=DynamoDBDocumentClient.from(otherRaw),table='repository-snapshot-'+randomUUID();let created=false;
 t.after(async()=>{try{if(created)await raw.send(new DeleteTableCommand({TableName:table}));}finally{raw.destroy();otherRaw.destroy();}});
 await raw.send(new CreateTableCommand({TableName:table,BillingMode:'PAY_PER_REQUEST',KeySchema:[{AttributeName:'pk',KeyType:'HASH'},{AttributeName:'sk',KeyType:'RANGE'}],AttributeDefinitions:['pk','sk','repository','id'].map(AttributeName=>({AttributeName,AttributeType:'S'})),GlobalSecondaryIndexes:[{IndexName:'repository-id-index',KeySchema:[{AttributeName:'repository',KeyType:'HASH'},{AttributeName:'id',KeyType:'RANGE'}],Projection:{ProjectionType:'ALL'}}]}));created=true;
 const repositories=createDynamoRepositories(client,{tableName:table,cellId:'cell'}),independent=createDynamoRepositories(other,{tableName:table,cellId:'cell'}),scope={instanceId:'instance',homeCellId:'cell',dataHomeRegion:region,dataHomeAssignedAt:'2026-01-01',routingRevision:1};
 return {client,other,table,repositories,independent,scope,rows:async()=>(await client.send(new ScanCommand({TableName:table}))).Items??[]};
}

test('complete Dynamo inventories retain legacy data and reject changes even after the guard was staged',async t=>{
 const f=await fixture(t),legacy={id:'legacy',...f.scope,workId:'work',destination:'native',status:'live',revision:1,createdAt:'2026-01-01',updatedAt:'2026-01-01',opaque:{preserve:['all','legacy','fields']}};
 // An actual pre-protocol row, with no mutation marker and no invented empty history.
 await f.client.send(new PutCommand({TableName:f.table,Item:{pk:'publications#legacy',sk:'record',repository:'publications',id:legacy.id,revision:1,value:legacy}}));
 const snapshot=await f.repositories.publications.snapshot();assert.deepEqual(snapshot.items,[legacy]);
 await f.repositories.transaction(async transaction=>{await snapshot.bind(transaction);assert.deepEqual((await f.repositories.publications.list({limit:100},{transaction})).items,[legacy]);});
 const send=f.client.send.bind(f.client);let race;
 f.client.send=async(command,...rest)=>{if(race&&command.constructor.name==='TransactWriteCommand'){const hook=race;race=undefined;await hook();}return send(command,...rest);};
 for(const operation of ['insert','update','remove']){
  const before=await f.repositories.publications.snapshot();
  race=async()=>{
   if(operation==='insert')await f.independent.publications.create({id:'late',...f.scope,workId:'work',destination:'native',status:'live'});
   else if(operation==='update')await f.independent.publications.update('late',1,{status:'removed'});
   else await f.independent.publications.remove('late',2);
  };
  await assert.rejects(f.repositories.transaction(async transaction=>{
   await before.bind(transaction);
   await f.repositories.auditEvents.create({id:operation,...f.scope,action:'must.rollback',payload:{}},{transaction});
  }),{name:'OptimisticConcurrencyError'},operation);
  assert.equal(race,undefined);assert.equal(await f.repositories.auditEvents.get(operation),undefined);
 }
 // Editing a public return value cannot poison the private guarded read view.
 const fresh=await f.repositories.publications.snapshot();fresh.items[0].status='removed';
 await f.repositories.transaction(async transaction=>{await fresh.bind(transaction);assert.equal((await f.repositories.publications.list({limit:1},{transaction})).items[0].status,'live');});
});

test('Dynamo guarded lists include their own writes and forbid unguarded queries and expired handles',async t=>{
 const f=await fixture(t),snapshot=await f.repositories.publications.snapshot();let ended;
 await f.repositories.transaction(async transaction=>{
  ended=transaction;await snapshot.bind(transaction);
  await f.repositories.publications.create({id:'one',...f.scope,workId:'work',destination:'native',status:'live'},{transaction});
  assert.deepEqual((await f.repositories.publications.list({limit:100},{transaction})).items.map(item=>item.id),['one']);
 });
 await assert.rejects(snapshot.bind(ended),/active/);
 await assert.rejects(f.repositories.transaction(async transaction=>{await f.repositories.publications.list({limit:100},{transaction});}),/point reads/);
  await assert.rejects(f.repositories.transaction(async transaction=>{
  await assert.rejects(f.repositories.publications.update('one',99,{status:'removed'},{transaction}),{name:'OptimisticConcurrencyError'});
  await f.repositories.auditEvents.create({id:'ignored-conflict',...f.scope,action:'must.rollback',payload:{}},{transaction});
 }),/aborted/);
 assert.equal(await f.repositories.auditEvents.get('ignored-conflict'),undefined);
 assert.equal((await f.repositories.publications.get('one')).status,'live');
});

test('actual HTTP publication handles 1001 sources and fences a new attachment with bounded transaction size',async t=>{
 const f=await fixture(t),directory=await mkdtemp(join(tmpdir(),'large-work-publication-')),local=createLocalAdapterSet({databasePath:join(directory,'identity.sqlite'),dataDirectory:directory,cellId:'cell',publicBaseUrl:'http://localhost'});
 const api=createReferenceApi({instanceId:'instance',cellId:'cell',region:f.scope.dataHomeRegion,publicBaseUrl:'http://localhost',adapters:{repositories:f.repositories,storage:local.storage,uploads:local.storage,delivery:local.storage,jobs:local.jobs,identity:local.identity,localIdentity:local.identity}});
 t.after(async()=>{await api.close();local.database.close();await rm(directory,{recursive:true,force:true});});
 await new Promise(resolve=>api.server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+api.server.address().port;let token;
 const call=async(path,body,method=body?'POST':'GET')=>{const response=await fetch(base+path,{method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{}),'idempotency-key':'large-work'},...(body?{body:JSON.stringify(body)}:{})});return{status:response.status,body:await response.json()};};
 const credentials={email:'owner@example.test',password:'Synthetic local password 123!'};assert.equal((await call('/v1/auth/sign-up',credentials)).status,201);token=(await call('/v1/auth/sign-in',credentials)).body.token;
 assert.equal((await call('/v1/creators',{handle:'owner',displayName:'Owner'})).status,201);const created=await call('/v1/works',{title:'Large canonical Work'});assert.equal(created.status,201);const work=created.body.work;
 const {instanceId,homeCellId,dataHomeRegion,dataHomeAssignedAt,routingRevision}=work,asset={instanceId,homeCellId,dataHomeRegion,dataHomeAssignedAt,routingRevision,creatorId:work.creatorId,workId:work.id,status:'ready',mimeType:'image/png',checksum:'a'.repeat(64),objectVersion:'immutable-source-v1',legacyMetadata:'x'.repeat(2048)};
 for(let start=0;start<1001;start+=90)await f.repositories.transaction(async transaction=>{for(let i=start;i<Math.min(1001,start+90);i++)await f.repositories.assets.create({id:'asset-'+String(i).padStart(4,'0'),...asset},{transaction});});
 const send=f.client.send.bind(f.client);let pageFailed=false;
 f.client.send=async(command,...rest)=>{
  if(command.constructor.name==='ScanCommand'&&command.input.ExpressionAttributeValues?.[':repository']==='assets'&&command.input.ExclusiveStartKey){pageFailed=true;throw Error('later snapshot page unavailable');}
  return send(command,...rest);
 };
 const incomplete=await call('/v1/works/'+work.id+'/publications',{destination:'native'});assert.equal(incomplete.status,500,JSON.stringify(incomplete.body));assert.equal(pageFailed,true);
 const receipt='publication-request-'+createHash('sha256').update(JSON.stringify([work.instanceId,work.creatorId,work.id,'large-work'])).digest('hex');
 assert.equal(await f.repositories.publicationIntents.get(receipt),undefined);assert.equal((await f.repositories.publications.snapshot()).items.length,0);
 f.client.send=send;let inject=true,largest=0,sourceGuards=0;
 f.client.send=async(command,...rest)=>{
  if(command.constructor.name==='TransactWriteCommand'&&command.input.TransactItems.some(item=>item.Put?.Item?.repository==='publications')){
   largest=Math.max(largest,command.input.TransactItems.length);sourceGuards=command.input.TransactItems.filter(item=>item.ConditionCheck?.Key?.pk==='__ubeeq_repository_snapshot#assets').length;
   if(inject){inject=false;await f.independent.assets.create({id:'late-pending',...asset,status:'pending'});}
  }
  return send(command,...rest);
 };
 const denied=await call('/v1/works/'+work.id+'/publications',{destination:'native'});assert.equal(denied.status,409,JSON.stringify(denied.body));assert.equal(inject,false);
 assert.equal((await f.repositories.publications.snapshot()).items.length,0);assert.equal((await f.repositories.works.get(work.id)).status,'draft');
 await f.independent.assets.update('late-pending',1,{status:'ready'});
 const accepted=await call('/v1/works/'+work.id+'/publications',{destination:'native'});assert.equal(accepted.status,201,JSON.stringify(accepted.body));assert.equal(accepted.body.work.status,'ready');assert.equal(sourceGuards,1);assert.ok(largest<20,largest);
 assert.equal((await f.repositories.assets.snapshot()).items.length,1002);assert.equal((await f.repositories.assets.get('asset-0000')).legacyMetadata,asset.legacyMetadata);
});

test('actual HTTP deletion and withdrawal use complete publication history when the GSI is stale',async t=>{
 const f=await fixture(t),directory=await mkdtemp(join(tmpdir(),'publication-history-')),local=createLocalAdapterSet({databasePath:join(directory,'identity.sqlite'),dataDirectory:directory,cellId:'cell',publicBaseUrl:'http://localhost'});
 const api=createReferenceApi({instanceId:'instance',cellId:'cell',region:f.scope.dataHomeRegion,publicBaseUrl:'http://localhost',adapters:{repositories:f.repositories,storage:local.storage,uploads:local.storage,delivery:local.storage,jobs:local.jobs,identity:local.identity,localIdentity:local.identity}});
 t.after(async()=>{await api.close();local.database.close();await rm(directory,{recursive:true,force:true});});
 await new Promise(resolve=>api.server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+api.server.address().port;let token;
 const call=async(path,body,method=body?'POST':'GET')=>{const response=await fetch(base+path,{method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{})});return{status:response.status,body:await response.json()};};
 const credentials={email:'owner@example.test',password:'Synthetic local password 123!'};await call('/v1/auth/sign-up',credentials);token=(await call('/v1/auth/sign-in',credentials)).body.token;await call('/v1/creators',{handle:'owner',displayName:'Owner'});
 let work=(await call('/v1/works',{title:'Retained publication history'})).body.work;const {instanceId,homeCellId,dataHomeRegion,dataHomeAssignedAt,routingRevision}=work;
 await f.repositories.assets.create({id:'asset',instanceId,homeCellId,dataHomeRegion,dataHomeAssignedAt,routingRevision,creatorId:work.creatorId,workId:work.id,status:'ready',mimeType:'image/png',checksum:'checksum',objectVersion:'v1'});
 const send=f.client.send.bind(f.client);let lateHold=true;
 f.client.send=async(command,...rest)=>{
  if(lateHold&&command.constructor.name==='TransactWriteCommand'&&command.input.TransactItems.some(item=>item.Put?.Item?.repository==='publications')){
   lateHold=false;await f.independent.moderationHolds.create({id:'late-hold',instanceId,homeCellId,dataHomeRegion,dataHomeAssignedAt,routingRevision,subjectId:work.id,state:'active',reason:'review'});
  }
  return send(command,...rest);
 };
 const held=await call('/v1/works/'+work.id+'/publications',{destination:'native'});assert.equal(held.status,409,JSON.stringify(held.body));assert.equal(lateHold,false);assert.equal((await f.repositories.publications.snapshot()).items.length,0);
 await f.independent.moderationHolds.update('late-hold',1,{state:'released'});
 for(let attempt=0;attempt<100;attempt++){
  if((await f.repositories.moderationHolds.list({limit:100})).items.find(row=>row.id==='late-hold')?.state==='released')break;
  if(attempt===99)assert.fail('The test hold release did not reach the preflight index.');
  await new Promise(resolve=>setTimeout(resolve,10));
 }
 for(let i=0;i<2;i++){const result=await call('/v1/works/'+work.id+'/publications',{destination:'native'});assert.equal(result.status,201,JSON.stringify(result.body));work=result.body.work;}

 f.client.send=async(command,...rest)=>command.constructor.name==='QueryCommand'&&command.input.ExpressionAttributeValues?.[':repository']==='publications'?{Items:[]}:send(command,...rest);
 const denied=await call('/v1/works/'+work.id,{revision:work.revision},'DELETE');assert.equal(denied.status,409,JSON.stringify(denied.body));assert.equal(denied.body.error.code,'work_is_published');
 const removed=await call('/v1/works/'+work.id+'/publications/native',{published:false},'PUT');assert.equal(removed.status,200,JSON.stringify(removed.body));assert.ok((await f.repositories.publications.snapshot()).items.every(row=>row.status==='removed'));
 const deleted=await call('/v1/works/'+work.id,{revision:work.revision},'DELETE');assert.equal(deleted.status,200,JSON.stringify(deleted.body));
});
