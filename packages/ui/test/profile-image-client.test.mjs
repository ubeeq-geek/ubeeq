import test from 'node:test';
import assert from 'node:assert/strict';
import { CreatorClient as NodeClient } from '../dist/index.js';
import { CreatorClient as BrowserClient } from '../dist/browser/creator-client.js';

for (const Client of [NodeClient, BrowserClient]) test(`profile image client snapshots crop, authenticates raw uploads and never retries (${Client === NodeClient ? 'node' : 'browser'})`, async () => {
  const calls = []; let mode = 'ok';
  const client = new Client(async (url, options) => {
    if (url.endsWith('sign-in')) return Response.json({ token: 'test-token' });
    calls.push({ url, options });
    if (mode === 'lost') throw new Error('Lost reply');
    if (mode === 'unauthorized') return Response.json({ message: 'Expired' }, { status: 401 });
    if (url.endsWith('square512')) return new Response('jpeg', { headers: { 'content-type': mode === 'bad-type' ? 'text/html' : 'image/jpeg' } });
    return Response.json({ revision: 2, image: null });
  });
  await client.signIn('owner@example.test', 'password');
  const file = new Blob(['png'], { type: 'image/png' }), crop = { x: 1, y: 2, size: 3 };
  const saving = client.saveProfileImage('creator/one', 1, file, crop, 'A & B'); crop.x = 999;
  await saving;
  const query = new URL(calls[0].url, 'http://localhost').searchParams;
  assert.equal(query.get('expectedRevision'), '1'); assert.equal(query.get('altText'), 'A & B');
  assert.deepEqual(JSON.parse(query.get('crop')), { x: 1, y: 2, size: 3 });
  assert.equal(calls[0].options.body, file); assert.equal(calls[0].options.headers.authorization, 'Bearer test-token');
  assert.equal(calls[0].options.headers['content-type'], 'image/png');
  assert.match(calls[0].url, /creator%2Fone\/branding\/profile-image/);
  await client.removeProfileImage('creator/one', 2); assert.equal(calls.at(-1).options.method, 'DELETE');
  assert.equal(calls.at(-1).options.body, undefined);
  assert.equal((await client.profileImagePreview('creator/one')).type, 'image/jpeg');
  mode = 'bad-type'; await assert.rejects(client.profileImagePreview('creator/one'), /Unexpected/);
  mode = 'lost'; const count = calls.length;
  await assert.rejects(client.saveProfileImage('creator/one', 2, file), /Lost reply/); assert.equal(calls.length, count + 1);
  mode = 'unauthorized'; await assert.rejects(client.saveProfileImage('creator/one', 2, file), /Expired/);
  mode = 'ok'; await client.profileImage('creator/one'); assert.equal(calls.at(-1).options.headers.authorization, undefined);
});
