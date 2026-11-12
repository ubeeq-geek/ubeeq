import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLocalAdapterSet } from '@ubeeq/adapter-local';
import { PasswordAuthenticationError } from '@ubeeq/auth';
import { createCoreRuntime } from '../dist/index.js';
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'password-authentication-'));
  const local = createLocalAdapterSet({ databasePath: join(directory,'core.sqlite'), dataDirectory: directory, publicBaseUrl:'http://localhost', cellId:'test-cell' });
  await local.identity.register({ email:'operator@example.test', password:'Synthetic password 123!' });
  const port = { authenticate: input => local.identity.authenticate(input) };
  const runtime = createCoreRuntime({ instanceId:'test-instance', cellId:'test-cell', publicBaseUrl:'http://localhost', adapters:{ repositories:local.repositories, storage:local.storage, uploads:local.storage, delivery:local.storage, jobs:local.jobs, identity:local.identity, passwordAuthentication:port } });
  await new Promise(resolve => runtime.server.listen(0,'127.0.0.1',resolve));
  t.after(async () => { await runtime.close(); local.database.close(); await rm(directory,{recursive:true,force:true}); });
  const request = async (path,body,token) => {
    const response = await fetch(`http://127.0.0.1:${runtime.server.address().port}${path}`,{method:body?'POST':'GET',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{})});
    return { response, body:await response.json() };
  };
  return {port,local,request};
}
const credentials={email:'operator@example.test',password:'Synthetic password 123!'};
test('password sign-in works without exposing a local registration surface',async t=>{
  const f=await fixture(t);
  const signed=await f.request('/v1/auth/sign-in',credentials);
  assert.equal(signed.response.status,200);assert.equal(signed.response.headers.get('cache-control'),'no-store');
  assert.ok(signed.body.token);assert.ok(Date.parse(signed.body.expiresAt)>Date.now());
  assert.equal((await f.request('/v1/creators',null,signed.body.token)).response.status,200);
  assert.equal((await f.request('/v1/auth/sign-up',{email:'another@example.test',password:credentials.password})).response.status,404);
});
test('password sign-in distinguishes credential failure, required challenge and provider outage without disclosing diagnostics',async t=>{
  const f=await fixture(t);
  for(const [code,status] of [['invalid_credentials',401],['authentication_challenge_required',409],['identity_provider_unavailable',503]]) {
    f.port.authenticate=async()=>{throw new PasswordAuthenticationError(code);};
    const result=await f.request('/v1/auth/sign-in',credentials);
    assert.equal(result.response.status,status);assert.equal(result.body.error.code,code);
    assert.equal(result.response.headers.get('cache-control'),'no-store');assert.ok(!JSON.stringify(result.body).includes(credentials.password));
  }
  f.port.authenticate=async()=>{throw Error('private provider diagnostic and credential');};
  const unknown=await f.request('/v1/auth/sign-in',credentials);
  assert.equal(unknown.response.status,503);assert.ok(!JSON.stringify(unknown.body).includes('private provider'));
});
test('malformed or expired password-broker sessions never return a token',async t=>{
  const f=await fixture(t);
  for(const result of [undefined,{token:'opaque',session:{subject:{id:'actor'},expiresAt:'not-a-date'}},{token:'opaque',session:{subject:{id:'actor'},expiresAt:'2000-01-01T00:00:00.000Z'}},{token:' opaque ',session:{subject:{id:'actor'},expiresAt:new Date(Date.now()+60_000).toISOString()}}]) {
    f.port.authenticate=async()=>result;
    const response=await f.request('/v1/auth/sign-in',credentials);
    assert.equal(response.response.status,503);assert.equal(response.body.token,undefined);
  }
});
