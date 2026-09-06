import test from 'node:test';
import assert from 'node:assert/strict';
import { CreatorClient } from '../dist/index.js';
test('asset detachment sends an explicit revision and encoded Work and asset IDs', async () => {
  const calls = [];
  const client = new CreatorClient(async (url, options) => { calls.push({ url, options }); return Response.json({}); });
  await client.detachAsset('work/one', 'asset/two', 6);
  assert.equal(calls[0].url, '/api/studio/works/work%2Fone/assets/asset%2Ftwo');
  assert.equal(calls[0].options.method, 'DELETE');
  assert.deepEqual(JSON.parse(calls[0].options.body), { expectedRevision: 6 });
});
test('asset ordering sends the complete ordered IDs and revision with an encoded Work ID', async () => {
  const calls = [];
  const client = new CreatorClient(async (url, options) => { calls.push({ url, options }); return Response.json({}); });
  await client.setAssetOrder('work/one', ['b', 'a'], 4);
  assert.equal(calls[0].url, '/api/studio/works/work%2Fone/asset-order');
  assert.equal(calls[0].options.method, 'PUT');
  assert.deepEqual(JSON.parse(calls[0].options.body), { assetIds: ['b', 'a'], expectedRevision: 4 });
});
test('primary selection sends an authenticated revisioned request with an encoded Work ID', async () => {
  const calls = [];
  const client = new CreatorClient(async (url, options) => { calls.push({ url, options }); return Response.json(url.endsWith('sign-in') ? { token: 'session' } : {}); });
  await client.signIn('owner@example.test', 'password');
  await client.setPrimaryAsset('work/one', 'asset-two', 3);
  assert.equal(calls.at(-1).url, '/api/studio/works/work%2Fone/primary-asset');
  assert.equal(calls.at(-1).options.method, 'PUT');
  assert.equal(calls.at(-1).options.headers.authorization, 'Bearer session');
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), { assetId: 'asset-two', expectedRevision: 3 });
});
test('collection recovery uses opt-in listing and an explicit revisioned draft request', async () => {
  const calls = [];
  const client = new CreatorClient(async (url, options) => { calls.push({ url, options }); return Response.json({}); });
  await client.collections('creator/one');
  assert.equal(calls.at(-1).url, '/api/studio/collections?creatorId=creator%2Fone');
  await client.collections('creator/one', { includeDeleted: true });
  assert.equal(calls.at(-1).url, '/api/studio/collections?creatorId=creator%2Fone&includeDeleted=true');
  await client.restoreCollection('collection/one', 4);
  assert.equal(calls.at(-1).url, '/api/studio/collections/collection%2Fone');
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), { status: 'draft', expectedRevision: 4 });
});
test('removed-Work recovery opts into listing and restores only to a revisioned draft', async () => {
  const calls = [];
  const client = new CreatorClient(async (url, options) => { calls.push({ url, options }); return Response.json({}); });
  await client.works('creator/one', 'a & b');
  assert.equal(calls.at(-1).url, '/api/studio/works?creatorId=creator%2Fone&query=a%20%26%20b');
  await client.works('creator/one', 'a & b', { includeDeleted: true });
  assert.equal(calls.at(-1).url, '/api/studio/works?creatorId=creator%2Fone&query=a%20%26%20b&includeDeleted=true');
  await client.restoreWork('work/one', 8);
  assert.equal(calls.at(-1).url, '/api/studio/works/work%2Fone');
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), { expectedRevision: 8, status: 'draft' });
});
test('Work removal is an authenticated revisioned soft-delete with an encoded ID', async () => {
  const calls = [];
  const client = new CreatorClient(async (url, options) => { calls.push({ url, options }); return Response.json(url.endsWith('sign-in') ? { token: 'session' } : {}); });
  await client.signIn('owner@example.test', 'password');
  await client.deleteWork('id/space here', 7);
  assert.equal(calls.at(-1).url, '/api/studio/works/id%2Fspace%20here');
  assert.equal(calls.at(-1).options.method, 'PATCH');
  assert.equal(calls.at(-1).options.headers.authorization, 'Bearer session');
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), { expectedRevision: 7, status: 'deleted' });
});
test('Work metadata edits forward only an explicit slug and preserve legacy request bodies', async () => {
  const calls = [];
  const client = new CreatorClient(async (url, options) => { calls.push({ url, options }); return Response.json({}); });
  await client.updateWork('id/space here', 2, 'Title', 'Description');
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), { expectedRevision: 2, title: 'Title', description: 'Description' });
  await client.updateWork('id/space here', 3, 'Title', 'Description', ['tag'], { slug: 'new-slug', creatorId: 'forged', revision: 99, status: 'published' });
  assert.equal(calls.at(-1).url, '/api/studio/works/id%2Fspace%20here');
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), { expectedRevision: 3, title: 'Title', description: 'Description', tags: ['tag'], slug: 'new-slug' });
});
test('collection covers use revisioned writes and authenticated JPEG-only reads', async () => {
  const calls = [];
  let response = () => new Response(new Uint8Array([255, 216, 255]), { headers: { 'content-type': 'image/jpeg' } });
  const client = new CreatorClient(async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('sign-in')) return Response.json({ token: 'session' });
    return url.endsWith('/cover') ? response() : Response.json({});
  });
  await client.signIn('owner@example.test', 'password');
  await client.setCollectionCover('id/space here', 'asset', 3);
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), { coverAssetId: 'asset', expectedRevision: 3 });
  await client.setCollectionCover('id/space here', '', 4);
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), { coverAssetId: '', expectedRevision: 4 });
  assert.equal((await client.collectionCover('id/space here')).type, 'image/jpeg');
  assert.equal(calls.at(-1).url, '/api/studio/collections/id%2Fspace%20here/cover');
  assert.equal(calls.at(-1).options.headers.authorization, 'Bearer session');
  response = () => new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } });
  await assert.rejects(client.collectionCover('id'), /Unexpected/);
  response = () => new Response(null, { status: 401 });
  await assert.rejects(client.collectionCover('id'), /unavailable/);
  await assert.rejects(client.collectionCover('id'), /unavailable/);
  assert.equal(calls.at(-1).options.headers.authorization, undefined);
});
test('collection edits, lifecycle changes and deletion forward explicit revisions', async () => {
  const bodies = [];
  const client = new CreatorClient(async (_url, options) => { bodies.push(JSON.parse(options.body)); return Response.json({}); });
  await client.updateCollection('id', 'Title', { expectedRevision: 4 });
  await client.setCollectionArchived('id', true, 5);
  await client.deleteCollection('id', 6);
  assert.deepEqual(bodies, [{ title: 'Title', expectedRevision: 4 }, { status: 'archived', expectedRevision: 5 }, { expectedRevision: 6 }]);
});
test('collection archive and restore send only lifecycle state with authenticated encoded IDs', async () => {
  const calls = [];
  const client = new CreatorClient(async (url, options) => {
    calls.push({ url, options });
    return Response.json(url.endsWith('sign-in') ? { token: 'session' } : {});
  });
  await client.signIn('owner@example.test', 'password');
  for (const archived of [true, false]) {
    await client.setCollectionArchived('id/space here', archived);
    const { url, options } = calls.at(-1);
    assert.equal(url, '/api/studio/collections/id%2Fspace%20here');
    assert.equal(options.method, 'PATCH');
    assert.equal(options.headers.authorization, 'Bearer session');
    assert.deepEqual(JSON.parse(options.body), { status: archived ? 'archived' : 'draft' });
  }
});
test('collection metadata is optional, explicit and supports clearing descriptions', async () => {
  const bodies = [];
  const client = new CreatorClient(async (_url, options) => { bodies.push(JSON.parse(options.body)); return Response.json({}); });
  await client.createCollection('owner', 'Title');
  assert.deepEqual(bodies.at(-1), { creatorId: 'owner', title: 'Title' });
  await client.createCollection('owner', 'Playlist', { type: 'playlist', slug: 'list', description: 'Description', creatorId: 'forged', status: 'published' });
  assert.deepEqual(bodies.at(-1), { creatorId: 'owner', title: 'Playlist', type: 'playlist', slug: 'list', description: 'Description' });
  await client.updateCollection('id', 'Renamed');
  assert.deepEqual(bodies.at(-1), { title: 'Renamed' });
  await client.updateCollection('id', 'Renamed', { slug: 'renamed', description: '', status: 'published' });
  assert.deepEqual(bodies.at(-1), { title: 'Renamed', slug: 'renamed', description: '' });
  for (const type of ['collection', 'gallery', 'series', 'playlist']) {
    await client.updateCollection('id', 'Renamed', { type, expectedRevision: 4, creatorId: 'forged', visibility: 'public' });
    assert.deepEqual(bodies.at(-1), { title: 'Renamed', type, expectedRevision: 4 });
  }
});
test('collection removal encodes the ID, sends credentials and accepts an empty response', async () => {
  const calls = [];
  const client = new CreatorClient(async (url, options) => {
    calls.push({ url, options });
    return url.endsWith('sign-in') ? Response.json({ token: 'session' }) : new Response(null, { status: 204 });
  });
  await client.signIn('owner@example.test', 'password');
  await client.deleteCollection('collection/with space');
  assert.equal(calls.at(-1).url, '/api/studio/collections/collection%2Fwith%20space');
  assert.equal(calls.at(-1).options.method, 'DELETE');
  assert.equal(calls.at(-1).options.headers.authorization, 'Bearer session');
});
test('client clears expired credentials and failed sign-out credentials', async () => {
  const calls = [];
  const client = new CreatorClient(async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('sign-in')) return Response.json({ token: 'session' });
    if (url.endsWith('sign-out')) throw new Error('offline');
    return Response.json({ message: 'Authentication required' }, { status: 401 });
  });
  await client.signIn('local@example.test', 'password');
  await assert.rejects(client.creators(), /Authentication/);
  assert.equal(calls.at(-1).options.headers.authorization, 'Bearer session');
  await assert.rejects(client.creators(), /Authentication/);
  assert.equal(calls.at(-1).options.headers.authorization, undefined);
  await client.signIn('local@example.test', 'password');
  await assert.rejects(client.signOut(), /offline/);
  await assert.rejects(client.creators(), /Authentication/);
  assert.equal(calls.at(-1).options.headers.authorization, undefined);
});
