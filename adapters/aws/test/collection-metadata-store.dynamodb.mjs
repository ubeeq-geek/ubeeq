import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {DynamoDBClient,CreateTableCommand,DeleteTableCommand,waitUntilTableNotExists} from '@aws-sdk/client-dynamodb';
import {DynamoDBDocumentClient,PutCommand,DeleteCommand,TransactWriteCommand,QueryCommand} from '@aws-sdk/lib-dynamodb';
import {collectionMetadata as metadata} from '@ubeeq/core';
import {DynamoCollectionMetadataStore} from '../dist/collection-metadata-store.js';
const endpoint=process.env.TEST_DYNAMODB_ENDPOINT;
if(!endpoint||!/^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(endpoint))throw Error('An explicit loopback DynamoDB test endpoint is required.');
const domain=metadata.createMetadataDomain({sha256Hex:value=>createHash('sha256').update(value).digest('hex'),createId:randomUUID,now:()=>new Date().toISOString()});
test('actual partitioned metadata transactions preserve native history and atomic host authority',{timeout:180_000},async t=>{
  const raw=new DynamoDBClient({endpoint,region:'ca-central-1',credentials:{accessKeyId:'DUMMYLOCALTEST',secretAccessKey:'DUMMYLOCALTEST'},maxAttempts:1}),client=DynamoDBDocumentClient.from(raw,{marshallOptions:{removeUndefinedValues:true}}),table='metadata-'+randomUUID();
  let created=false,beforeCommit;const reads=[],transactionSizes=[];
  const transport={async send(command){if(command instanceof QueryCommand)reads.push(command.input);if(command instanceof TransactWriteCommand){transactionSizes.push(command.input.TransactItems.length);const hook=beforeCommit;beforeCommit=undefined;await hook?.();}return client.send(command);}};
  const creatorKey={PK:'CREATOR#creator',SK:'PROFILE'},memberKey={PK:'CREATOR#creator',SK:'MEMBER#USER#actor'},adminKey={PK:'USER#actor',SK:'PLATFORM_ROLE'},collectionKey=(id,tenant='tenant')=>({PK:`TENANT#${tenant}#COLLECTION#${id}`,SK:'PROFILE'}),organizationKey={PK:'TENANT#tenant#CREATOR#creator',SK:'COLLECTION_ORGANIZATION'};
  const put=Item=>client.send(new PutCommand({TableName:table,Item})),remove=Key=>client.send(new DeleteCommand({TableName:table,Key}));
  // This is the trusted host adapter. The persistence layer never assumes a
  // commercial role schema or accepts authorization directly from HTTP input.
  const boundaryItems=async input=>[
    {ConditionCheck:{TableName:table,Key:creatorKey,ConditionExpression:'creatorId = :id AND attribute_not_exists(deletion)',ExpressionAttributeValues:{':id':input.creatorId}}},
    {ConditionCheck:{TableName:table,Key:collectionKey(input.collectionId,input.tenantId),ConditionExpression:'creatorId = :id AND revision = :r',ExpressionAttributeValues:{':id':input.creatorId,':r':input.expectedCollectionRevision}}},
    {ConditionCheck:{TableName:table,Key:{...organizationKey,PK:`TENANT#${input.tenantId}#CREATOR#creator`},ConditionExpression:'revision = :r',ExpressionAttributeValues:{':r':input.expectedOrganizationRevision}}},
    ...(input.permissions??[]).map(permission=>({ConditionCheck:permission.admin?{TableName:table,Key:adminKey,ConditionExpression:'#a.#r = :admin',ExpressionAttributeNames:{'#a':'assignment','#r':'role'},ExpressionAttributeValues:{':admin':'admin'}}:{TableName:table,Key:memberKey,ConditionExpression:'#r = :r',ExpressionAttributeNames:{'#r':'role'},ExpressionAttributeValues:{':r':permission.role}}}))
  ];
  const store=new DynamoCollectionMetadataStore({client:transport,tableName:table,boundaryItems});
  const next=async(id='one',tenantId='tenant')=>{const state=await store.getCollectionMetadata(tenantId,id),revision=state.revision;state.revision++;return {tenantId,creatorId:'creator',collectionId:id,expectedRevision:revision,state,expectedCollectionRevision:4,expectedOrganizationRevision:2,permissions:[{actorId:'actor',admin:false,role:'owner'}]};};
  const unchanged=async input=>{const old=await store.getCollectionMetadata(input.tenantId,input.collectionId),graph=await store.getCollectionMetadataGraph(input.tenantId);await assert.rejects(store.commitCollectionMetadata(input),{code:'stale_revision'});assert.deepEqual(await store.getCollectionMetadata(input.tenantId,input.collectionId),old);assert.deepEqual(await store.getCollectionMetadataGraph(input.tenantId),graph);};
  try{
    await raw.send(new CreateTableCommand({TableName:table,BillingMode:'PAY_PER_REQUEST',KeySchema:[{AttributeName:'PK',KeyType:'HASH'},{AttributeName:'SK',KeyType:'RANGE'}],AttributeDefinitions:[{AttributeName:'PK',AttributeType:'S'},{AttributeName:'SK',AttributeType:'S'}]}));created=true;
    await put({...creatorKey,creatorId:'creator'});await put({...memberKey,role:'owner'});await put({...organizationKey,revision:2});for(const id of ['one','two'])await put({...collectionKey(id),creatorId:'creator',revision:4,opaque:{mustSurvive:true}});
    await t.test('history exceeding one megabyte remains separate, complete and strongly paginated',async()=>{
      const input=await next();input.state.initialized=true;
      for(let index=0;index<60;index++){
        const fields=metadata.cellsFromValues({title:'Observed '+index,description:'x'.repeat(18000),cover:null});
        input.state.snapshots.push({...domain.metadataSnapshot('endpoint',fields,'observed-'+index),rawFields:structuredClone(fields)});
      }
      input.state.published={site:{values:{title:'Published separately',description:null,cover:null},nativeRevision:7,updatedAt:'now'}};
      assert.ok(Buffer.byteLength(JSON.stringify(input.state))>1024*1024);
      await store.commitCollectionMetadata(input);reads.length=0;const found=await store.getCollectionMetadata('tenant','one');assert.deepEqual(found,{...input.state,snapshots:[...input.state.snapshots].sort((a,b)=>a.id.localeCompare(b.id))});assert.ok(reads.length>=3);assert.ok(reads.every(read=>read.ConsistentRead&&!read.IndexName));assert.ok(reads.slice(1).every(read=>read.ExclusiveStartKey));assert.deepEqual(await store.getCollectionMetadataPresentation('tenant','one'),input.state.published);
    });
    await t.test('changed immutable observations and removed audit history are rejected',async()=>{
      const input=await next();input.state.snapshots[0].fields.title.value='Rewritten';await assert.rejects(store.commitCollectionMetadata(input),{code:'invalid_request'});
      const append=await next();append.state.audit.push({id:'audit',actorId:'actor',event:'reviewed',at:'now',nativeRevision:7});await store.commitCollectionMetadata(append);
      const erased=await next();erased.state.audit=[];await assert.rejects(store.commitCollectionMetadata(erased),{code:'invalid_request'});
    });
    await t.test('membership revocation after planning aborts metadata and graph together',async()=>{
      const input=await next();input.state.commands.push({id:'revoked-command',hash:'immutable'});input.graph={revision:1,routes:[]};input.expectedGraphRevision=0;
      beforeCommit=()=>remove(memberKey);await unchanged(input);await put({...memberKey,role:'owner'});
    });
    await t.test('current admin succeeds and revoked admin cannot retain a diagnostic',async()=>{
      await put({...adminKey,assignment:{role:'admin'}});const accepted=await next();accepted.permissions=[{actorId:'actor',admin:true}];await store.commitCollectionMetadata(accepted);
      const denied=await next();denied.permissions=accepted.permissions;beforeCommit=()=>remove(adminKey);await unchanged(denied);
    });
    await t.test('collection ownership, organization revision and Creator deletion are commit-time guards',async()=>{
      for(const [key,changed,restored] of [[collectionKey('one'),{creatorId:'foreign',revision:4},{creatorId:'creator',revision:4}],[organizationKey,{revision:3},{revision:2}],[creatorKey,{creatorId:'creator',deletion:{requested:true}},{creatorId:'creator'}]]){
        const input=await next();beforeCommit=()=>put({...key,...changed});await unchanged(input);await put({...key,...restored});
      }
    });
    await t.test('competing metadata commits retain exactly one winner',async()=>{
      const first=await next(),second=structuredClone(first);first.state.commands.push({id:'first',hash:'one'});second.state.commands.push({id:'second',hash:'two'});
      const outcomes=await Promise.allSettled([store.commitCollectionMetadata(first),store.commitCollectionMetadata(second)]);assert.equal(outcomes.filter(value=>value.status==='fulfilled').length,1);assert.equal(outcomes.find(value=>value.status==='rejected').reason.code,'stale_revision');
      const state=await store.getCollectionMetadata('tenant','one');assert.equal(state.commands.filter(command=>['first','second'].includes(command.id)).length,1);
    });
    await t.test('cross-tenant installation graph reservations cannot race into two owners',async()=>{
      await put({...collectionKey('two','another-tenant'),creatorId:'creator',revision:4});
      await put({...organizationKey,PK:'TENANT#another-tenant#CREATOR#creator',revision:2});
      const first=await next(),second=await next('two','another-tenant');first.graph={revision:1,routes:[{connectionId:'route',collectionId:'one',from:'native:tenant:one',to:'remote',fields:['title'],role:'DESTINATION'}]};first.expectedGraphRevision=0;second.graph={revision:1,routes:[]};second.expectedGraphRevision=0;
      await store.commitCollectionMetadata(first);await unchanged(second);assert.deepEqual(await store.getCollectionMetadataGraph('another-tenant'),first.graph);
    });
    await t.test('metadata sidecars retain enclosing conditional authorization and cannot partially commit',async()=>{
      const input=await next('two'),items=await store.transactionItems(input);await put({...memberKey,role:'viewer'});
      await assert.rejects(client.send(new TransactWriteCommand({TransactItems:[...items,...await boundaryItems(input)]})),{name:'TransactionCanceledException'});assert.equal((await store.getCollectionMetadata('tenant','two')).revision,0);await put({...memberKey,role:'owner'});
      await client.send(new TransactWriteCommand({TransactItems:[...items,...await boundaryItems(input)]}));assert.equal((await store.getCollectionMetadata('tenant','two')).revision,1);
    });
    assert.ok(transactionSizes.every(size=>size<=100));
  }finally{
    if(created){await raw.send(new DeleteTableCommand({TableName:table}));await waitUntilTableNotExists({client:raw,maxWaitTime:20,minDelay:1,maxDelay:1},{TableName:table});}
    raw.destroy();
  }
});
