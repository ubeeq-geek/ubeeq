import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createLocalAdapterSet } from '@ubeeq/adapter-local';
import { createReferenceApi } from '../dist/server.js';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t, render) {
  const directory = await mkdtemp(join(tmpdir(), 'slideshow-api-'));
  const adapters = createLocalAdapterSet({ databasePath: join(directory, 'state.sqlite'), dataDirectory: directory, cellId: 'cell-a', publicBaseUrl: 'http://localhost' });
  Object.assign(adapters, { delivery: adapters.storage, uploads: adapters.storage, localIdentity: adapters.identity });
  const calls = [], body = new Uint8Array([0, 0, 0, 20, 102, 116, 121, 112]);
  const configuration = { adapters, publicBaseUrl: 'http://localhost', cellId: 'cell-a', slideshowRenderer: { render: async input => { calls.push(input); if (render) await render(input); return { body, contentType: 'video/mp4', durationSeconds: 7.5, width: 1920, height: 1080 }; } } };
  const api = createReferenceApi(configuration);
  await new Promise(resolve => api.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${api.server.address().port}`;
  let credential;
  const request = async (path, method = 'GET', data, token = credential) => {
    const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: data === undefined ? undefined : JSON.stringify(data) });
    const value = response.headers.get('content-type')?.startsWith('video/') ? new Uint8Array(await response.arrayBuffer()) : await response.json();
    return { status: response.status, value, headers: response.headers };
  };
  const account = async name => {
    const details = { email: `${name}@example.test`, password: 'a-safe-local-password' };
    await request('/v1/auth/sign-up', 'POST', details, '');
    const login = await request('/v1/auth/sign-in', 'POST', details, '');
    const token = login.value.token;
    const result = await request('/v1/creators', 'POST', { handle: name, displayName: name }, token);
    return { creator: result.value.creator, token };
  };
  const owner = await account('owner'); credential = owner.token;
  const { creator } = owner;
  const home = { homeCellId: creator.homeCellId, dataHomeRegion: creator.dataHomeRegion, dataHomeAssignedAt: creator.dataHomeAssignedAt, routingRevision: creator.routingRevision, instanceId: creator.instanceId };
  const assets = [], works = [];
  for (let index = 0; index < 3; index++) {
    const work = await adapters.repositories.works.create({ ...home, id: 'work-' + index, creatorId: creator.id, title: 'Image ' + index, status: 'ready' }); works.push(work);
    const bytes = new Uint8Array([index, 2, 3]), checksum = digest(bytes), key = `cells/cell-a/creators/${creator.id}/originals/image-${index}`;
    const storage = { bucket: 'cell-a', key, versionId: 'source-v1', contentType: index === 2 ? 'audio/wav' : 'image/png', byteLength: bytes.length, checksum, scope: 'private' };
    await adapters.storage.put({ object: storage, body: bytes });
    assets.push(await adapters.repositories.assets.create({ ...home, id: 'image-' + index, creatorId: creator.id, workId: work.id, mimeType: storage.contentType, objectVersion: storage.versionId, checksum, status: 'ready', storage }));
  }
  const created = await request('/v1/collections', 'POST', { title: 'My images' });
  const collection = created.value.collection;
  const order = await request(`/v1/collections/${collection.id}/works`, 'PUT', { expectedRevision: collection.revision, workIds: [works[1].id, works[0].id] });
  assert.equal(order.status, 200, JSON.stringify(order.value));
  const path = `/v1/collections/${collection.id}/slideshows`;
  t.after(async () => { await api.close(); adapters.database.database.close(); await rm(directory, { recursive: true, force: true }); });
  return { request, account, api, configuration, adapters, assets, works, creator, collection: order.value.collection, path, calls, body };
}

test('slideshow generation is explicit, idempotent, ordered, durable and privately downloadable', async t => {
  const f = await fixture(t);
  assert.equal((await f.request(f.path)).value.renditions.length, 0);
  assert.equal((await f.adapters.jobs.list({ cellId: 'cell-a', limit: 100 })).length, 0);
  const requested = await f.request(f.path, 'POST', { requestId: 'render-one' });
  assert.equal(requested.status, 202, JSON.stringify(requested.value));
  const id = requested.value.rendition.id, content = `${f.path}/${id}/content`;
  assert.equal(requested.value.rendition.state, 'queued');
  assert.equal((await f.request(content)).status, 409);
  assert.equal((await f.request(f.path, 'POST', { requestId: 'render-one' })).value.rendition.id, id);
  assert.equal((await f.adapters.jobs.list({ cellId: 'cell-a', limit: 100 })).length, 1);
  assert.equal((await f.request(f.path, 'POST', { requestId: 'render-one', settings: { slideDurationSeconds: 5 } })).status, 409);
  // Another process sees the same durable queue and rendition records.
  const worker = createReferenceApi(f.configuration);
  const result = await worker.runNextJob('second-process');
  assert.equal(result.rendition.state, 'completed');
  assert.deepEqual(f.calls[0].slides.map(s => [...s.source]), [[1, 2, 3], [0, 2, 3]]);
  assert.deepEqual(f.calls[0].settings.music, []);
  const downloaded = await f.request(content);
  assert.equal(downloaded.status, 200); assert.deepEqual(downloaded.value, f.body);
  assert.equal(downloaded.headers.get('cache-control'), 'private, no-store');
  assert.match(downloaded.headers.get('content-disposition'), /attachment.*\.mp4/);
  const stored = await f.adapters.repositories.assets.get(id);
  assert.equal(stored.storage.scope, 'private'); assert.equal(stored.workId, undefined);
  const second = await f.account('second');
  assert.equal((await f.request(content, 'GET', undefined, second.token)).status, 404);
  assert.equal((await f.request(content, 'GET', undefined, '')).status, 401);
  const original = f.assets[0];
  await f.adapters.repositories.assets.update(original.id, original.revision, { status: 'deleted' });
  const stale = await f.request(`${f.path}/${id}`);
  assert.equal(stale.value.rendition.stale, true); assert.equal(stale.value.rendition.downloadPath, undefined);
  assert.equal((await f.request(content)).status, 409);
});

test('music requires permission and owned audio, preserving playlist trims and loop settings', async t => {
  const f = await fixture(t);
  const settings = { music: [{ assetId: f.assets[2].id, startSeconds: 1, endSeconds: 2 }, { assetId: f.assets[2].id, startSeconds: 2, endSeconds: 3 }], loopMusic: false };
  assert.equal((await f.request(f.path, 'POST', { requestId: 'music', settings })).status, 400);
  assert.equal((await f.request(f.path, 'POST', { requestId: 'wrong', settings: { music: [{ assetId: f.assets[0].id }] }, musicRightsConfirmed: true })).status, 400);
  const result = await f.request(f.path, 'POST', { requestId: 'music', settings, musicRightsConfirmed: true });
  assert.equal(result.status, 202);
  await f.api.runNextJob('music-worker');
  assert.deepEqual(f.calls[0].settings.music, settings.music); assert.equal(f.calls[0].settings.loopMusic, false);
  assert.equal(f.calls[0].music.length, 2);
});

test('changes during rendering prevent completion and require regeneration', async t => {
  let f;
  f = await fixture(t, async () => {
    const current = await f.adapters.repositories.works.get(f.works[0].id);
    await f.adapters.repositories.works.update(current.id, current.revision, { title: 'Edited while rendering' });
  });
  const result = await f.request(f.path, 'POST', { requestId: 'changed' });
  await assert.rejects(f.api.runNextJob('worker'), /changed/);
  const rendition = (await f.request(`${f.path}/${result.value.rendition.id}`)).value.rendition;
  assert.equal(rendition.state, 'dead_lettered'); assert.equal(rendition.stale, true);
  assert.equal((await f.request(`${f.path}/${rendition.id}/content`)).status, 409);
});

test('worker repairs interrupted enqueue and retries renderer failures without publishing partial output', async t => {
  let attempts = 0;
  const f = await fixture(t, async () => { if (++attempts === 1) throw new Error('native encoder failed'); });
  const enqueue = f.adapters.jobs.enqueue.bind(f.adapters.jobs);
  f.adapters.jobs.enqueue = async () => { throw new Error('queue unavailable'); };
  assert.equal((await f.request(f.path, 'POST', { requestId: 'outbox' })).status, 500);
  f.adapters.jobs.enqueue = enqueue;
  await assert.rejects(f.api.runNextJob('repair-worker'), /encoder failed/);
  const queued = (await f.request(f.path)).value.renditions[0];
  assert.equal(queued.state, 'retry_scheduled'); assert.equal(queued.downloadPath, undefined);
  const jobs = await f.adapters.jobs.list({ cellId: 'cell-a', limit: 100 });
  await f.adapters.jobs.recover({ id: jobs[0].id });
  const result = await f.api.runNextJob('recovered-worker');
  assert.equal(result.rendition.state, 'completed'); assert.equal(attempts, 2);
});

test('active holds and source integrity failures block rendering and download', async t => {
  const f = await fixture(t);
  const requested = await f.request(f.path, 'POST', { requestId: 'hold' });
  await f.api.runNextJob('worker');
  const source = f.assets[0];
  const hold = await f.adapters.repositories.moderationHolds.create({ id: 'hold', instanceId: f.creator.instanceId, homeCellId: 'cell-a', dataHomeRegion: f.creator.dataHomeRegion, dataHomeAssignedAt: f.creator.dataHomeAssignedAt, routingRevision: 1, subjectType: 'asset', subjectId: source.id, state: 'active', reason: 'review' });
  assert.equal((await f.request(`${f.path}/${requested.value.rendition.id}/content`)).status, 409);
  assert.equal((await f.request(f.path, 'POST', { requestId: 'held' })).status, 409);
  await f.adapters.repositories.moderationHolds.update(hold.id, hold.revision, { state: 'released' });
  const next = await f.request(f.path, 'POST', { requestId: 'corrupt' });
  // Simulate a compromised object-store implementation returning bytes under the correct metadata.
  const get = f.adapters.storage.get.bind(f.adapters.storage);
  f.adapters.storage.get = async location => { const result = await get(location); return location.key === source.storage.key ? { ...result, body: new Uint8Array([9, 9, 9]) } : result; };
  await assert.rejects(f.api.runNextJob('worker'), /integrity/);
  assert.equal((await f.request(`${f.path}/${next.value.rendition.id}/content`)).status, 409);
});

test('metadata imports retain slideshow lineage without reactivating its outbox or job', async t => {
  const f = await fixture(t);
  const requested = await f.request(f.path, 'POST', { requestId: 'portable' });
  const exported = await f.request('/v1/exports/me');
  assert.equal(exported.status, 200, JSON.stringify(exported.value));
  const directory = await mkdtemp(join(tmpdir(), 'slideshow-import-'));
  const adapters = createLocalAdapterSet({ databasePath: join(directory, 'state.sqlite'), dataDirectory: directory, cellId: 'cell-a', publicBaseUrl: 'http://localhost' });
  Object.assign(adapters, { delivery: adapters.storage, uploads: adapters.storage, localIdentity: adapters.identity });
  const importer = createReferenceApi({ adapters, cellId: 'cell-a', publicBaseUrl: 'http://localhost', slideshowRenderer: f.configuration.slideshowRenderer });
  await new Promise(resolve => importer.server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + importer.server.address().port;
  try {
    let token;
    const post = async (path, body) => {
      const response = await fetch(base + '/v1/' + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) });
      const value = await response.json(); assert.ok(response.ok, JSON.stringify(value)); return value;
    };
    const account = { email: 'importer@example.test', password: 'a-safe-local-password' };
    await post('auth/sign-up', account); token = (await post('auth/sign-in', account)).token;
    await post('creators', { handle: 'importer', displayName: 'Importer' });
    const result = await post('imports', { manifest: exported.value, dryRun: false });
    assert.equal(result.checkpoint.state, 'completed');
    const asset = await adapters.repositories.assets.get(requested.value.rendition.id);
    assert.ok(asset.slideshow); assert.equal(asset.slideshowPending, undefined); assert.equal(asset.slideshowJobId, undefined); assert.equal(asset.storage, undefined);
    assert.equal(await importer.runNextJob('import-worker'), undefined);
    assert.equal((await adapters.jobs.list({ cellId: 'cell-a', limit: 100 })).length, 0);
  } finally { await importer.close(); adapters.database.database.close(); await rm(directory, { recursive: true, force: true }); }
});
