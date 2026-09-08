import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { normalizeFlickrPhoto, normalizeFlickrProviderPhoto, flickrTextContent } from '../dist/index.js';

test('Flickr manifest normalization preserves legacy hashes while deduplicating tags and albums', () => {
  const source = { remoteId: '1', remoteUrl: 'https://www.flickr.com/photos/owner/1', tags: [' x ', 'x', '', 'y'], albumIds: ['a', 'a', 'b'], visibility: 'private', originalAvailable: false };
  const before = structuredClone(source), result = normalizeFlickrPhoto(source);
  assert.deepEqual(result.tags, ['x', 'y']); assert.deepEqual(result.albumIds, ['a', 'b']);
  assert.equal(result.metadataHash, createHash('sha256').update(JSON.stringify(source)).digest('hex'));
  assert.deepEqual(source, before); result.tags.push('z'); result.albumIds.push('c'); assert.deepEqual(source, before);
});

test('Flickr provider metadata preserves dates, source descriptors, licence and album order', () => {
  const photo = normalizeFlickrProviderPhoto({ id: 'photo/1', owner: 'owner/name', title: { _content: 'Title' }, description: 'Caption', tags: 'one  two one',
    datetaken: '2026-01-02', dateupload: '1', license: 4, ispublic: 1, isfriend: 1, url_m: 'https://images.example/preview', url_o: 'https://images.example/original', originalformat: 'tif' }, ['b', 'a', 'b']);
  assert.equal(photo.remoteUrl, 'https://www.flickr.com/photos/owner%2Fname/photo%2F1');
  assert.equal(photo.title, 'Title'); assert.equal(photo.description, 'Caption'); assert.equal(photo.capturedAt, '2026-01-02');
  assert.equal(photo.uploadedAt, '1970-01-01T00:00:01.000Z'); assert.equal(photo.licence, '4'); assert.equal(photo.visibility, 'public');
  assert.equal(photo.originalSourceUrl, 'https://images.example/original'); assert.equal(photo.originalFilename, 'photo/1.tif'); assert.equal(photo.originalAvailable, true);
  assert.deepEqual(photo.tags, ['one', 'two']); assert.deepEqual(photo.albumIds, ['b', 'a']);
});

test('Flickr mapping retains privacy precedence, reference-only records and text behavior', () => {
  for (const [flags, visibility] of [[{}, 'private'], [{ isfamily: 1 }, 'family'], [{ isfriend: 1, isfamily: 1 }, 'friends']]) {
    const photo = normalizeFlickrProviderPhoto({ id: '1', pathalias: 'alias', ...flags }, []);
    assert.equal(photo.visibility, visibility); assert.equal(photo.originalAvailable, false); assert.equal(photo.originalSourceUrl, undefined);
    assert.equal(photo.remoteUrl, 'https://www.flickr.com/photos/alias/1');
  }
  assert.equal(flickrTextContent({ _content: '<b>literal</b>' }), '<b>literal</b>');
  for (const value of [null, 1, {}, { _content: 1 }]) assert.equal(flickrTextContent(value), undefined);
  assert.throws(() => normalizeFlickrProviderPhoto({ id: '1', dateupload: 'not-a-date' }, []), RangeError);
});
