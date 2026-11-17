import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DynamoDBClient,CreateTableCommand,DeleteTableCommand} from '@aws-sdk/client-dynamodb';
import {DynamoDBDocumentClient,PutCommand} from '@aws-sdk/lib-dynamodb';
import {readReferenceOperator,releaseCreatedReferenceOperator} from '../../../examples/aws-serverless/single-cell/owned-reference-operator.mjs';
const endpoint=process.env.TEST_DYNAMODB_ENDPOINT;
if(endpoint&&!/^http:\/\/(?:127\.0\.0\.1|localhost):\d+\/?$/.test(endpoint))throw Error('The operator-fixture test requires an official loopback DynamoDB engine.');
test('operator fixture teardown retains prior, foreign and concurrently changed claims; only its exact new claim is removed',{skip:!endpoint},async()=>{
 const raw=new DynamoDBClient({endpoint,region:'us-east-2',credentials:{accessKeyId:'DUMMYLOCALTEST',secretAccessKey:'DUMMYLOCALTEST'}}),client=DynamoDBDocumentClient.from(raw),tableName='operator-fixture-'+randomUUID(),instanceId='actual-ci-instance',actorId='actual-disposable-ci-user';let initialized=false;
 try{
  await raw.send(new CreateTableCommand({TableName:tableName,BillingMode:'PAY_PER_REQUEST',KeySchema:[{AttributeName:'pk',KeyType:'HASH'},{AttributeName:'sk',KeyType:'RANGE'}],AttributeDefinitions:[{AttributeName:'pk',AttributeType:'S'},{AttributeName:'sk',AttributeType:'S'}]}));initialized=true;
  const before=await readReferenceOperator(client,tableName,instanceId);assert.equal(before,undefined);
  const created={pk:'instanceOperators#'+instanceId,sk:'record',repository:'instanceOperators',id:instanceId,revision:1,value:{id:instanceId,instanceId,actorId,revision:1,createdAt:'2026-11-17T00:00:00.000Z'}};
  await client.send(new PutCommand({TableName:tableName,Item:created}));const input={tableName,instanceId,actorId,before,created};
  assert.equal(await releaseCreatedReferenceOperator(client,{...input,before:created}),false);
  await assert.rejects(releaseCreatedReferenceOperator(client,{...input,actorId:'foreign-user'}),/unowned/);
  assert.deepEqual(await readReferenceOperator(client,tableName,instanceId),created);
  const changed={...created,revision:2,value:{...created.value,revision:2}};await client.send(new PutCommand({TableName:tableName,Item:changed}));
  assert.equal(await releaseCreatedReferenceOperator(client,input),false);assert.deepEqual(await readReferenceOperator(client,tableName,instanceId),changed);
  await client.send(new PutCommand({TableName:tableName,Item:created}));assert.equal(await releaseCreatedReferenceOperator(client,input),true);
  assert.equal(await readReferenceOperator(client,tableName,instanceId),undefined);
 }finally{try{if(initialized)await raw.send(new DeleteTableCommand({TableName:tableName}));}finally{raw.destroy();}}
});
