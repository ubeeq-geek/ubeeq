import test from 'node:test';
import assert from 'node:assert/strict';
import { deviantArtGalleryCreateForm as create, deviantArtGalleryPublicationForm as publish, DEVIANTART_GALLERY_CAPABILITIES as capabilities } from '../dist/index.js';

test('regular and sub-gallery creation use documented fields', () => {
  assert.deepEqual(Object.fromEntries(create({ name: ' Paintings ' })), { folder: 'Paintings' });
  const parentFolderId = '4F176AAF-D3BB-32B9-8E35-2A0F0E0A7584';
  assert.deepEqual(Object.fromEntries(create({ name: 'Studies', parentFolderId, description: 'Oil studies' })), {
    folder: 'Studies', parent_folderid: parentFolderId, description: 'Oil studies'
  });
});
test('restricted creation cannot silently create a regular gallery', () => {
  for (const kind of ['premium', 'watchers_only']) assert.throws(() => create({ name: 'Private', kind }), error => error.code === 'unsupported_gallery');
  assert.equal(capabilities.premiumCreation, false);
  assert.equal(capabilities.watchersOnlyCreation, false);
});
test('rejects malformed creation input instead of truncating it', () => {
  for (const input of [{ name: '' }, { name: 'x'.repeat(51) }, { name: 'Art', parentFolderId: 'invalid' }, { name: 'Art', kind: 'invalid' }, { name: 'Art', description: 'x'.repeat(10001) }]) {
    assert.throws(() => create(input));
  }
});
test('Featured-only, gallery-only, and gallery plus Featured remain distinct', () => {
  assert.equal(publish().toString(), 'feature=true');
  assert.deepEqual([...publish(['parent', 'child', 'child'], false)], [['feature', 'false'], ['galleryids[]', 'parent'], ['galleryids[]', 'child']]);
  assert.deepEqual([...publish(['child'], true)], [['feature', 'true'], ['galleryids[]', 'child']]);
  assert.throws(() => publish([], false));
  assert.throws(() => publish([''], true));
  assert.throws(() => publish([], 'false'));
});
