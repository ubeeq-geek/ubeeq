import {LambdaClient,InvokeCommand} from '@aws-sdk/client-lambda';
import {createCustomerIssuedScopeHandler} from '@ubeeq/adapter-aws';
/** Actual deployable Cognito trigger. An existing compatible advanced trigger
 * is invoked through its configured immutable ARN; its complete result is kept. */
export async function handler(event){
 const userPoolId=process.env.CUSTOMER_SCOPE_USER_POOL_ID??'',clientIds=(process.env.CUSTOMER_SCOPE_CLIENT_IDS??'').split(',').filter(Boolean),delegateArn=process.env.CUSTOMER_SCOPE_DELEGATE_ARN;
 const delegate=delegateArn?async(input)=>{
  if(!/^arn:aws[a-z-]*:lambda:[a-z0-9-]+:\d{12}:function:[A-Za-z0-9_-]+:[1-9][0-9]*$/.test(delegateArn))throw Error('An immutable existing claims trigger ARN is required.');
  const client=new LambdaClient({region:delegateArn.split(':')[3]});try{const result=await client.send(new InvokeCommand({FunctionName:delegateArn,InvocationType:'RequestResponse',Payload:Buffer.from(JSON.stringify(input))}));if(result.FunctionError||result.StatusCode!==200||!result.Payload)throw Error('Existing claims trigger did not return its genuine response.');return JSON.parse(Buffer.from(result.Payload).toString('utf8'));}finally{client.destroy();}
 }:undefined;
 return createCustomerIssuedScopeHandler({userPoolId,clientIds},delegate)(event);
}
