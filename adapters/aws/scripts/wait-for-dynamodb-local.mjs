import {DynamoDBClient,ListTablesCommand} from '@aws-sdk/client-dynamodb';
import {setTimeout} from 'node:timers/promises';

const endpoint=process.env.TEST_DYNAMODB_ENDPOINT;
if(!endpoint||!/^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(endpoint))throw Error('An explicit loopback DynamoDB test endpoint is required.');
const client=new DynamoDBClient({endpoint,region:'ca-central-1',credentials:{accessKeyId:'DUMMYLOCALTEST',secretAccessKey:'DUMMYLOCALTEST'},maxAttempts:1});
try{
  for(let attempt=0;attempt<30;attempt++){
    try{await client.send(new ListTablesCommand({Limit:1}),{abortSignal:AbortSignal.timeout(1000)});process.stdout.write('DynamoDB Local is ready.\n');break;}
    catch(error){if(attempt===29)throw error;await setTimeout(1000);}
  }
}finally{client.destroy();}
