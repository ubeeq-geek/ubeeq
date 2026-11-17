// Truthful Cognito command/response unit controls; NOT provider acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import {CognitoIdentity} from '../dist/index.js';
const email='buyer@example.test',id='canonical-customer-sub',username='actual-provider-username';
function fixture(existing=false){
 const calls=[],state={user:existing?{Username:username,Enabled:true,UserStatus:'CONFIRMED',UserCreateDate:new Date(),UserLastModifiedDate:new Date(),UserAttributes:[{Name:'sub',Value:id},{Name:'email',Value:email},{Name:'email_verified',Value:'true'},{Name:'custom:account_scope',Value:'customer_account'}]}:undefined,scopeSchema:true,claimsTrigger:true,writable:false,groups:[],challenge:false};
 const client={send:async command=>{
  calls.push(command);const input=command.input;
  switch(command.constructor.name){
   case 'DescribeUserPoolCommand':return {UserPool:{SchemaAttributes:state.scopeSchema?[{Name:'custom:account_scope',AttributeDataType:'String',Mutable:true}]:[],...(state.claimsTrigger?{LambdaConfig:{PreTokenGenerationConfig:{LambdaVersion:'V2_0',LambdaArn:'arn:aws:lambda:ca-central-1:123456789012:function:real-scope-trigger'}}}:{})}};
   case 'ListUserPoolClientsCommand':return input.NextToken?{UserPoolClients:[{ClientId:'secondary'}]}:{UserPoolClients:[{ClientId:'application'}],NextToken:'second-page'};
   case 'DescribeUserPoolClientCommand':return {UserPoolClient:{ClientId:input.ClientId,WriteAttributes:state.writable&&input.ClientId==='secondary'?['email','custom:account_scope']:['email','name'],ExplicitAuthFlows:['ALLOW_USER_PASSWORD_AUTH']}};
   case 'AdminGetUserCommand':if(!state.user||![email,id,username].includes(input.Username))throw Object.assign(Error('not found'),{name:'UserNotFoundException'});return structuredClone(state.user);
   case 'AdminListGroupsForUserCommand':assert.equal(input.Username,username);return {Groups:state.groups.map(GroupName=>({GroupName}))};
   case 'AdminCreateUserCommand':assert.equal(input.Username,email);state.user={Username:username,Enabled:true,UserStatus:'FORCE_CHANGE_PASSWORD',UserCreateDate:new Date(),UserLastModifiedDate:new Date(),UserAttributes:[{Name:'sub',Value:id},...input.UserAttributes]};return {User:structuredClone(state.user)};
   case 'AdminSetUserPasswordCommand':assert.equal(input.Username,username);assert.equal(input.Permanent,true);state.user.UserStatus='CONFIRMED';return {$metadata:{requestId:'actual-command-unit-request-id'}};
   case 'InitiateAuthCommand':assert.equal(input.AuthFlow,'USER_PASSWORD_AUTH');assert.equal(input.AuthParameters.USERNAME,username);return state.challenge?{ChallengeName:'SOFTWARE_TOKEN_MFA'}:{AuthenticationResult:{AccessToken:'actual-response-access-token'}};
   case 'GetUserCommand':assert.equal(input.AccessToken,'actual-response-access-token');return {Username:username,UserAttributes:structuredClone(state.user.UserAttributes)};
   case 'ChangePasswordCommand':assert.equal(input.AccessToken,'actual-response-access-token');return {};
   default:throw Error('Unexpected command '+command.constructor.name);
  }
 }};
 const adapter=new CognitoIdentity(client,'ca-central-1_TEST','application',{subjectIdMode:'canonical_sub',verifier:{verify:async token=>{assert.equal(token,'actual-response-access-token');return {sub:id,username,iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+3600,'cognito:groups':[],'custom:account_scope':'customer_account'};}}});
 return {adapter,provider:adapter.customerAccounts,state,calls};
}
test('Cognito genuine new customer request sets only customer scope and current canonical sub survives a different provider Username',async()=>{
 const f=fixture(),user=await f.provider.provisionVerifiedEmail(email);assert.equal(user.userId,id);assert.equal(user.providerUsername,username);assert.equal(user.passwordSetupRequired,true);assert.equal(user.standardSignInRequired,false);assert.equal((await f.adapter.getAccount(id)).status,'active');assert.equal((await f.adapter.getAuthorizationSubject(id)).accountScope,'customer_account');
 const created=f.calls.find(command=>command.constructor.name==='AdminCreateUserCommand');assert.deepEqual(created.input.UserAttributes,[{Name:'email',Value:email},{Name:'email_verified',Value:'true'},{Name:'custom:account_scope',Value:'customer_account'}]);assert.equal(created.input.MessageAction,'SUPPRESS');
 const receipt=await f.provider.setInitialPassword(id,'Actual customer password 123!',{operationId:'actual-unit-operation',accept:async()=>{assert.equal((await f.adapter.getAccount(id)).status,'active');assert.equal((await f.adapter.getAuthorizationSubject(id)).accountScope,'customer_account');}});assert.equal(receipt.operationId,'actual-unit-operation');assert.equal(receipt.providerRequestId,'actual-command-unit-request-id');assert.equal(receipt.kind,'initial');assert.equal((await f.provider.current(id)).passwordSetupRequired,false);assert.equal((await f.adapter.verifySession({credential:'actual-response-access-token'})).subject.id,id);
});
test('Cognito scope schema and every paginated app client must prevent untrusted scope writes before account creation',async()=>{
 for(const field of ['scopeSchema','claimsTrigger','writable']){
  const f=fixture();f.state[field]=field==='writable';await assert.rejects(f.provider.provisionVerifiedEmail(email),{code:'unavailable'});assert.equal(f.calls.some(command=>command.constructor.name==='AdminCreateUserCommand'),false);
 }
});
test('existing Cognito operators are read without conversion, and MFA/external/disabled customer accounts require standard sign-in',async()=>{
 const f=fixture(true);f.state.user.UserAttributes.find(value=>value.Name==='custom:account_scope').Value='creator_operator';const user=await f.provider.provisionVerifiedEmail(email);assert.equal(user.accountScope,'creator_operator');assert.equal(user.standardSignInRequired,true);assert.equal(f.calls.some(command=>command.constructor.name==='AdminCreateUserCommand'),false);await assert.rejects(f.provider.setInitialPassword(id,'Actual customer password 123!'),{code:'standard_sign_in_required'});
 for(const changes of [{UserMFASettingList:['SOFTWARE_TOKEN_MFA']},{UserStatus:'EXTERNAL_PROVIDER'},{Enabled:false}]){const next=fixture(true);Object.assign(next.state.user,changes);assert.equal((await next.provider.current(id)).standardSignInRequired,true);}
});
test('only verified customer FORCE_CHANGE_PASSWORD status is active for email-first setup; an operator remains pending',async()=>{
 const f=fixture(true);f.state.user.UserStatus='FORCE_CHANGE_PASSWORD';assert.equal((await f.adapter.getAccount(id)).status,'active');f.state.user.UserAttributes.find(value=>value.Name==='custom:account_scope').Value='creator_operator';assert.equal((await f.adapter.getAccount(id)).status,'pending_verification');assert.equal(await f.adapter.getAuthorizationSubject(id),undefined);
});
test('Cognito password change uses the actual authenticated canonical subject and never skips an MFA challenge',async()=>{
 const f=fixture(true);await f.provider.changePassword(id,'Actual previous password 123!','Actual replacement password 456!');assert.equal(f.calls.filter(command=>command.constructor.name==='ChangePasswordCommand').length,1);
 f.state.challenge=true;await assert.rejects(f.provider.changePassword(id,'Actual previous password 123!','Actual replacement password 456!'),{code:'standard_sign_in_required'});assert.equal(f.calls.filter(command=>command.constructor.name==='ChangePasswordCommand').length,1);
});

test('Cognito provider acceptance invokes actual current guard before any password command and retains acknowledged effect identity',async()=>{const f=fixture();await f.provider.provisionVerifiedEmail(email);await assert.rejects(f.provider.setInitialPassword(id,'Actual customer password 123!',{operationId:'denied-unit-operation',accept:async()=>{throw Error('current policy revoked');}}),/current policy revoked/);assert.equal(f.calls.some(command=>command.constructor.name==='AdminSetUserPasswordCommand'),false);assert.equal((await f.provider.current(id)).passwordSetupRequired,true);});
