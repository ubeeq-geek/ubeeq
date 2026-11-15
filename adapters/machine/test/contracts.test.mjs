import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PostgresDatabase, PostgresJobQueue, PostgresPasswordIdentity, S3CompatibleStorage, createPostgresRepositories } from "../dist/index.js";
import { verifyCellScopedRepositoryContract, verifyRevisionedRepositoryContract } from "@ubeeq/persistence";
import { verifyJobQueueContract } from "@ubeeq/jobs";
import { verifyObjectStorageContract } from "@ubeeq/storage";
import { verifyPasswordIdentityContract } from "@ubeeq/auth";

const connectionString = process.env.UBEEQ_POSTGRES_TEST_URL;

test('PostgreSQL current principals use current persisted account authority and reject unavailable evidence', async () => {
  const state = { account: { id: 'operator', email: 'operator@example.test', status: 'active', account_scope: 'creator_operator', roles_json: '["creator"]', scopes_json: '["work.publish"]' } };
  const calls = [];
  const identity = new PostgresPasswordIdentity({ queryable: () => ({ query: async (sql, parameters) => {
    calls.push({ sql, parameters });
    if (state.account instanceof Error) throw state.account;
    return { rows: state.account ? [structuredClone(state.account)] : [] };
  } }) });
  assert.deepEqual(await identity.getAuthorizationSubject('operator'), { id: 'operator', email: 'operator@example.test', accountScope: 'creator_operator', roles: ['creator'], scopes: ['work.publish'] });
  Object.assign(state.account, { account_scope: 'customer_account', roles_json: '["customer_account"]', scopes_json: '[]' });
  assert.deepEqual(await identity.getAuthorizationSubject('operator'), { id: 'operator', email: 'operator@example.test', accountScope: 'customer_account', roles: ['customer_account'], scopes: [] });
  state.account.status = 'closed';
  assert.equal(await identity.getAuthorizationSubject('operator'), undefined);
  state.account.status = 'active';
  const baseline = structuredClone(state.account);
  for (const patch of [{ id: 'different' }, { account_scope: 'unknown' }, { roles_json: 'not-json' }, { roles_json: '[1]' }, { scopes_json: '{}' }]) {
    state.account = { ...baseline, ...patch };
    await assert.rejects(identity.getAuthorizationSubject('operator'), /authorization evidence is unavailable/);
  }
  state.account = undefined;
  assert.equal(await identity.getAuthorizationSubject('operator'), undefined);
  state.account = new Error('database unavailable');
  await assert.rejects(identity.getAuthorizationSubject('operator'), /database unavailable/);
  assert.ok(calls.every(call => /FOR SHARE$/.test(call.sql) && call.parameters[0] === 'operator'));
});

test('PostgreSQL principal reads enlist on the active transaction connection', async () => {
  const calls = [];
  const client = { query: async sql => { calls.push(sql); return { rows: [{ id: 'operator', email: 'operator@example.test', status: 'active', account_scope: 'creator_operator', roles_json: '[]', scopes_json: '[]' }] }; }, release: () => {} };
  const database = new PostgresDatabase({ connectionString: 'postgresql://unused', cellId: 'cell-a' }, { query: async () => { throw new Error('Read bypassed its transaction'); }, connect: async () => client });
  const identity = new PostgresPasswordIdentity(database);
  await database.transaction(async () => assert.equal((await identity.getAuthorizationSubject('operator')).id, 'operator'));
  assert.equal(calls[0], 'BEGIN');
  assert.match(calls[1], /FROM ubeeq_accounts WHERE id = \$1 FOR SHARE$/);
  assert.equal(calls[2], 'COMMIT');
});

test('PostgreSQL acknowledgements condition retry budgets and lease expiry in one write', async () => {
  const calls = []; let rowCount = 1;
  const queue = new PostgresJobQueue({ pool: { query: async (sql, parameters) => { calls.push({ sql, parameters }); return { rowCount }; } } });
  const input = { id: 'job', leaseToken: 'lease', error: { code: 'temporary', message: 'retry' }, retryAt: '2026-01-01T00:00:00.000Z' };
  await queue.retry(input);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /CASE WHEN \$1 = 'retry_scheduled' AND attempt >= max_attempts THEN 'dead_lettered' ELSE \$1 END/);
  assert.match(calls[0].sql, /AND state = 'leased' AND lease_token = \$5 AND lease_expires_at > NOW\(\)/);
  assert.deepEqual(calls[0].parameters, ['retry_scheduled', JSON.stringify(input.error), input.retryAt, input.id, input.leaseToken]);
  rowCount = 0;
  for (const method of ['retry', 'complete', 'deadLetter']) await assert.rejects(queue[method](input), /no longer valid/);
  assert.equal(calls.length, 4);
});

test("PostgreSQL repositories and queue satisfy shared durable contracts", { skip: !connectionString }, async () => {
  const database = new PostgresDatabase({ connectionString, cellId: "cell-a", applicationName: "ubeeq-machine-contract" });
  await database.migrate();
  const repositories = createPostgresRepositories(database);
  try {
    await database.pool.query("TRUNCATE ubeeq_idempotency, ubeeq_records, ubeeq_jobs, ubeeq_sessions, ubeeq_accounts CASCADE");
    for (const [name, repository] of Object.entries(repositories).filter(([name]) => name !== "transaction")) {
      await verifyRevisionedRepositoryContract({ repository, createRecord: (id) => ({ id, instanceId: "machine", homeCellId: "cell-a", dataHomeRegion: "test", dataHomeAssignedAt: "2026-01-01T00:00:00.000Z", routingRevision: 1, contractValue: name }), change: () => ({ contractValue: `${name}-updated` }) });
      if (!["federationActors", "remotePublicationReferences", "instanceOperators"].includes(name)) await verifyCellScopedRepositoryContract({ repository, unscopedRepository: repository.repository, cellId: "cell-a" });
    }
    await verifyJobQueueContract(new PostgresJobQueue(database), `postgres-contract-${randomUUID()}`);
    await verifyPasswordIdentityContract(new PostgresPasswordIdentity(database));
    const scope={instanceId:'machine',homeCellId:'cell-a',dataHomeRegion:'test',dataHomeAssignedAt:'2026-01-01',routingRevision:1};
    await repositories.publications.create({id:'legacy-snapshot',...scope,workId:'work',destination:'native',status:'live'});
    await database.pool.query('DELETE FROM ubeeq_repository_versions WHERE repository = $1',['publications']);
    const legacy=await repositories.publications.snapshot();assert.ok(legacy.items.some(row=>row.id==='legacy-snapshot'));
    await database.transaction(async transaction=>{await legacy.bind(transaction);await database.transaction(async joined=>assert.equal(joined.id,transaction.id));});
    for(const operation of ['insert','update','remove']){
      const snapshot=await repositories.publications.snapshot();
      if(operation==='insert')await repositories.publications.create({id:'changed-snapshot',...scope,workId:'work',destination:'native',status:'live'});
      else if(operation==='update')await repositories.publications.update('changed-snapshot',1,{status:'removed'});
      else await repositories.publications.remove('changed-snapshot',2);
      await assert.rejects(database.transaction(async transaction=>{await assert.rejects(snapshot.bind(transaction),{name:'OptimisticConcurrencyError'});}),/aborted/);
    }
  } finally { await database.close(); }
});

test('PostgreSQL current authority locks prevent concurrent scope changes and sessions observe revocation', { skip: !connectionString }, async () => {
  const database = new PostgresDatabase({ connectionString, cellId: 'cell-a', applicationName: 'ubeeq-current-principal-contract' });
  await database.migrate();
  const identity = new PostgresPasswordIdentity(database);
  const credentials = { email: `current-principal-${randomUUID()}@example.test`, password: 'current-principal-password' };
  let account, competitor;
  try {
    account = await identity.register(credentials);
    const login = await identity.authenticate(credentials);
    assert.equal(login.session.subject.accountScope, 'creator_operator');
    await assert.rejects(database.transaction(async () => {
      await database.queryable().query('UPDATE ubeeq_accounts SET account_scope = $1, roles_json = $2 WHERE id = $3', ['customer_account', '[]', account.id]);
      assert.equal((await identity.getAuthorizationSubject(account.id)).accountScope, 'customer_account');
      throw new Error('rollback authority');
    }), /rollback authority/);
    assert.equal((await identity.getAuthorizationSubject(account.id)).accountScope, 'creator_operator');
    competitor = await database.pool.connect();
    await competitor.query("SET lock_timeout = '100ms'");
    await database.transaction(async () => {
      assert.deepEqual((await identity.getAuthorizationSubject(account.id)).roles, ['creator']);
      await assert.rejects(competitor.query('UPDATE ubeeq_accounts SET account_scope = $1 WHERE id = $2', ['customer_account', account.id]), error => error.code === '55P03');
    });
    await competitor.query('UPDATE ubeeq_accounts SET account_scope = $1, roles_json = $2, scopes_json = $3 WHERE id = $4', ['customer_account', '["customer_account"]', '[]', account.id]);
    assert.deepEqual((await identity.verifySession({ credential: login.token })).subject, { id: account.id, email: credentials.email, accountScope: 'customer_account', roles: ['customer_account'], scopes: [] });
    await competitor.query('UPDATE ubeeq_accounts SET status = $1 WHERE id = $2', ['suspended', account.id]);
    assert.equal(await identity.getAuthorizationSubject(account.id), undefined);
    assert.equal(await identity.verifySession({ credential: login.token }), undefined);
    await assert.rejects(identity.authenticate(credentials), /Invalid local credentials/);
  } finally {
    competitor?.release();
    try { if (account) await database.pool.query('DELETE FROM ubeeq_accounts WHERE id = $1', [account.id]); }
    finally { await database.close(); }
  }
});

test("S3-compatible object storage satisfies the shared storage and cell-boundary contracts", async () => {
  const values = new Map();
  const client = { send: async (command) => {
    const input = command.input;
    if (command.constructor.name === "PutObjectCommand") { values.set(input.Key, input); return {}; }
    if (command.constructor.name === "GetObjectCommand") { const value = values.get(input.Key); if (!value) throw new Error("NoSuchKey"); return { VersionId: "v1", ContentType: value.ContentType, Metadata: value.Metadata, Body: { transformToByteArray: async () => value.Body } }; }
    if (command.constructor.name === "DeleteObjectCommand") { values.delete(input.Key); return {}; }
    throw new Error(`Unexpected command ${command.constructor.name}`);
  } };
  const storage = new S3CompatibleStorage({ endpoint: "http://minio.invalid", bucket: "objects" }, client);
  await verifyObjectStorageContract(storage);
  const scoped = new S3CompatibleStorage({ endpoint: "http://minio.invalid", bucket: "objects", cellId: "cell-a" }, client);
  await assert.rejects(() => scoped.put({ object: { bucket: "objects", key: "cells/cell-b/creators/creator-b/originals/file", contentType: "image/png", byteLength: 1, scope: "private" }, body: Buffer.from("x") }), /cell-a/);
});

test('PostgreSQL physical absence guards block late raw inserts without blocking unrelated keys', {skip:!connectionString},async()=>{
  const database=new PostgresDatabase({connectionString,cellId:'cell-a',applicationName:'ubeeq-absence-contract'});
  await database.migrate();
  const repositories=createPostgresRepositories(database),prefix='absence-'+randomUUID(),ids=[prefix+'-guarded',prefix+'-unrelated',prefix+'-accepted',prefix+'-rejected'];
  const record=id=>({id,instanceId:'instance',homeCellId:'cell-a',dataHomeRegion:'local',dataHomeAssignedAt:'2026-01-01',routingRevision:1,namespace:'authority',scopeId:'users',key:id,value:{active:false}});
  const insert=async(client,id)=>{
    const at='2026-01-01T00:00:00.000Z',value={...record(id),revision:1,createdAt:at,updatedAt:at};
    return client.query('INSERT INTO ubeeq_records(repository,id,revision,payload,created_at,updated_at) VALUES($1,$2,1,$3::jsonb,$4,$4)',['hostRecords',id,JSON.stringify(value),at]);
  };
  const competitor=await database.pool.connect();
  try{
    await competitor.query("SET lock_timeout = '100ms'");
    await database.transaction(async transaction=>{
      await repositories.hostRecords.checkAbsent(ids[0],{transaction});
      await repositories.hostRecords.checkAbsent(ids[0],{transaction});
      // A different key in the SAME repository can commit while this guard holds.
      await insert(competitor,ids[1]);
      await assert.rejects(insert(competitor,ids[0]),error=>error.code==='55P03');
      await repositories.hostRecords.create(record(ids[2]),{transaction});
    });
    assert.ok(await repositories.hostRecords.get(ids[2]));
    await insert(competitor,ids[0]);
    await assert.rejects(database.transaction(async transaction=>{
      await repositories.hostRecords.create(record(ids[3]),{transaction});
      await repositories.hostRecords.checkAbsent(ids[0],{transaction});
    }),error=>error.name==='OptimisticConcurrencyError'&&error.expectedRevision===0);
    assert.equal(await repositories.hostRecords.get(ids[3]),undefined);
  }finally{
    competitor.release();
    try{await database.pool.query('DELETE FROM ubeeq_records WHERE repository = $1 AND id = ANY($2::text[])',['hostRecords',ids]);}
    finally{await database.close();}
  }
});

test('PostgreSQL absence guard contradictions and write conflicts poison caught transactions; missing protocol fails closed',{skip:!connectionString},async()=>{
  const database=new PostgresDatabase({connectionString,cellId:'cell-a',applicationName:'ubeeq-absence-conflicts'});
  await database.migrate();
  const repositories=createPostgresRepositories(database),prefix='guard-conflict-'+randomUUID(),record=id=>({id,instanceId:'instance',homeCellId:'cell-a',dataHomeRegion:'local',dataHomeAssignedAt:'2026-01-01',routingRevision:1,namespace:'authority',scopeId:'users',key:id,value:{}}),ids=[];
  try{
    for(const order of ['guard-write','write-guard','contradiction']){
      const id=prefix+'-'+order,companion=id+'-companion';ids.push(id,companion);
      await assert.rejects(database.transaction(async transaction=>{
        await repositories.hostRecords.create(record(companion),{transaction});
        if(order==='write-guard'){
          await repositories.hostRecords.create(record(id),{transaction});
          await assert.rejects(repositories.hostRecords.checkAbsent(id,{transaction}),/guard or write/);
        }else{
          await repositories.hostRecords.checkAbsent(id,{transaction});
          if(order==='guard-write')await assert.rejects(repositories.hostRecords.create(record(id),{transaction}),/guarded item/);
          else await assert.rejects(repositories.hostRecords.repository.checkRevision(id,1,{transaction}),{name:'OptimisticConcurrencyError'});
        }
      }),/aborted/);
      assert.equal(await repositories.hostRecords.get(companion),undefined);assert.equal(await repositories.hostRecords.get(id),undefined);
    }
    await assert.rejects(database.transaction(async transaction=>{
      await database.queryable(transaction).query('ALTER TABLE ubeeq_records DISABLE TRIGGER ubeeq_record_key_lock');
      await repositories.hostRecords.checkAbsent(prefix+'-unsupported',{transaction});
    }),/writer-lock migration/);
    await database.transaction(transaction=>repositories.hostRecords.checkAbsent(prefix+'-supported',{transaction}));
    let ended;await database.transaction(async transaction=>{ended=transaction;});
    await assert.rejects(repositories.hostRecords.checkAbsent(prefix+'-expired',{transaction:ended}),/unknown transaction/);
  }finally{
    try{await database.pool.query('DELETE FROM ubeeq_records WHERE repository = $1 AND id = ANY($2::text[])',['hostRecords',ids]);}
    finally{await database.close();}
  }
});
