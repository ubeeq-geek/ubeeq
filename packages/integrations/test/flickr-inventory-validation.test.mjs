import test from 'node:test';
import assert from 'node:assert/strict';
import { FlickrClient } from '../dist/index.js';

const credentials = { token: 'token', tokenSecret: 'secret' };
const clientFor = payload => new FlickrClient('key', 'secret', async () => new Response(JSON.stringify(payload)));

test('Flickr inventory rejects absent/malformed pages instead of inventing an empty completed catalogue', async () => {
  for (const payload of [null, [], {}, { photos: {} }, { photos: { page: 1, pages: 1 } },
    { photos: { page: 2, pages: 2, photo: [] } }, { photos: { page: 1, pages: 'Infinity', photo: [] } },
    { photos: { page: 1, pages: '', photo: [] } }, { photos: { page: 1, pages: false, photo: [] } },
    { photos: { page: 1, pages: 0, photo: [{ id: '1' }] } }, { photos: { page: 1, pages: 1, photo: {} } }]) {
    await assert.rejects(clientFor(payload).inventoryPage(credentials, 1));
  }
});

test('Flickr inventory accepts explicit empty catalogues and numeric-string pagination without dropping metadata', async () => {
  assert.deepEqual(await clientFor({ photos: { page: '1', pages: '0', photo: [] } }).inventoryPage(credentials, 1), { page: 1, pages: 0, photos: [] });
  const photo = { id: '1', title: 'Original title', description: { _content: 'Caption' }, url_o: 'https://images.example/original' };
  assert.deepEqual(await clientFor({ photos: { page: '2', pages: '3', photo: [photo] } }).inventoryPage(credentials, 2), { page: 2, pages: 3, photos: [photo] });
});

test('Flickr inventory rejects unidentified, duplicate and oversized photo pages', async () => {
  for (const photo of [[null], [{}], [{ id: '' }], [{ id: 1 }], [{ id: '1' }, { id: '1' }]]) {
    await assert.rejects(clientFor({ photos: { page: 1, pages: 1, photo } }).inventoryPage(credentials, 1), /Invalid Flickr inventory photo/);
  }
  await assert.rejects(clientFor({ photos: { page: 1, pages: 1, photo: [{ id: '1' }, { id: '2' }] } }).inventoryPage(credentials, 1, 1), /Invalid Flickr inventory response/);
});

test('Flickr inventory rejects invalid caller pagination before making requests', async () => {
  let calls = 0;
  const client = new FlickrClient('key', 'secret', async () => { calls++; throw new Error('unexpected request'); });
  for (const page of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) await assert.rejects(client.inventoryPage(credentials, page), /Invalid Flickr inventory pagination/);
  for (const size of [0, -1, 1.5, NaN, Infinity]) await assert.rejects(client.inventoryPage(credentials, 1, size), /Invalid Flickr inventory pagination/);
  assert.equal(calls, 0);
});
