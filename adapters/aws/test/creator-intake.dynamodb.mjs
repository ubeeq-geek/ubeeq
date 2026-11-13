import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DynamoDBClient, CreateTableCommand, DeleteTableCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { createDynamoRepositories } from '@ubeeq/adapter-aws';
import { createIntakeCreator } from '../../../packages/runtime/dist/creator-intake.js';

const endpoint=process.env.TEST_DYNAMODB_ENDPOINT;
if(!endpoint||!/^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(endpoint))throw Error('An explicit loopback DynamoDB test endpoint is required.');
async function fixture(t){
 const region='ca-central-1',credentials={accessKeyId:'DUMMYLOCALTEST',secretAccessKey:'DUMMYLOCALTEST'},raw=new DynamoDBClient({region,endpoint,credentials}),otherRaw=new DynamoDBClient({region,endpoint,credentials}),client=DynamoDBDocumentClient.from(raw),other=DynamoDBDocumentClient.from(otherRaw),table='creator-intake-'+randomUUID();let created=false;
 t.after(async()=>{try{if(created)await raw.send(new DeleteTableCommand({TableName:table}));}finally{raw.destroy();otherRaw.destroy();}});
 await raw.send(new CreateTableCommand({TableName:table,BillingMode:'PAY_PER_REQUEST',KeySchema:[{AttributeName:'pk',KeyType:'HASH'},{AttributeName:'sk',KeyType:'RANGE'}],AttributeDefinitions:['pk','sk','repository','id'].map(AttributeName=>({AttributeName,AttributeType:'S'})),GlobalSecondaryIndexes:[{IndexName:'repository-id-index',KeySchema:[{AttributeName:'repository',KeyType:'HASH'},{AttributeName:'id',KeyType:'RANGE'}],Projection:{ProjectionType:'ALL'}}]}));created=true;
 const repositories=createDynamoRepositories(client,{tableName:table,cellId:'cell'}),independent=createDynamoRepositories(other,{tableName:table,cellId:'cell'}),home={homeCellId:'cell',dataHomeRegion:region,dataHomeAssignedAt:new Date().toISOString(),routingRevision:1},input={instanceId:'instance',cellId:'cell',region,actorId:'actor',handle:'creator',displayName:'Creator',idempotencyKey:'request'};
 const create=repo=>async(transaction,id)=>{const creator=await repo.creators.create({id,instanceId:input.instanceId,...home,subjectId:input.actorId,handle:input.handle,displayName:input.displayName},{transaction});await repo.hostRecords.create({id:'birth-'+id,instanceId:input.instanceId,...home,namespace:'test-birth',scopeId:id,key:'birth',value:{creatorId:id,actorId:input.actorId}},{transaction});return creator;};
 return {client,table,repositories,independent,input,create,rows:async()=>(await client.send(new ScanCommand({TableName:table}))).Items};
}
test('actual Creator, host birth and request receipt commit together and recover a lost transaction response',async t=>{
 const f=await fixture(t),send=f.client.send.bind(f.client);let lost=false;
 f.client.send=async(command,...rest)=>{const result=await send(command,...rest);if(!lost&&command instanceof TransactWriteCommand&&command.input.TransactItems?.some(item=>item.Put?.Item?.repository==='creators')){lost=true;throw Error('Synthetic accepted response lost');}return result;};
 const first=await createIntakeCreator(f.repositories,f.input,f.create(f.repositories)),second=await createIntakeCreator(f.independent,f.input,f.create(f.independent));assert.equal(lost,true);assert.equal(first.id,second.id);assert.equal((await f.rows()).length,3);
});
test('actual concurrent Creator receipts converge and failed preparation leaves no partial records',async t=>{
 const f=await fixture(t);
 await assert.rejects(createIntakeCreator(f.repositories,f.input,async(transaction,id)=>{await f.create(f.repositories)(transaction,id);throw Error('Host preparation failed');}),/Host preparation failed/);assert.deepEqual(await f.rows(),[]);
 const results=await Promise.all([createIntakeCreator(f.repositories,f.input,f.create(f.repositories)),createIntakeCreator(f.independent,f.input,f.create(f.independent))]);assert.equal(results[0].id,results[1].id);assert.equal((await f.rows()).length,3);
});
