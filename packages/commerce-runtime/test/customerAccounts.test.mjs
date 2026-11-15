import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createLocalAdapterSet,SqliteCommerceStore} from '@ubeeq/adapter-local';
import {CommerceService,CommerceError} from '@ubeeq/commerce';
import {createCustomerAccounts} from '../dist/index.js';
const key='actual-local-customer-contract-key-32-bytes',password='Actual customer password 123!';
async function fixture(t,brand){
 const directory=await mkdtemp(join(tmpdir(),'customer-accounts-')),databasePath=join(directory,'identity.sqlite');let local,store,service,accounts;
 const home={instanceId:'instance',homeCellId:'cell',dataHomeRegion:'local',dataHomeAssignedAt:new Date().toISOString(),routingRevision:1};
 const profileId=userId=>'profile-'+createHash('sha256').update(userId).digest('hex');
 const open=()=>{
  local=createLocalAdapterSet({databasePath,dataDirectory:directory,cellId:'cell',publicBaseUrl:'http://127.0.0.1'});store=new SqliteCommerceStore('tenant',join(directory,'commerce.sqlite'),key);
  const unavailable=async()=>{throw Error('No payment/media/provider acceptance is installed in this customer contract test.');};
  service=new CommerceService({store,tokenKey:key,publicBaseUrl:'https://shop.example.test',mail:{send:unavailable},provider:{},assets:{},authorizeCreator:unavailable,assertEligible:unavailable,connection:unavailable,withConnectionLock:unavailable,markVerified:unavailable});
  const getProfile=async userId=>(await local.repositories.hostRecords.get(profileId(userId)))?.value;
  accounts=createCustomerAccounts({tenantId:'tenant',brand,identity:local.identity,identityProvider:local.identity.customerAccounts,getUserProfile:getProfile,
   createUserProfileIfAbsent:profile=>local.repositories.transaction(async transaction=>{const old=await local.repositories.hostRecords.get(profileId(profile.userId),{transaction});if(old)return old.value;return (await local.repositories.hostRecords.create({id:profileId(profile.userId),...home,namespace:'user-profile',scopeId:'users',key:profile.userId,value:profile},{transaction})).value;}),
   passwordAuthority:async(userId,operation,expected)=>local.repositories.transaction(async transaction=>{if(expected)assert.equal(transaction.id,expected.id);const [subject,snapshot,creators,profile]=await Promise.all([local.identity.getAuthorizationSubject(userId),local.repositories.hostRecords.snapshot(),local.repositories.creators.snapshot(),getProfile(userId)]);await snapshot.bind(transaction);await creators.bind(transaction);if(subject?.accountScope!=='customer_account'||profile?.status==='inactive'||!profile)throw new CommerceError('account_standard_sign_in_required',403);if(creators.items.some(creator=>creator.subjectId===userId)||snapshot.items.some(row=>row.namespace==='creator-member'&&row.key===userId&&creators.items.some(creator=>creator.id===row.scopeId)))throw new CommerceError('account_standard_sign_in_required',403);return operation();}),
   ordinaryCustomer:async userId=>{const [creators,hosts]=await Promise.all([local.repositories.creators.snapshot(),local.repositories.hostRecords.snapshot()]);return local.repositories.transaction(async transaction=>{await creators.bind(transaction);await hosts.bind(transaction);const role=hosts.items.find(row=>row.namespace==='platform-role'&&row.key===userId);return (!role||role.value.role==='user')&&!creators.items.some(creator=>creator.subjectId===userId)&&!hosts.items.some(row=>row.namespace==='creator-member'&&row.key===userId&&creators.items.some(creator=>creator.id===row.scopeId));});}
  },{store,service});
 };
 open();t.after(async()=>{store.close();local.database.close();await rm(directory,{recursive:true,force:true});});
 return {get local(){return local;},get store(){return store;},get service(){return service;},get accounts(){return accounts;},async reopen(){store.close();local.database.close();open();}};
}
test('durable default and legacy namespace hashing retain real current customer principals and full profiles',async t=>{
 for(const brand of [undefined,{brandId:'custom',productName:'Example',studioName:'Example Studio',legacyCustomerAccountConfig:{idHashNamespace:'legacy-member:',idPrefix:'legacy-',ownerId:'legacy-members',sessionCookieName:'legacy.member.session'}}]){
  const f=await fixture(t,brand),created=await f.accounts.provision({email:'buyer@example.test',commerceSubjectId:'original-customer'}),config=f.accounts.resolveConfig(),id=createHash('sha256').update(config.idHashNamespace+'buyer@example.test').digest('hex'),saved=await f.store.transaction(tx=>tx.get('memberAccount',id));
  assert.equal(saved.userId,created.userId);assert.equal(saved.ownerId,config.ownerId);assert.ok(created.username.startsWith(config.idPrefix));assert.equal(saved.passwordHash,undefined);assert.equal((await f.local.identity.getAuthorizationSubject(created.userId)).accountScope,'customer_account');assert.equal((await f.local.identity.getAuthorizationSubject(created.userId)).emailVerified,true);
  const session=await f.service.issueAccountSession(saved.commerceSubjectId,saved.userId);await f.reopen();assert.equal((await f.accounts.accountForSession(session.token)).userId,created.userId);assert.equal(session.token.split('.').length,2);
 }
});
test('actual Local initial/password changes use canonical credentials and retain only the current commerce session',async t=>{
 const f=await fixture(t),created=await f.accounts.provision({email:'password@example.test',commerceSubjectId:'password-customer'}),email=await f.service.issueAccountSession('password-customer',created.userId);await f.accounts.setPassword(email.token,password);
 const one=await f.accounts.passwordSignIn('password@example.test',password),two=await f.accounts.passwordSignIn('password@example.test',password),sdk=await f.local.identity.authenticate({email:'password@example.test',password});assert.equal(sdk.session.subject.accountScope,'customer_account');await assert.rejects(f.accounts.passwordSignIn('password@example.test','incorrect'),{status:401});
 await f.accounts.changePassword(one.token,password,'Actual replacement password 456!');assert.equal(await f.local.identity.verifySession({credential:sdk.token}),undefined);await assert.rejects(f.accounts.accountForSession(two.token),{status:401});assert.equal((await f.accounts.accountForSession(one.token)).userId,created.userId);
 await f.reopen();assert.equal((await f.accounts.passwordSignIn('password@example.test','Actual replacement password 456!')).account.userId,created.userId);
});
test('a missing durable profile/identity contract never invents an in-memory customer account',()=>{
 assert.throws(()=>createCustomerAccounts({tenantId:'tenant'},{store:{},service:{}}),{code:'account_registration_unavailable',status:503});
});
test('existing actual operator identities and arbitrary verified-user DTOs cannot become customer sessions',async t=>{
 const f=await fixture(t),credentials={email:'operator@example.test',password},account=await f.local.identity.register(credentials),before=await f.local.identity.getAuthorizationSubject(account.subjectId);await assert.rejects(f.accounts.provision({email:credentials.email,commerceSubjectId:'operator-customer'}),{status:403});assert.deepEqual(await f.local.identity.getAuthorizationSubject(account.subjectId),before);assert.equal((await f.store.transaction(tx=>tx.list('memberAccount'))).length,0);
 const signed=await f.local.identity.authenticate(credentials);await assert.rejects(f.accounts.issueVerifiedLocalSession(signed.token),{status:403});await assert.rejects(f.accounts.issueVerifiedLocalSession({userId:account.subjectId,email:credentials.email,emailVerified:true}));
});
test('member token verification rejects altered, three-part, revoked and nonexistent credentials using actual commerce records',async t=>{
 const f=await fixture(t),created=await f.accounts.provision({email:'token@example.test',commerceSubjectId:'token-customer'}),signed=await f.service.issueAccountSession('token-customer',created.userId);assert.equal((await f.accounts.resolveAuth(signed.token)).accountScope,'customer_account');
 for(const token of [signed.token+'.extra',signed.token+'x','unknown.invalid',''])assert.equal(await f.accounts.resolveAuth(token),undefined);
 await f.accounts.signOut(signed.token);assert.equal(await f.accounts.resolveAuth(signed.token),undefined);
});
