import test from 'node:test';
import assert from 'node:assert/strict';
import { assetEditorOptions } from '../dist/index.js';

test('editor choices retain attachment IDs and only accept caller-owned blob thumbnails', () => {
  const assets = [
    { assetId: 'image', mimeType: 'image/png', originalFilename: 'Private image', status: 'pending' },
    { assetId: 'video', mimeType: 'video/mp4', status: 'pending' },
    { assetId: 'audio', mimeType: 'audio/mpeg', status: 'pending' },
    { assetId: 'gone', mimeType: 'image/png', status: 'deleted' },
    { assetId: 'html', mimeType: 'text/html', status: 'pending' }
  ];
  const options = assetEditorOptions(assets, { image: 'blob:private-preview', video: 'https://storage.test/private' });
  assert.deepEqual(options.map(option => option.mediaId), ['image', 'video', 'audio', 'html']);
  assert.deepEqual(options[0], { mediaId: 'image', label: 'Private image', assetType: 'image', mimeType: 'image/png', thumbnailUrl: 'blob:private-preview' });
  assert.deepEqual(options[3], { mediaId: 'html', label: 'html', assetType: 'file', mimeType: 'text/html' });
  assert.equal(options[1].thumbnailUrl, undefined);
  for (const url of ['https://storage.test/private', 'data:image/svg+xml,unsafe', 'javascript:alert(1)']) {
    assert.equal(assetEditorOptions(assets, { image: url })[0].thumbnailUrl, undefined);
  }
  assert.deepEqual(assetEditorOptions([]), []);
});
