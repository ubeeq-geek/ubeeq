import test from 'node:test';
import assert from 'node:assert/strict';
import { CreatorClient as NodeClient } from '../dist/index.js';
import { CreatorClient as BrowserClient } from '../dist/browser/creator-client.js';

for (const Client of [NodeClient, BrowserClient]) test(`branding uploads explicitly opt into coordinate space without changing recrops (${Client === NodeClient ? 'node' : 'browser'})`, async () => {
  const calls = [];
  const client = new Client(async (url, options) => {
    if (url.endsWith('sign-in')) return Response.json({ token: 'test-token' });
    calls.push({ url, options });
    return Response.json({ revision: 2, image: null });
  });
  await client.signIn('owner@example.test', 'password');
  const file = new Blob(['image'], { type: 'image/png' });
  for (const coordinateSpace of [undefined, 'raw', 'oriented']) {
    await client.saveProfileImage('creator/one', 1, file, { x: 0, y: 8, size: 8 }, 'Description', coordinateSpace);
    await client.saveCoverImage('creator/one', 1, file, { focalPoint: { x: 0.5, y: 1 } }, coordinateSpace);
    for (const call of calls.splice(0)) {
      const query = new URL(call.url, 'http://localhost').searchParams;
      assert.equal(query.get('coordinateSpace'), coordinateSpace ?? null);
      assert.equal(call.options.method, 'POST'); assert.equal(call.options.body, file);
      assert.equal(call.options.headers.authorization, 'Bearer test-token');
    }
  }
  for (const value of [null, '', 'automatic', false, 6, {}]) {
    await assert.rejects(client.saveProfileImage('id', 1, file, undefined, '', value), /coordinate space/);
    await assert.rejects(client.saveCoverImage('id', 1, file, {}, value), /coordinate space/);
  }
  assert.equal(calls.length, 0);
  await client.recropProfileImage('id', 1, { x: 0, y: 0, size: 8 });
  await client.recropCoverImage('id', 1, { focalPoint: { x: 0.5, y: 1 } });
  for (const call of calls) {
    assert.equal(call.options.method, 'PATCH'); assert.equal(call.options.body, undefined);
    assert.equal(new URL(call.url, 'http://localhost').searchParams.has('coordinateSpace'), false);
  }
});
