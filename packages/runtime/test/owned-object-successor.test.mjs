// AUTHORED UNRUN. Actual Local SQLite upload custody and immutable filesystem
// versions. The strict quota protocol below is the neutral SDK port fixture;
// it does not claim product billing, Source authority, or provider acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {createLocalAdapterSet} from '@ubeeq/adapter-local';
import {OwnedObjectWrites} from '../dist/owned-object-writes.js';

const home = {homeCellId:'cell', dataHomeRegion:'local', dataHomeAssignedAt:'2026-01-01T00:00:00.000Z', routingRevision:1};
const digest = value => createHash('sha256').update(value).digest('hex');
const deferred = () => {let resolve; return {promise:new Promise(done => {resolve = done;}), resolve};};
const identity = input => ({creatorId:input.creatorId, operation:input.operation, idempotencyKey:input.idempotencyKey});
const beforeOutcome = (entered, observed, message) => Promise.race([entered.promise, observed.then(value => {throw value.error ?? Error(message);})]);

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'owned-completed-successor-'));
  const connections = [], releases = [], pending = new Set();
  const reservations = new Map(), settlements = new Map(), closures = new Map();
  const calls = {reserve:0, settlement:0, closure:0, initiate:0, accept:0, accepted:0, complete:0, seal:0};
  let policyAllowed = true;
  const quota = {
    async checkAndReserveQuota(input) {
      calls.reserve++;
      if (closures.has(input.idempotencyKey)) return {allowed:false, reasonCode:'RESERVATION_CLOSED'};
      if (settlements.has(input.idempotencyKey)) return {allowed:false, reasonCode:'RESERVATION_SETTLED'};
      const previous = reservations.get(input.idempotencyKey);
      if (previous) assert.deepEqual(previous, input);
      else reservations.set(input.idempotencyKey, structuredClone(input));
      return {allowed:true};
    },
    async checkCurrentAdmission(input) {
      return {allowed:policyAllowed && reservations.has(input.idempotencyKey) && !settlements.has(input.idempotencyKey) && !closures.has(input.idempotencyKey)};
    },
    async checkCurrentPolicy() {return {allowed:policyAllowed, ...(policyAllowed ? {} : {reasonCode:'CURRENT_POLICY_DENIED'})};},
    async recordUsageSettlement(input) {
      calls.settlement++;
      const reservation = reservations.get(input.idempotencyKey);
      assert.ok(reservation);
      assert.equal(closures.has(input.idempotencyKey), false);
      assert.equal(input.creatorId, reservation.creatorId);
      assert.equal(input.operation, reservation.operation);
      assert.equal(input.storageBytesDelta, reservation.storageBytesDelta);
      const previous = settlements.get(input.idempotencyKey);
      if (previous) assert.deepEqual(previous, input);
      else settlements.set(input.idempotencyKey, structuredClone(input));
    },
    async closeStorageReservation(input) {
      calls.closure++;
      const reservation = reservations.get(input.idempotencyKey);
      assert.ok(reservation);
      assert.equal(settlements.has(input.idempotencyKey), false);
      assert.equal(input.creatorId, reservation.creatorId);
      assert.equal(input.operation, reservation.operation);
      assert.equal(input.reservedBytes, reservation.storageBytesDelta);
      assert.ok(input.proofId);
      const previous = closures.get(input.idempotencyKey);
      if (previous) assert.deepEqual(previous, input);
      else closures.set(input.idempotencyKey, structuredClone(input));
    }
  };
  const open = () => {
    const local = createLocalAdapterSet({databasePath:join(directory, 'data.sqlite'), dataDirectory:directory, cellId:'cell', publicBaseUrl:'http://127.0.0.1'});
    connections.push(local);
    for (const method of ['initiate', 'accept', 'complete', 'seal']) {
      const original = local.storage[method].bind(local.storage);
      local.storage[method] = async input => {
        calls[method]++;
        const result = await original(input);
        if (method === 'accept') calls.accepted++;
        return result;
      };
    }
    return {local, writer:new OwnedObjectWrites(local.repositories, local.storage, quota, 'instance', 'cell')};
  };
  const first = open();
  const credentials = {email:'successor-owner@unit.test', password:'Actual successor lifecycle password123!'};
  const owner = await first.local.identity.register(credentials), signed = await first.local.identity.authenticate(credentials);
  const creator = await first.local.repositories.creators.create({id:'creator', instanceId:'instance', ...home, subjectId:owner.subjectId, displayName:'Actual successor owner', handle:'actual-successor-owner'});
  const lifetime = new AbortController();
  const hooks = {
    async beforeNewPhysicalWrite() {
      const session = await first.local.identity.verifySession({credential:signed.token});
      const current = await first.local.repositories.creators.get(creator.id);
      if (!session || session.subject.id !== owner.subjectId || current?.subjectId !== owner.subjectId) throw Error('The actual current owner/session restriction denied.');
    },
    assertNewPhysicalWriteActive() {if (lifetime.signal.aborted) throw Error('The original actual write lifetime ended.');}
  };
  const input = {creatorId:creator.id, operation:'asset.rendition', idempotencyKey:'actual-original-version', home, bucket:'cell', kind:'renditions', scope:'private', contentType:'text/plain', body:Buffer.from('actual immutable successor bytes'), metadata:{source:{id:'actual-source', version:'immutable-original'}, opaque:{retained:['完整', {future:true, zero:0, absent:null}]}}};
  const gate = () => {const value = deferred(); releases.push(value.resolve); return value;};
  const track = value => {
    const observed = value.then(result => ({result}), error => ({error}));
    pending.add(observed); void observed.then(() => pending.delete(observed)); return observed;
  };
  const rows = async () => (await first.local.repositories.hostRecords.list({limit:100})).items;
  t.after(async () => {
    for (const release of releases) release();
    await Promise.allSettled([...pending]);
    for (const local of connections.splice(0).reverse()) local.database.close();
    await rm(directory, {recursive:true, force:true});
  });
  return {directory, first, input, hooks, lifetime, quota, calls, reservations, settlements, closures, open, gate, track, rows, policy(value) {policyAllowed = value;},
    async reopen() {
      assert.equal(pending.size, 0);
      for (const local of connections.splice(0).reverse()) local.database.close();
      return open();
    }
  };
}

// The first real adapter body is suspended before it consumes any bytes. A
// separate real writer seals that exact generation and can complete its next
// generation; releasing the original invokes the actual now-missing session.
async function race(t, {restricted = false} = {}) {
  const f = await fixture(t), entered = f.gate(), release = f.gate();
  const accept = f.first.local.storage.accept.bind(f.first.local.storage);
  let held = false, originalInput, providerError;
  f.first.local.storage.accept = async input => {
    if (!held) {held = true; originalInput = {...input, body:Uint8Array.from(input.body)}; entered.resolve(); await release.promise;}
    try {return await accept(input);} catch (error) {if (input.uploadId === originalInput.uploadId) providerError = error; throw error;}
  };
  const actualInput = {...f.input, ...(restricted ? f.hooks : {})};
  const stale = f.track(f.first.writer.write(actualInput));
  await beforeOutcome(entered, stale, 'The actual original body did not enter its adapter gate.');
  const second = f.open();
  assert.equal(await second.writer.recover(identity(f.input)), undefined);
  const old = (await f.rows()).find(row => row.namespace === 'runtime-owned-object');
  assert.equal(old.value.phase, 'sealed');
  assert.equal(old.value.provider.uploadId, originalInput.uploadId);
  assert.ok(old.value.seal.proofId);
  assert.ok(f.first.local.database.database.prepare('SELECT id FROM ubeeq_upload_seals WHERE id=?').get(originalInput.uploadId));
  assert.equal(f.first.local.database.database.prepare('SELECT id FROM ubeeq_uploads WHERE id=?').get(originalInput.uploadId), undefined);
  return {f, second, old, actualInput, stale, release:release.resolve, error:() => providerError, originalInput};
}

const financial = f => ({calls:structuredClone(f.calls), reservations:structuredClone([...f.reservations]), settlements:structuredClone([...f.settlements]), closures:structuredClone([...f.closures])});
const assertPhysical = async (f, output) => {
  const read = await f.first.local.storage.get(output.object);
  assert.deepEqual(read.body, f.input.body);
  assert.equal(output.object.checksum, digest(f.input.body));
  assert.deepEqual(output.metadata, f.input.metadata);
  assert.equal(f.settlements.size, 1);
  assert.equal(f.closures.size, 1);
  assert.equal(f.reservations.size, 2);
};
const assertNoEffects = async (f, before, money) => {
  assert.deepEqual(await f.rows(), before);
  // Releasing the old call invokes its real, already-sealed body once and fails;
  // the fallback itself may perform physical verification, never new effects.
  assert.deepEqual(financial(f), {...money, calls:{...money.calls, accept:money.calls.accept + 1}});
};

test('an actual sealed old writer returns only the independently completed exact successor, without another reserve/body/charge, and reopens unchanged', {timeout:15_000}, async t => {
  const r = await race(t), {f} = r, output = await r.second.writer.write(r.actualInput);
  await assertPhysical(f, output);
  const before = await f.rows(), money = financial(f), generations = before.filter(row => row.namespace === 'runtime-owned-object').sort((a,b) => a.value.generation - b.value.generation);
  assert.deepEqual(generations.map(row => row.value.phase), ['sealed', 'completed']);
  assert.equal(generations[1].value.previousProof, generations[0].value.seal.proofId);
  r.release(); const stale = await r.stale;
  assert.equal(stale.error, undefined); assert.deepEqual(stale.result, output);
  assert.match(String(r.error()), /Upload scope does not match the authenticated creator and cell/);
  await assertNoEffects(f, before, money);
  const reopened = await f.reopen(), after = financial(f);
  assert.deepEqual(await reopened.writer.write(f.input), output);
  assert.deepEqual((await reopened.local.repositories.hostRecords.list({limit:100})).items, before);
  assert.deepEqual(financial(f), after);
});

test('a real still-pending successor cannot be waited on, completed, resent, or reported as a completed output', {timeout:15_000}, async t => {
  const r = await race(t), {f} = r, entered = f.gate(), release = f.gate(), accept = r.second.local.storage.accept.bind(r.second.local.storage);
  r.second.local.storage.accept = async input => {entered.resolve(); await release.promise; return accept(input);};
  const next = f.track(r.second.writer.write(r.actualInput)); await beforeOutcome(entered, next, 'The actual replacement body did not enter its adapter gate.');
  const before = await f.rows(), money = financial(f);
  r.release(); const stale = await r.stale;
  assert.equal(stale.result, undefined); assert.ok(stale.error); assert.equal(stale.error, r.error());
  assert.equal(f.settlements.size, 0);
  await assertNoEffects(f, before, money);
  release.resolve(); const completed = await next; assert.equal(completed.error, undefined); await assertPhysical(f, completed.result);
});

test('actual different request bytes/opaque metadata and foreign cell remain denied, while the exact successor remains immutable', {timeout:15_000}, async t => {
  const r = await race(t), {f} = r, output = await r.second.writer.write(r.actualInput), before = await f.rows(), money = financial(f);
  await assert.rejects(r.second.writer.write({...f.input, body:Buffer.from('a genuinely different request')}), /identity conflicts/);
  await assert.rejects(r.second.writer.write({...f.input, metadata:{...f.input.metadata, opaque:{retained:['changed']}}}), /identity conflicts/);
  await assert.rejects(r.second.writer.write({...f.input, home:{...home, homeCellId:'foreign'}}), /Invalid owned output/);
  assert.deepEqual(await f.rows(), before); assert.deepEqual(financial(f), money);
  r.release(); const stale = await r.stale; assert.equal(stale.error, undefined); assert.deepEqual(stale.result, output); await assertNoEffects(f, before, money);
});

test('a genuinely completed successor with a corrupted predecessor proof cannot lend its physical receipt to the old writer', {timeout:15_000}, async t => {
  const r = await race(t), {f} = r; await r.second.writer.write(r.actualInput);
  const next = (await f.rows()).find(row => row.namespace === 'runtime-owned-object' && row.value.generation === 1);
  // Deliberate negative corruption of an actual produced row, never a producer.
  await r.second.local.repositories.hostRecords.update(next.id, next.revision, {value:{...next.value, previousProof:'not-the-real-seal'}});
  const before = await f.rows(), money = financial(f);
  r.release(); const stale = await r.stale; assert.equal(stale.result, undefined); assert.ok(stale.error); await assertNoEffects(f, before, money);
});

for (const mode of ['missing', 'corrupt']) test(`a ${mode} real successor payload cannot turn its completed journal into fabricated physical success`, {timeout:15_000}, async t => {
  const r = await race(t), {f} = r, output = await r.second.writer.write(r.actualInput);
  const path = join(f.directory, 'objects', output.object.bucket, output.object.key, output.object.versionId);
  if (mode === 'missing') await rm(path);
  else {const bytes = await readFile(path); bytes[0] ^= 0xff; await writeFile(path, bytes);}
  const before = await f.rows(), money = financial(f);
  r.release(); const stale = await r.stale; assert.equal(stale.result, undefined); assert.ok(stale.error); await assertNoEffects(f, before, money);
});

for (const mode of ['denied', 'absent']) test(`actual current policy ${mode} does not authorize completed-successor recovery or replace the old failure`, {timeout:15_000}, async t => {
  const r = await race(t), {f} = r; await r.second.writer.write(r.actualInput);
  if (mode === 'denied') f.policy(false); else delete f.quota.checkCurrentPolicy;
  const before = await f.rows(), money = financial(f);
  r.release(); const stale = await r.stale; assert.equal(stale.result, undefined); assert.ok(stale.error); await assertNoEffects(f, before, money);
});

test('current policy revoked during real successor receipt verification denies after IO without another financial or physical effect', {timeout:15_000}, async t => {
  const r = await race(t), {f} = r; await r.second.writer.write(r.actualInput);
  const next = (await f.rows()).find(row => row.namespace === 'runtime-owned-object' && row.value.generation === 1), entered = f.gate(), release = f.gate();
  const recover = f.first.local.storage.recoverCompletion.bind(f.first.local.storage);
  f.first.local.storage.recoverCompletion = async input => {
    const actual = await recover(input);
    if (input.uploadId === next.value.provider.uploadId) {assert.deepEqual(actual, next.value.completedObject); entered.resolve(); await release.promise;}
    return actual;
  };
  const before = await f.rows(), money = financial(f);
  r.release(); await beforeOutcome(entered, r.stale, 'The actual successor receipt did not enter its verification gate.'); f.policy(false); release.resolve();
  const stale = await r.stale; assert.equal(stale.result, undefined); assert.ok(stale.error); await assertNoEffects(f, before, money);
});

test('a paired write lifetime ending during actual successor receipt IO denies the fallback without changing accepted history', {timeout:15_000}, async t => {
  const r = await race(t, {restricted:true}), {f} = r; await r.second.writer.write(r.actualInput);
  const next = (await f.rows()).find(row => row.namespace === 'runtime-owned-object' && row.value.generation === 1), entered = f.gate(), release = f.gate();
  const recover = f.first.local.storage.recoverCompletion.bind(f.first.local.storage);
  f.first.local.storage.recoverCompletion = async input => {
    const actual = await recover(input);
    if (input.uploadId === next.value.provider.uploadId) {assert.deepEqual(actual, next.value.completedObject); entered.resolve(); await release.promise;}
    return actual;
  };
  const before = await f.rows(), money = financial(f);
  r.release(); await beforeOutcome(entered, r.stale, 'The actual successor receipt did not enter its verification gate.'); f.lifetime.abort(); release.resolve();
  const stale = await r.stale; assert.equal(stale.result, undefined); assert.ok(stale.error); await assertNoEffects(f, before, money);
});
