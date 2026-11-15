import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {DynamoDBClient,CreateTableCommand,DeleteTableCommand} from '@aws-sdk/client-dynamodb';
import {DynamoDBDocumentClient} from '@aws-sdk/lib-dynamodb';
import {createDynamoRepositories} from '../dist/index.js';
import {retainedSourceHttpFixture} from '../../../packages/runtime/test/retained-source-http-fixture.mjs';
const endpoint=process.env.TEST_DYNAMODB_ENDPOINT;
if(!endpoint||!/^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(endpoint))throw Error('An explicit loopback DynamoDB endpoint is required; this test never uses AWS.');
test('actual Dynamo-backed retained HTTP stages before Work, streams verified local original bytes and reopens the same physical receipt',async t=>{
 const raw=new DynamoDBClient({endpoint,region:'ca-central-1',credentials:{accessKeyId:'DUMMYLOCALTEST',secretAccessKey:'DUMMYLOCALTEST'}}),client=DynamoDBDocumentClient.from(raw,{marshallOptions:{removeUndefinedValues:true}}),table='source-http-'+randomUUID();let created=false;
 t.after(async()=>{try{if(created)await raw.send(new DeleteTableCommand({TableName:table}));}finally{raw.destroy();}});
 await raw.send(new CreateTableCommand({TableName:table,BillingMode:'PAY_PER_REQUEST',KeySchema:[{AttributeName:'pk',KeyType:'HASH'},{AttributeName:'sk',KeyType:'RANGE'}],AttributeDefinitions:['pk','sk','repository','id'].map(AttributeName=>({AttributeName,AttributeType:'S'})),GlobalSecondaryIndexes:[{IndexName:'repository-id-index',KeySchema:[{AttributeName:'repository',KeyType:'HASH'},{AttributeName:'id',KeyType:'RANGE'}],Projection:{ProjectionType:'ALL'}}]}));created=true;
 const repositories=createDynamoRepositories(client,{tableName:table,cellId:'cell'}),f=await retainedSourceHttpFixture(t,repositories),bytes=Buffer.from('Dynamo HTTP source with actual immutable local bytes'),checksum=createHash('sha256').update(bytes).digest('hex');
 const response=await f.request('/studio/files/uploads',{method:'POST',body:{creatorId:'creator',originalFilename:'Dynamo.txt',mimeType:'text/plain',sizeBytes:bytes.length,checksumSha256:checksum}});assert.equal(response.status,201,JSON.stringify(response.body));assert.equal((await f.request(response.body.uploadPath,{method:'PUT',body:bytes,headers:response.body.requiredHeaders})).status,204);
 const id=response.body.file.fileId,done=await f.request(`/studio/files/${id}/complete`,{method:'POST'});assert.equal(done.status,200,JSON.stringify(done.body));assert.equal(done.body.checksumSha256,checksum);const receipt=await f.uploads.readPhysicalReceipt(id);await f.restart();assert.deepEqual((await f.request(`/studio/files/${id}/download`)).bytes,bytes);assert.deepEqual(await f.uploads.readPhysicalReceipt(id),receipt);assert.equal(f.settlements.size,1);assert.equal((await repositories.works.list({limit:100})).items.length,0);
});
