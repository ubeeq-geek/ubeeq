import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import server from '../src/server.cjs';
const { BrowserExtensionService, SqliteBrowserStore, features } = server;
const source = { provider: 'deviantart', accountId: 'artist' };
const row = (id = '100') => ({ remoteId: id, title: `Art ${id}`, sourceUrl: `https://www.deviantart.com/artist/art/Art-${id}` });
async function fixture(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'browser-test-'));
  let store = new SqliteBrowserStore(join(dir, 'state.sqlite'));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const config = { applicationCode: 'ES', browserExtensionAvailable: true }, content = new Map(); let allowed = true, time = Date.now(), copies = 0;
  const options = { store, deploymentId: 'deployment', policy: () => config, now: () => time, authorize: async () => allowed,
    existing: async (_pair, _source, item) => content.has(item.remoteId),
    importItem: async (_pair, _source, item, _identity, beforeCommit) => {
      await beforeCommit(); if (content.has(item.remoteId)) return { workId: content.get(item.remoteId), alreadyPresent: true };
      copies++; content.set(item.remoteId, `work-${item.remoteId}`); return { workId: `work-${item.remoteId}`, alreadyPresent: false };
    }, ...overrides };
  let service = new BrowserExtensionService(options);
  const approval = await service.grant('user', 'creator'); const pair = await service.exchange(approval.code, 'profile');
  return { get service() { return service; }, config, pair, approval, content, get copies() { return copies; },
    otherDeployment() { return new BrowserExtensionService({ ...options, deploymentId: 'other-deployment' }); },
    deny() { allowed = false; }, tick(ms) { time += ms; },
    restart() { store.close(); store = new SqliteBrowserStore(join(dir, 'state.sqlite')); options.store = store; service = new BrowserExtensionService(options); },
    async job(items = [row()]) { const preview = await service.preview(pair.token, { source, items }); return service.start(pair.token, { previewId: preview.previewId, selected: items.map(item => item.remoteId), requestId: crypto.randomUUID() }); },
    step: id => service.step(pair.token, id, source, 'profile') };
}
for (const applicationCode of ['UB', 'ES', 'NF', 'BP', 'UNKNOWN', undefined]) test(`policy fails closed: ${applicationCode}`, () => {
  assert.equal(features({ applicationCode }).browserExtensionAvailable, false);
  for (const browserExtensionAvailable of ['true', 1, 'TRUE', null, false])
    assert.equal(features({ applicationCode, browserExtensionAvailable }).browserExtensionAvailable, false);
  const f = features({ applicationCode, browserExtensionAvailable: true, deviantArtExtensionRichDescriptionEnabled: true });
  assert.equal(f.browserExtensionAvailable, ['UB', 'ES', 'NF', 'BP'].includes(applicationCode));
  assert.equal(f.deviantArtExtensionRichDescriptionReady, false);
});
test('approval is single use, scoped and expiring; bearer and website sessions are independent', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.exchange(f.approval.code, 'profile'), { code: 'approval_expired' });
  const grant = await f.service.grant('user', 'creator'); f.tick(300001);
  await assert.rejects(f.service.exchange(grant.code, 'profile'), { code: 'approval_expired' });
  assert.equal((await f.service.pairing(f.pair.token)).creatorId, 'creator');
  assert.doesNotMatch(JSON.stringify(f.pair), /cookie|csrf/);
});
test('resume after both service and SQLite restart; repeated source object is skipped', async t => {
  const f = await fixture(t), job = await f.job([row(), row('101')]);
  assert.equal((await f.step(job.id)).imported, 1); f.restart();
  const completed = await f.step(job.id); assert.equal(completed.state, 'completed'); assert.equal(completed.imported, 2);
  assert.equal((await f.step(job.id)).imported, 2); assert.equal(f.copies, 2);
  const repeated = await f.job(); assert.equal((await f.step(repeated.id)).alreadyPresent, 1); assert.equal(f.copies, 2);
});
test('filters fence the actual import selection and unknown dates do not match a date range', async t => {
  const f = await fixture(t), preview = await f.service.preview(f.pair.token, { source, items: [row(), row('101')] });
  const input = { previewId: preview.previewId, selected: ['100', '101'], filter: { name: '100' }, requestId: 'selection' };
  await assert.rejects(f.service.start(f.pair.token, input), { code: 'selection_outside_filter' });
  await assert.rejects(f.service.start(f.pair.token, { ...input, selected: ['100'], filter: { from: '2026-01-01' } }), { code: 'selection_outside_filter' });
  assert.equal((await f.service.start(f.pair.token, { ...input, selected: ['100'] })).total, 1);
});
test('duplicate job requests retain a single job, and changed intent conflicts', async t => {
  const f = await fixture(t), preview = await f.service.preview(f.pair.token, { source, items: [row(), row('101')] });
  const input = { previewId: preview.previewId, selected: ['100'], requestId: 'request' };
  const job = await f.service.start(f.pair.token, input);
  assert.equal((await f.service.start(f.pair.token, input)).id, job.id);
  await assert.rejects(f.service.start(f.pair.token, { ...input, selected: ['101'] }), { code: 'request_conflict' });
});
test('account or profile switch pauses durably and releases lease', async t => {
  const f = await fixture(t), job = await f.job();
  await assert.rejects(f.service.step(f.pair.token, job.id, { ...source, accountId: 'other' }, 'profile'), { code: 'account_changed' });
  f.restart(); assert.equal((await f.service.get(f.pair.token, job.id)).state, 'waiting_for_authorization'); assert.equal(f.copies, 0);
  await assert.rejects(f.service.step(f.pair.token, job.id, source, 'other-profile'), { code: 'account_changed' });
});
test('policy disablement and Creator permission changes block mutation; disconnect still works', async t => {
  const f = await fixture(t), job = await f.job(); f.config.browserExtensionAvailable = false;
  await assert.rejects(f.step(job.id), { code: 'extension_unavailable' }); assert.equal(f.copies, 0);
  await f.service.disconnect(f.pair.token); f.config.browserExtensionAvailable = true;
  await assert.rejects(f.step(job.id), { code: 'pairing_required' });
  const g = await fixture(t); const other = await g.job(); g.deny();
  await assert.rejects(g.step(other.id), { code: 'creator_access_required' }); assert.equal(g.copies, 0);
});
test('a concurrent cancellation fences a pending canonical commit', async t => {
  let release, started;
  const barrier = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { importItem: async (_p, _s, _i, _k, fence) => { started(); await gate; await fence(); throw new Error('commit must not occur'); } });
  const job = await f.job(), pending = f.step(job.id); await barrier;
  await f.service.control(f.pair.token, job.id, 'cancel'); release(); await assert.rejects(pending, { code: 'lease_expired' });
  assert.equal((await f.service.get(f.pair.token, job.id)).state, 'cancelled');
});
test('expired leases fence old results and restart retries incomplete work', async t => {
  let failFirst = true;
  const f = await fixture(t, { importItem: async (_p, _s, item, _k, fence) => {
    if (failFirst) { failFirst = false; f.tick(30001); } await fence(); return { workId: item.remoteId, alreadyPresent: false };
  } });
  const job = await f.job(); await assert.rejects(f.step(job.id), { code: 'lease_expired' });
  f.restart(); assert.equal((await f.step(job.id)).state, 'completed');
});
test('cancellation preserves completed Works and cannot be revived', async t => {
  const f = await fixture(t), job = await f.job([row(), row('101')]); await f.step(job.id);
  await f.service.control(f.pair.token, job.id, 'cancel'); f.restart();
  assert.equal((await f.step(job.id)).imported, 1); assert.equal(f.copies, 1);
  await assert.rejects(f.service.control(f.pair.token, job.id, 'retry'), { code: 'job_cancelled' });
});
test('untrusted results cannot supply arbitrary URLs, HTML, credentials or publishing commands', async t => {
  const f = await fixture(t);
  for (const sourceUrl of ['https://localhost/art/Art-100', 'https://www.deviantart.com.evil.test/artist/art/Art-100', 'https://user:pass@www.deviantart.com/artist/art/Art-100', 'https://www.deviantart.com/other/art/Art-100', 'https://www.deviantart.com/artist/art/Art-100?token=secret'])
    await assert.rejects(f.service.preview(f.pair.token, { source, items: [{ ...row(), sourceUrl }] }), { code: 'invalid_source_url' });
  const preview = await f.service.preview(f.pair.token, { source, items: [{ ...row(), cookie: 'secret', description: '<script>bad</script>', command: 'publish' }] });
  assert.doesNotMatch(JSON.stringify(preview), /secret|script|command/); assert.equal(preview.capabilities.browserPublish, false); assert.equal(preview.total, null);
});

test('a shared database cannot exchange another deployment approval or accept its bearer', async t => {
  const f = await fixture(t), other = f.otherDeployment();
  const approval = await f.service.grant('user', 'creator');
  await assert.rejects(other.exchange(approval.code, 'profile'), { code: 'approval_expired' });
  await assert.rejects(other.pairing(f.pair.token), { code: 'pairing_required' });
});
