import test from 'node:test';
import assert from 'node:assert/strict';
import {handler} from '../customer-issued-scope-handler.mjs';

test('deployable handler loads the actual SDK producer and binds configured pool/client without provider requests',async()=>{
 const keys=['CUSTOMER_SCOPE_USER_POOL_ID','CUSTOMER_SCOPE_CLIENT_IDS','CUSTOMER_SCOPE_DELEGATE_ARN'],prior=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
 try{
  process.env.CUSTOMER_SCOPE_USER_POOL_ID='us-east-2_actual';process.env.CUSTOMER_SCOPE_CLIENT_IDS='actual-client';delete process.env.CUSTOMER_SCOPE_DELEGATE_ARN;
  const event={version:'2',userPoolId:'us-east-2_actual',callerContext:{clientId:'actual-client'},request:{userAttributes:{sub:'actual-sub','custom:account_scope':'customer_account'}},response:{claimsAndScopeOverrideDetails:{accessTokenGeneration:{scopesToAdd:['existing.scope']}}}};
  const result=await handler(event);assert.equal(result.response.claimsAndScopeOverrideDetails.accessTokenGeneration.claimsToAddOrOverride['custom:account_scope'],'customer_account');assert.deepEqual(result.response.claimsAndScopeOverrideDetails.accessTokenGeneration.scopesToAdd,['existing.scope']);
  await assert.rejects(handler({...event,userPoolId:'other-pool'}),/outside/);
 }finally{for(const key of keys)if(prior[key]===undefined)delete process.env[key];else process.env[key]=prior[key];}
});
