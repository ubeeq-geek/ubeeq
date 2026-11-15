import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createLocalAdapterSet} from '../dist/index.js';
const previous='Actual previous credential 123!',next='Actual replacement credential 456!';
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};};
async function fixture(t){const directory=await mkdtemp(join(tmpdir(),'local-session-witness-')),local=createLocalAdapterSet({databasePath:join(directory,'core.sqlite'),dataDirectory:directory,cellId:'cell',publicBaseUrl:'http://127.0.0.1'});t.after(async()=>{local.database.close();await rm(directory,{recursive:true,force:true});});return local;}
test('actual old-password SDK verification cannot insert a session after a winning password change revoked its predecessor', {timeout:30000},async t=>{
 const local=await fixture(t),provider=local.identity.customerAccounts,user=await provider.provisionVerifiedEmail('stale-sdk@credentials.test');await provider.setInitialPassword(user.userId,previous);const prior=await local.identity.authenticate({email:user.email,password:previous});
 const started=deferred(),resume=deferred(),original=local.database.transaction.bind(local.database);let armed=true;
 // authenticate has computed the genuine password hash before entering this
 // actual writer. Pause admission only; every transaction still runs unchanged.
 local.database.transaction=async operation=>{if(armed){armed=false;started.resolve();await resume.promise;}return original(operation);};t.after(()=>resume.resolve());
 const stale=local.identity.authenticate({email:user.email,password:previous});const rejected=assert.rejects(stale,/Invalid local credentials/);await started.promise;
 await provider.changePassword(user.userId,previous,next);assert.equal(await local.identity.verifySession({credential:prior.token}),undefined);
 const count=local.database.database.prepare('SELECT COUNT(*) AS n FROM ubeeq_sessions').get().n;resume.resolve();await rejected;assert.equal(local.database.database.prepare('SELECT COUNT(*) AS n FROM ubeeq_sessions').get().n,count,'no post-revocation session was inserted from the old proof');
 const current=await local.identity.authenticate({email:user.email,password:next});assert.equal((await local.identity.verifySession({credential:current.token})).subject.id,user.userId);
});
test('the Local accepting proof keeps credentials private and checks exact current roles/scope inside the actual writer',async t=>{
 const local=await fixture(t),provider=local.identity.customerAccounts,user=await provider.provisionVerifiedEmail('opaque-proof@credentials.test');await provider.setInitialPassword(user.userId,previous);const proof=await provider.verifyPasswordForSession(user.email,previous);assert.ok(proof);const saved=local.database.database.prepare('SELECT password_hash,salt FROM ubeeq_accounts WHERE id=?').get(user.userId),serialized=JSON.stringify(proof);
 assert.equal(serialized.includes(saved.password_hash),false);assert.equal(serialized.includes(saved.salt),false);assert.equal(serialized.includes(previous),false);assert.equal(serialized.includes('password_hash'),false);
 local.database.database.prepare('UPDATE ubeeq_accounts SET scopes_json=? WHERE id=?').run('["changed-current-scope"]',user.userId);let accepted=false;
 await assert.rejects(proof.accept(async()=>{accepted=true;},{accept:async()=>{accepted=true;}}),{code:'invalid_credentials'});assert.equal(accepted,false);
});
test('unchanged genuine Local Creator registration still signs in under its original persisted subject ID',async t=>{
 const local=await fixture(t),account=await local.identity.register({email:'original-creator@credentials.test',password:previous}),signed=await local.identity.authenticate({email:'original-creator@credentials.test',password:previous});assert.equal(signed.session.subject.id,account.subjectId);assert.equal(signed.session.subject.accountScope,'creator_operator');assert.equal((await local.identity.verifySession({credential:signed.token})).subject.id,account.subjectId);
});
