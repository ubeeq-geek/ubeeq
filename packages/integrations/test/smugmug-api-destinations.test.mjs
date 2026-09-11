import test from 'node:test';
import assert from 'node:assert/strict';
import { SmugMugHttpGateway } from '../dist/index.js';
const vault = { async get() { return { token: 'fixture', tokenSecret: 'fixture-secret' }; } };
const create = fetch => new SmugMugHttpGateway({ apiKey: 'key', apiSecret: 'secret', callbackUrl: 'https://app.example/callback', vault, fetch });
const cursor = values => `smugmug:v1:${Buffer.from(JSON.stringify(values)).toString('base64url')}`;

test('SmugMug rejects foreign and non-API cursor destinations before signing or fetching', async () => {
  let calls = 0;
  const gateway = create(async () => { calls++; throw new Error('must not fetch'); });
  for (const value of ['https://foreign.example/api/v2/node/x', '//foreign.example/api/v2/node/x', '/api/v2evil', '/services/oauth', 'https://name:secret@api.smugmug.com/api/v2/node/x', '/api/v2/node/x#fragment']) {
    await assert.rejects(gateway.inventory('ref', cursor([value])), /cursor/);
  }
  assert.equal(calls, 0);
});

test('SmugMug validates provider continuations before returning an inventory cursor', async () => {
  const calls = [];
  const gateway = create(async (url, init) => {
    calls.push(url); assert.equal(init.redirect, 'error');
    return Response.json({ Response: { Node: [], Pages: { NextPage: 'https://foreign.example/api/v2/node/next' } } });
  });
  await assert.rejects(gateway.inventory('ref', cursor(['/api/v2/node/root!children'])), /destination/);
  assert.deepEqual(calls, ['https://api.smugmug.com/api/v2/node/root!children']);
});

test('SmugMug normalizes same-origin absolute continuations while preserving queries and redirect rejection', async () => {
  const calls = [];
  const gateway = create(async (url, init) => {
    calls.push(url); assert.equal(init.redirect, 'error');
    return Response.json({ Response: { Node: [], ...(calls.length === 1 ? { Pages: { NextPage: 'https://api.smugmug.com/api/v2/node/root!children?start=2' } } : {}) } });
  });
  const first = await gateway.inventory('ref', cursor(['/api/v2/node/root!children']));
  const queued = JSON.parse(Buffer.from(first.nextCursor.slice('smugmug:v1:'.length), 'base64url').toString());
  assert.deepEqual(queued, ['/api/v2/node/root!children?start=2']);
  assert.equal((await gateway.inventory('ref', first.nextCursor)).nextCursor, undefined);
  assert.equal(calls[1], 'https://api.smugmug.com/api/v2/node/root!children?start=2');
});
