import test from 'node:test';
import assert from 'node:assert/strict';
import { CreatorClient } from '../dist/index.js';
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
