import test from 'node:test';
import assert from 'node:assert/strict';
import { SmugMugHttpGateway } from '../dist/index.js';

const vaultFor = () => {
  const values = new Map();
  return { values, async put(value) { values.set('ref', value); return 'ref'; }, async get(ref) { return values.get(ref); },
    async replace(ref, value) { values.set(ref, value); return ref; }, async delete(ref) { values.delete(ref); } };
};
const gatewayFor = (vault, fetch) => new SmugMugHttpGateway({ apiKey: 'fixture-key', apiSecret: 'fixture-secret', callbackUrl: 'https://app.example/callback', vault, fetch });

test('SmugMug authorization cannot invent account identities from malformed provider metadata', async () => {
  for (const payload of [null, {}, { Response: {} }, { Response: { User: [] } }, { Response: { User: { UserID: '', Uri: ' ' } } }]) {
    const vault = vaultFor(); await vault.put({ token: 'request', tokenSecret: 'request-secret' }); let calls = 0;
    const gateway = gatewayFor(vault, async () => ++calls === 1 ? new Response('oauth_token=access&oauth_token_secret=access-secret') : Response.json(payload));
    await assert.rejects(gateway.completeAuthorization('ref', 'verifier'), /stable account identity/);
    assert.equal(calls, 2);
    // Retain the exchanged credential for application-owned recovery; no invented account is returned.
    assert.deepEqual(await vault.get('ref'), { token: 'access', tokenSecret: 'access-secret' });
  }
});

test('SmugMug authorization preserves provider UserID precedence and URI fallback', async () => {
  for (const user of [{ UserID: 'account', Uri: '/api/v2/user/account' }, { Uri: '/api/v2/user/account' }]) {
    const vault = vaultFor(); await vault.put({ token: 'request', tokenSecret: 'request-secret' }); let calls = 0;
    const gateway = gatewayFor(vault, async () => ++calls === 1 ? new Response('oauth_token=access&oauth_token_secret=access-secret') : Response.json({ Response: { User: user } }));
    const result = await gateway.completeAuthorization('ref', 'verifier');
    assert.equal(result.accountId, user.UserID || user.Uri); assert.equal(result.accountName, 'SmugMug creator');
  }
});

test('shared SmugMug authorization, vault replacement and resumable inventory preserve metadata', async () => {
  const vault = vaultFor(), calls = [], responses = [
    new Response('oauth_token=request&oauth_token_secret=request-secret'),
    new Response('oauth_token=access&oauth_token_secret=access-secret'),
    Response.json({ Response: { User: { UserID: 'account', NickName: 'Creator' } } }),
    Response.json({ Response: { User: { NodeUri: '/api/v2/node/root' } } }),
    Response.json({ Response: { Node: [{ NodeID: 'folder', Type: 'Folder', Name: 'Archive', SortIndex: 2 }],
      AlbumImage: [{ ImageKey: 'image', AlbumKey: 'album', WebUri: 'https://photos.example/image', OriginalImageUrl: 'https://photos.example/original', Keywords: 'one; two', OriginalSize: 100 }],
      Pages: { NextPage: '/api/v2/node/root!children?start=2' } } }),
    Response.json({ Response: { Node: [], AlbumImage: [] } })
  ];
  const gateway = gatewayFor(vault, async (url, init) => { calls.push({ url, init }); assert.match(init.headers.Authorization, /^OAuth /); return responses.shift(); });
  const started = await gateway.startAuthorization('state');
  assert.match(started.authorizationUrl, /Access=Full&Permissions=Read/); assert.ok(!started.authorizationUrl.includes('request-secret'));
  assert.match(calls[0].init.headers.Authorization, /oauth_callback=/);
  const connected = await gateway.completeAuthorization(started.credentialRef, 'verifier');
  assert.equal(connected.accountId, 'account'); assert.equal(connected.accountName, 'Creator'); assert.equal(connected.capabilities.originalDownloads, false);
  assert.deepEqual(await vault.get('ref'), { token: 'access', tokenSecret: 'access-secret' });
  assert.ok(!JSON.stringify(connected).includes('access-secret'));
  const first = await gateway.inventory('ref');
  assert.equal(first.collections[0].kind, 'FOLDER'); assert.equal(first.collections[0].position, 2);
  assert.deepEqual(first.images[0].keywords, ['one', 'two']); assert.equal(first.images[0].originalAvailable, true);
  assert.match(first.nextCursor, /^smugmug:v1:/);
  assert.deepEqual(await gateway.inventory('ref', first.nextCursor), { collections: [], images: [] });
  assert.equal(calls.at(-1).url, 'https://api.smugmug.com/api/v2/node/root!children?start=2');
  await gateway.deleteCredential('ref'); assert.equal(await vault.get('ref'), undefined);
});

test('shared SmugMug explicit writes preserve upload headers, bytes, receipts and metadata updates', async () => {
  const vault = vaultFor(); await vault.put({ token: 'token', tokenSecret: 'secret' }); const calls = [];
  const gateway = gatewayFor(vault, async (url, init) => {
    calls.push({ url, init });
    return init.method === 'PUT' ? Response.json({ Response: { Image: { ImageKey: 'image', Uri: '/api/v2/image/image', WebUri: 'https://photos.example/image' } } }) : new Response(null, { status: 204 });
  });
  assert.deepEqual(await gateway.publish('ref', { galleryUri: '/api/v2/album/album', body: Buffer.from('bytes'), filename: 'image.jpg', mimeType: 'image/jpeg', title: 'Title', caption: 'Caption', keywords: ['one', 'two'] }),
    { remoteId: 'image', remoteUrl: 'https://photos.example/image', remoteUri: '/api/v2/image/image' });
  assert.equal(calls[0].url, 'https://upload.smugmug.com/'); assert.equal(calls[0].init.headers['X-Smug-AlbumUri'], '/api/v2/album/album');
  assert.equal(Buffer.from(calls[0].init.body).toString(), 'bytes'); assert.match(calls[0].init.headers.Authorization, /^OAuth /);
  await gateway.updateMetadata('ref', { remoteUri: '/api/v2/image/image', title: 'Updated', keywords: ['one'] });
  assert.equal(calls[1].init.method, 'PATCH'); assert.deepEqual(JSON.parse(Buffer.from(calls[1].init.body).toString()), { Image: { Title: 'Updated', Caption: '', Keywords: 'one' } });
});

test('shared SmugMug retains download and request failure behavior without implicit retries', async () => {
  const vault = vaultFor(); await vault.put({ token: 'token', tokenSecret: 'secret' });
  const image = { remoteId: 'image', galleryId: 'album', url: 'https://photos.example/image', originalAvailable: true, sourceUrl: 'https://photos.example/original', byteSize: 10 };
  const gateway = gatewayFor(vault, async () => new Response('short', { headers: { 'content-length': '5', 'content-type': 'image/jpeg' } }));
  await assert.rejects(gateway.download('ref', image), /partial/);
  assert.equal((await gateway.download('ref', { ...image, byteSize: 5 })).body.toString(), 'short');
  await assert.rejects(gateway.inventory('ref', 'invalid'), /cursor/);
  await assert.rejects(gateway.updateMetadata('ref', { remoteUri: 'https://foreign.example', title: '', keywords: [] }), /URI/);
  await assert.rejects(gateway.download('missing', image), /credential reference/);
  let calls = 0; const failure = new Error('transport failed');
  await assert.rejects(gatewayFor(vault, async () => { calls++; throw failure; }).inventory('ref'), error => error === failure);
  assert.equal(calls, 1);
});
