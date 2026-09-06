import test from 'node:test';
import assert from 'node:assert/strict';
import { CreatorClient } from '../dist/index.js';
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
