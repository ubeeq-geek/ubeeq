import test from 'node:test';
import assert from 'node:assert/strict';
import { CognitoIdentity, createAwsAdapterSet } from '../dist/index.js';
import { PasswordAuthenticationError } from '@ubeeq/auth';
function fixture() {
  const calls=[], state={result:{AuthenticationResult:{AccessToken:'opaque-token'}},enabled:true};
  const identity=new CognitoIdentity({send:async command=>{
    calls.push(command);
    if(command.constructor.name==='InitiateAuthCommand'){if(state.result instanceof Error)throw state.result;return state.result;}
    if(command.constructor.name==='GetUserCommand')return{Username:'operator',UserAttributes:[{Name:'sub',Value:'subject'},{Name:'email_verified',Value:'true'}]};
    if(command.constructor.name==='AdminGetUserCommand')return{Username:'operator',Enabled:state.enabled,UserStatus:'CONFIRMED'};
    throw Error('Unexpected command');
  }},'us-east-2_test','client',{verifier:{verify:async()=>({sub:'subject',username:'operator',iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+3600})}});
  return {calls,state,identity};
}
test('Cognito password sign-in returns a verified current session bound to the configured client',async()=>{
  const f=fixture(), result=await f.identity.authenticateSession({email:'operator@example.test',password:'Synthetic password 123!'});
  assert.equal(result.token,'opaque-token');assert.equal(result.session.subject.id,'operator');assert.equal(result.session.subject.emailVerified,true);
  assert.deepEqual(f.calls[0].input,{AuthFlow:'USER_PASSWORD_AUTH',ClientId:'client',AuthParameters:{USERNAME:'operator@example.test',PASSWORD:'Synthetic password 123!'}});
  assert.deepEqual(f.calls.map(c=>c.constructor.name),['InitiateAuthCommand','GetUserCommand','AdminGetUserCommand']);
});
for(const [name,code] of [['NotAuthorizedException','invalid_credentials'],['UserNotFoundException','invalid_credentials'],['UserNotConfirmedException','authentication_challenge_required'],['PasswordResetRequiredException','authentication_challenge_required'],['TooManyRequestsException','identity_provider_unavailable']]){
  test(`Cognito ${name} returns a safe ${code} failure`,async()=>{
    const f=fixture();f.state.result=Object.assign(Error('private provider diagnostic'),{name});
    await assert.rejects(f.identity.authenticateSession({email:'operator@example.test',password:'Synthetic password 123!'}),error=>error instanceof PasswordAuthenticationError&&error.code===code&&!error.message.includes('private provider'));
  });
}
test('an incomplete provider challenge never returns a token or consumes its opaque session',async()=>{
  const f=fixture();f.state.result={ChallengeName:'SOFTWARE_TOKEN_MFA',Session:'private-challenge-session',AuthenticationResult:{AccessToken:'not-final'}};
  await assert.rejects(f.identity.authenticateSession({email:'operator@example.test',password:'Synthetic password 123!'}),error=>error.code==='authentication_challenge_required'&&!error.message.includes('private-challenge'));
  assert.equal(f.calls.length,1);
});
test('account disablement between password authentication and session delivery blocks sign-in',async()=>{
  const f=fixture();f.state.enabled=false;
  await assert.rejects(f.identity.authenticateSession({email:'operator@example.test',password:'Synthetic password 123!'}),error=>error.code==='invalid_credentials');
});
test('AWS password broker is explicit and does not add account registration',async()=>{
  const configuration={region:'us-east-2',cellId:'cell',tableName:'records',objectBucket:'objects',queueUrl:'https://sqs.us-east-2.amazonaws.com/000000000000/test',userPoolId:'us-east-2_test',userPoolClientId:'client',credentialSecretPrefix:'test/credentials'};
  const disabled=createAwsAdapterSet(configuration);assert.equal(disabled.passwordAuthentication,undefined);assert.equal(disabled.localIdentity,undefined);
  const enabled=createAwsAdapterSet({...configuration,passwordAuthenticationEnabled:true});
  enabled.identity.authenticateSession=async input=>({input});
  assert.deepEqual(await enabled.passwordAuthentication.authenticate({email:'operator@example.test',password:'Synthetic password 123!'}),{input:{email:'operator@example.test',password:'Synthetic password 123!'}});
  assert.equal(enabled.localIdentity,undefined);
});

test('malformed provider authentication results cannot return an unverified token',async()=>{
  for(const result of [undefined,{}, {AuthenticationResult:{AccessToken:42}}, {AuthenticationResult:{AccessToken:' token '}}]){
    const f=fixture();f.state.result=result;
    await assert.rejects(f.identity.authenticate({username:'operator',password:'Synthetic password 123!'}),error=>error.code==='identity_provider_unavailable');
    assert.equal(f.calls.length,1);
  }
});
