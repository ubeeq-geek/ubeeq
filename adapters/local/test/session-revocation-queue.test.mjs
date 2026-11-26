import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setImmediate as turn} from 'node:timers/promises';
import {createLocalAdapterSet} from '../dist/index.js';
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};};
for(const outcome of ['commit','rollback'])test(`real independent Local sign-out queues behind an accepting session writer that will ${outcome}`,{timeout:30000},async t=>{
 const directory=await mkdtemp(join(tmpdir(),'local-revocation-queue-')),local=createLocalAdapterSet({databasePath:join(directory,'core.sqlite'),dataDirectory:directory,cellId:'cell',publicBaseUrl:'http://127.0.0.1'}),entered=deferred(),release=deferred();let holder,revocation;
 t.after(async()=>{release.resolve();await Promise.allSettled([holder,revocation].filter(Boolean));local.database.close();await rm(directory,{recursive:true,force:true});});
 const input={email:'real-'+outcome+'@revocation.test',password:'Actual Local revocation password 123!'},account=await local.identity.register(input),signed=await local.identity.authenticate(input);assert.equal(signed.session.subject.id,account.subjectId);
 // Both calls originate in this outer context. Starting revoke from inside the
 // holder callback would inherit its ALS transaction and test a different case.
 holder=local.identity.withVerifiedSession({credential:signed.token},async(session,transaction)=>{assert.equal(session.id,signed.session.id);assert.ok(transaction.id);entered.resolve();await release.promise;if(outcome==='rollback')throw Error('actual accepting holder rollback');return session.id;});
 void holder.catch(()=>{});const held=outcome==='rollback'?assert.rejects(holder,/actual accepting holder rollback/):holder;await entered.promise;
 let acknowledged=false,rejected;
 revocation=local.identity.revokeSession({sessionId:signed.session.id}).then(()=>{acknowledged=true;},error=>{rejected=error;throw error;});void revocation.catch(()=>{});
 await turn();assert.equal(acknowledged,false,'sign-out cannot acknowledge while another Local writer is still accepting');assert.equal(rejected,undefined,'independent sign-out queues instead of failing the existing owner guard');
 release.resolve();if(outcome==='commit')assert.equal(await held,signed.session.id);else await held;
 await revocation;assert.equal(acknowledged,true);assert.equal(await local.identity.verifySession({credential:signed.token}),undefined);
 assert.ok(local.database.database.prepare('SELECT revoked_at FROM ubeeq_sessions WHERE id=?').get(signed.session.id).revoked_at,'acknowledged revocation persists after either holder outcome');
});
