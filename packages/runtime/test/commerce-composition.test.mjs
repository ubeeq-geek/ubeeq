import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,stat} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createLocalAdapterSet} from '@ubeeq/adapter-local';
import {createCoreRuntime} from '../dist/index.js';
const key='Explicit actual Local commerce encryption key 12345';
async function fixture(t){const directory=await mkdtemp(join(tmpdir(),'commerce-composition-'));t.after(()=>rm(directory,{recursive:true,force:true}));return directory;}
const configuration=(directory)=>({publicBaseUrl:'http://127.0.0.1',instanceId:'instance',cellId:'cell',region:'local',databasePath:join(directory,'core.sqlite'),dataDirectory:directory,credentialEncryptionKey:key});
const commerce=(directory)=>({publicBaseUrl:'https://purchases.example.test',tokenKey:'Actual isolated commerce signing key 123456',environments:[],financialRetentionDays:365,mail:{send:message=>writeFile(join(directory,encodeURIComponent(message.idempotencyKey)+'.mail'),JSON.stringify(message),{mode:0o600,flag:'wx'})}});
test('trusted hook sees actual owned Local adapters/vault and exposes one durable Commerce runtime with shared worker and disposal',async t=>{
 const directory=await fixture(t);let context,calls=0;
 const core=createCoreRuntime({...configuration(directory),configureCommerce:actual=>{calls++;context=actual;return {configuration:commerce(directory)};}});t.after(()=>core.close());
 assert.equal(calls,1);assert.ok(core.commerce);assert.ok(context.local);assert.equal(context.adapters.identity,context.local?context.adapters.localIdentity:undefined);
 const account=await context.adapters.localIdentity.register({email:'real@composition.test',password:'Actual Local identity password 123!'}),value=Buffer.from('Actual encrypted vault material'),written=await context.local.vault.write({cellId:'cell',ownerId:'owner',value});assert.deepEqual(await context.local.vault.read({cellId:'cell',reference:written.reference}),value);
 await core.commerce.service.beginEmailLogin('buyer@composition.test');let delivered=false;for(let i=0;i<10&&!delivered;i++){const result=await core.runNextJob('actual-core-commerce-unit');delivered=!!result;}assert.equal(delivered,true);
 assert.ok((await core.commerce.store.transaction(tx=>tx.list('login'))).length);await core.close();await assert.rejects(core.commerce.store.transaction(tx=>tx.list('login')));await assert.rejects(context.adapters.identity.getAccount(account.subjectId));
 const reopened=createLocalAdapterSet({...configuration(directory)});try{assert.equal((await reopened.identity.getAccount(account.subjectId)).subjectId,account.subjectId);assert.deepEqual(await reopened.credentials.read({cellId:'cell',reference:written.reference}),value);const stored=reopened.database.database.prepare('SELECT ciphertext,iv,auth_tag FROM ubeeq_credentials WHERE id=?').get(written.reference.split(':').at(-1));assert.notDeepEqual(Buffer.from(stored.ciphertext),value);assert.equal(stored.iv.length,12);assert.equal(stored.auth_tag.length,16);}finally{reopened.database.close();}
 assert.ok((await stat(join(directory,'commerce.sqlite'))).isFile());
});
test('legacy direct Commerce configuration still uses one real runtime and requires an explicit owned-vault key',async t=>{
 const directory=await fixture(t),core=createCoreRuntime({...configuration(directory),commerce:commerce(directory)});t.after(()=>core.close());assert.ok(core.commerce);await core.commerce.service.beginEmailLogin('direct@composition.test');assert.equal((await core.commerce.store.transaction(tx=>tx.list('login'))).length,1);
 const unsafe=join(directory,'unsafe');assert.throws(()=>createCoreRuntime({...configuration(unsafe),credentialEncryptionKey:undefined,configureCommerce:()=>({configuration:commerce(unsafe)})}),/explicit encryption key/);
});
test('invalid or mixed trusted factory configuration fails before concrete Local constructor filesystem I/O',async t=>{
 const directory=await fixture(t);for(const [index,patch] of [{configureCommerce:'invalid'},{configureCommerce:()=>undefined,commerce:commerce(directory)}].entries()){const target=join(directory,'invalid-'+index);assert.throws(()=>createCoreRuntime({...configuration(target),...patch}),/one trusted Commerce/);assert.equal(existsSync(target),false);}
});
test('invalid returned composition closes its actual owned Local adapters and never creates a Commerce store',async t=>{
 const directory=await fixture(t);let owned;assert.throws(()=>createCoreRuntime({...configuration(directory),createLocalAdapters:config=>(owned=createLocalAdapterSet(config)),configureCommerce:()=>Promise.resolve({configuration:commerce(directory)})}),/synchronously/);assert.ok(owned);await assert.rejects(owned.identity.getAccount('missing'));assert.equal(existsSync(join(directory,'commerce.sqlite')),false);
});
test('generic injected-adapter composition cannot silently allocate a Local Commerce store when its genuine durable store is missing',async t=>{
 // Truthful injected-adapter contract unit, not managed/cloud acceptance.
 const directory=await fixture(t),local=createLocalAdapterSet(configuration(directory));t.after(()=>local.database.close());
 assert.throws(()=>createCoreRuntime({...configuration(directory),adapters:{repositories:local.repositories,storage:local.storage,uploads:local.storage,delivery:local.storage,jobs:local.jobs,identity:local.identity,localIdentity:local.identity,credentials:local.credentials},configureCommerce:actual=>{assert.equal(actual.local,undefined);assert.equal(actual.adapters.credentials,local.credentials);return {configuration:{...commerce(directory),vault:actual.adapters.credentials}};}}),/durable store/);assert.equal(existsSync(join(directory,'commerce.sqlite')),false);assert.equal(await local.identity.getAccount('absent'),undefined,'host-owned injected adapters remain open');
});


test('preparation sees the identical already-configured website and Commerce objects without another runtime',async t=>{
 const directory=await fixture(t);let observed,configured=0;
 const core=createCoreRuntime({...configuration(directory),configureCommerce:()=>{configured++;return {configuration:commerce(directory)};},contentPreparation:context=>{observed=context;}});t.after(()=>core.close());
 assert.equal(configured,1);assert.ok(observed.commerce);assert.equal(observed.commerce,core.commerce);assert.equal(observed.website,core.website);assert.ok(observed.website.service);assert.ok(observed.website.persistence);assert.ok(observed.website.publishing);assert.equal(Object.isFrozen(observed.website),true);
 await observed.commerce.service.beginEmailLogin('prepared-buyer@composition.test');assert.equal((await core.commerce.store.transaction(tx=>tx.list('login'))).length,1);
});
test('a failing preparation constructor closes actual previously-created owned services',async t=>{
 const directory=await fixture(t);let observed;const failure=Error('Actual isolated preparation construction failure');
 assert.throws(()=>createCoreRuntime({...configuration(directory),configureCommerce:()=>({configuration:commerce(directory)}),contentPreparation:context=>{observed=context;throw failure;}}),error=>error===failure);
 assert.ok(observed.commerce);await assert.rejects(observed.commerce.store.transaction(tx=>tx.list('login')));await assert.rejects(observed.adapters.identity.getAccount('missing'));await assert.rejects(observed.website.persistence.getDocument('workspace','missing'));
});
