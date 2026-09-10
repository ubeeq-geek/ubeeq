import test from 'node:test';
import assert from 'node:assert/strict';
import { CreatorClient as NodeClient } from '../dist/index.js';
import { CreatorClient as BrowserClient } from '../dist/browser/creator-client.js';
for (const Client of [NodeClient, BrowserClient]) test(`crop source client validates bounded metadata and image bytes (${Client === NodeClient ? 'node' : 'browser'})`, async () => {
  const payload = { revision: 2, imageId: 'image', sourceWidth: 16, sourceHeight: 8, orientation: 6, width: 8, height: 16,
    contentType: 'image/jpeg', byteLength: 3, previewBase64: 'YWJj' };
  let value = payload, last;
  const client = new Client(async (url, options) => {
    if (url.endsWith('sign-in')) return Response.json({ token: 'test-token' });
    last = { url, options }; return Response.json(value);
  });
  await client.signIn('owner@example.test', 'password');
  const result = await client.brandingCropSource('creator/one', 'profile');
  assert.equal(last.url, '/api/studio/creators/creator%2Fone/branding/profile-image/crop-source');
  assert.equal(last.options.headers.authorization, 'Bearer test-token');
  assert.equal(result.orientation, 6); assert.equal(result.preview.type, 'image/jpeg'); assert.equal(await result.preview.text(), 'abc');
  for (const patch of [{ orientation: 0 }, { sourceWidth: -1 }, { revision: 0 }, { previewBase64: '????' }, { byteLength: 2 }, { byteLength: 2 * 1024 * 1024 + 1 }, { contentType: 'text/html' }]) {
    value = { ...payload, ...patch }; await assert.rejects(client.brandingCropSource('creator/one', 'cover'), /Invalid/);
  }
  await assert.rejects(client.brandingCropSource('creator/one', 'other'), /Invalid/);
});
