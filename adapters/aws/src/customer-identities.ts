import {cognitoUserBySubject} from './cognito-subject.js';
import {randomBytes,randomUUID} from 'node:crypto';
import {AdminCreateUserCommand,AdminGetUserCommand,AdminSetUserPasswordCommand,ChangePasswordCommand,InitiateAuthCommand,DescribeUserPoolCommand,DescribeUserPoolClientCommand,ListUserPoolClientsCommand} from '@aws-sdk/client-cognito-identity-provider';
import {CustomerIdentityError,type CustomerIdentity,type CustomerIdentityProvider,type IdentityAdapter,type CustomerPasswordAcceptance,type CustomerPasswordEffect} from '@ubeeq/auth';
import type {AwsCommandClient} from './client-port.js';
const unavailable=()=>new CustomerIdentityError('unavailable','Current Cognito customer account evidence is unavailable.');
const normalized=(value:string)=>{if(typeof value!=='string'||value.length>254)throw unavailable();const email=value.trim().toLowerCase();if(!/^\S+@\S+\.\S+$/.test(email))throw unavailable();return email;};
/** Real Cognito lifecycle. No production Local fallback and no claim that these
 * commands are an atomic transaction with commerce/profile persistence. */
export class CognitoCustomerIdentities implements CustomerIdentityProvider {
 readonly provider='cognito' as const;
 constructor(private readonly client:AwsCommandClient,private readonly pool:string,private readonly application:string,private readonly live:Pick<IdentityAdapter,'getAccount'|'getAuthorizationSubject'|'verifySession'>,private readonly subjectIdMode:'legacy_username'|'canonical_sub'='legacy_username'){if(!pool||!application||!live.getAuthorizationSubject)throw unavailable();}
 async verifyConfiguration():Promise<void>{
  try{
   const pool=(await this.client.send(new DescribeUserPoolCommand({UserPoolId:this.pool}))).UserPool;
   const scope=pool?.SchemaAttributes?.filter((attribute:{Name?:string})=>['account_scope','custom:account_scope'].includes(attribute.Name??''));
   if(!scope||scope.length!==1||scope[0].AttributeDataType!=='String')throw unavailable();
   const claims=pool?.LambdaConfig?.PreTokenGenerationConfig;if(!claims||!['V2_0','V3_0'].includes(claims.LambdaVersion)||typeof claims.LambdaArn!=='string'||!claims.LambdaArn)throw unavailable();
   const seen=new Set<string>(),cursors=new Set<string>();let token:string|undefined;
   do{
    const page=await this.client.send(new ListUserPoolClientsCommand({UserPoolId:this.pool,MaxResults:60,...(token?{NextToken:token}:{})}));
    if(!Array.isArray(page.UserPoolClients))throw unavailable();
    for(const entry of page.UserPoolClients){
     if(typeof entry.ClientId!=='string'||!entry.ClientId||seen.has(entry.ClientId))throw unavailable();seen.add(entry.ClientId);
     const application=(await this.client.send(new DescribeUserPoolClientCommand({UserPoolId:this.pool,ClientId:entry.ClientId}))).UserPoolClient;
     // Omitted WriteAttributes permits the provider defaults; it is not proof
     // that untrusted clients cannot promote a customer to creator_operator.
     if(!application||!Array.isArray(application.WriteAttributes)||application.WriteAttributes.some((name:string)=>['account_scope','custom:account_scope'].includes(name)))throw unavailable();
    }
    if(page.NextToken!==undefined&&(typeof page.NextToken!=='string'||!page.NextToken||cursors.has(page.NextToken)))throw unavailable();token=page.NextToken;if(token)cursors.add(token);
   }while(token);
   if(!seen.has(this.application))throw unavailable();
  }catch{throw unavailable();}
 }
 private async read(username:string,canonical=false):Promise<CustomerIdentity|undefined>{
  let user;try{user=canonical?await cognitoUserBySubject(this.client,this.pool,username):await this.client.send(new AdminGetUserCommand({UserPoolId:this.pool,Username:username}));}catch(error){if((error as {name?:string})?.name==='UserNotFoundException')return undefined;throw unavailable();}
  if(user===undefined)return undefined;
  if(!user||typeof user.Username!=='string'||!user.Username||typeof user.Enabled!=='boolean'||!Array.isArray(user.UserAttributes))throw unavailable();
  const attribute=(key:string)=>{const values=user.UserAttributes.filter((value:{Name?:string;Value?:string})=>value.Name===key);if(values.length!==1||typeof values[0].Value!=='string')throw unavailable();return values[0].Value as string;};
  const sub=attribute('sub'),email=normalized(attribute('email')),emailVerified=attribute('email_verified')==='true',scopeValues=user.UserAttributes.filter((value:{Name?:string})=>value.Name==='custom:account_scope');
  if(scopeValues.length>1||scopeValues.length&& !['creator_operator','customer_account'].includes(scopeValues[0].Value))throw unavailable();
  const accountScope=scopeValues[0]?.Value==='customer_account'?'customer_account':'creator_operator';
  const id=accountScope==='customer_account'||this.subjectIdMode==='canonical_sub'?sub:user.Username;
  const [account,subject]=await Promise.all([this.live.getAccount(id),this.live.getAuthorizationSubject!(id)]);
  if(!account||account.subjectId!==id)throw unavailable();
  const standardSignInRequired=!user.Enabled||!emailVerified||accountScope!=='customer_account'||!['CONFIRMED','FORCE_CHANGE_PASSWORD'].includes(user.UserStatus)||!!user.UserMFASettingList?.length||!subject||subject.id!==id||subject.accountScope!=='customer_account'||subject.roles.some(role=>['Admins','admin','Creators','creator','Contributors','contributor','Artists'].includes(role));
  return {userId:id,email,emailVerified,accountScope,provider:'cognito',providerUsername:user.Username,account,passwordSetupRequired:user.UserStatus==='FORCE_CHANGE_PASSWORD',standardSignInRequired};
 }
 async findByEmail(email:string){const normalizedEmail=normalized(email),user=await this.read(normalizedEmail);if(user&&user.email!==normalizedEmail)throw unavailable();return user;}
 async current(userId:string){let user=await this.read(userId,this.subjectIdMode==='canonical_sub');if(!user&&this.subjectIdMode==='legacy_username')user=await this.read(userId,true);if(user&&user.userId!==userId)throw unavailable();return user;}
 async provisionVerifiedEmail(email:string):Promise<CustomerIdentity>{
  await this.verifyConfiguration();const address=normalized(email);let user=await this.findByEmail(address);
  if(!user){try{await this.client.send(new AdminCreateUserCommand({UserPoolId:this.pool,Username:address,MessageAction:'SUPPRESS',TemporaryPassword:randomBytes(32).toString('base64')+'aA1!',UserAttributes:[{Name:'email',Value:address},{Name:'email_verified',Value:'true'},{Name:'custom:account_scope',Value:'customer_account'}]}));}catch(error){if((error as {name?:string})?.name!=='UsernameExistsException')throw unavailable();}user=await this.findByEmail(address);}
  if(!user)throw unavailable();return user;
 }
 private async customer(userId:string):Promise<CustomerIdentity>{const user=await this.current(userId);if(!user||user.account.status!=='active'||user.accountScope!=='customer_account'||user.standardSignInRequired)throw new CustomerIdentityError('standard_sign_in_required','Use the account’s existing Cognito sign-in method.');return user;}
 async setInitialPassword(userId:string,password:string,acceptance?:CustomerPasswordAcceptance):Promise<CustomerPasswordEffect>{
  await this.verifyConfiguration();const user=await this.customer(userId);if(!user.passwordSetupRequired)throw new CustomerIdentityError('password_already_set','A password is already set.');
  await acceptance?.accept();const operationId=acceptance?.operationId??randomUUID();
  try{const result=await this.client.send(new AdminSetUserPasswordCommand({UserPoolId:this.pool,Username:user.providerUsername,Password:password,Permanent:true}));return {schemaVersion:1,operationId,userId,provider:'cognito',kind:'initial',appliedAt:new Date().toISOString(),...(result.$metadata?.requestId?{providerRequestId:result.$metadata.requestId}:{})};}catch(error){if((error as {name?:string})?.name==='InvalidPasswordException')throw new CustomerIdentityError('invalid_password','Cognito password requirements were not met.');throw unavailable();}
 }
 private async authenticate(user:CustomerIdentity,password:string):Promise<string>{
  let response;try{response=await this.client.send(new InitiateAuthCommand({ClientId:this.application,AuthFlow:'USER_PASSWORD_AUTH',AuthParameters:{USERNAME:user.providerUsername,PASSWORD:password}}));}catch(error){if((error as {name?:string})?.name==='NotAuthorizedException')throw new CustomerIdentityError('invalid_credentials','The current password is incorrect.');throw unavailable();}
  if(response.ChallengeName||!response.AuthenticationResult?.AccessToken)throw new CustomerIdentityError('standard_sign_in_required','Complete the account’s normal Cognito challenge.');
  const token=response.AuthenticationResult.AccessToken,verified=await this.live.verifySession({credential:token});
  if(!verified||verified.subject.id!==user.userId||verified.subject.accountScope!=='customer_account')throw unavailable();return token;
 }
 async verifyPassword(email:string,password:string){await this.verifyConfiguration();const user=await this.findByEmail(email);if(!user)return undefined;await this.customer(user.userId);await this.authenticate(user,password);return this.customer(user.userId);}
 async changePassword(userId:string,current:string,next:string,acceptance?:CustomerPasswordAcceptance):Promise<CustomerPasswordEffect>{
  await this.verifyConfiguration();const user=await this.customer(userId);if(user.passwordSetupRequired)throw new CustomerIdentityError('standard_sign_in_required','Initial password setup is required.');
  const accessToken=await this.authenticate(user,current);
  await acceptance?.accept();const operationId=acceptance?.operationId??randomUUID();
  try{const result=await this.client.send(new ChangePasswordCommand({AccessToken:accessToken,PreviousPassword:current,ProposedPassword:next}));return {schemaVersion:1,operationId,userId,provider:'cognito',kind:'change',appliedAt:new Date().toISOString(),...(result.$metadata?.requestId?{providerRequestId:result.$metadata.requestId}:{})};}catch(error){const name=(error as {name?:string})?.name;if(name==='NotAuthorizedException')throw new CustomerIdentityError('invalid_credentials','The current password is incorrect.');if(name==='InvalidPasswordException')throw new CustomerIdentityError('invalid_password','Cognito password requirements were not met.');throw unavailable();}
 }
}
