import test from 'node:test';
import assert from 'node:assert/strict';
import { contentAssetReferences } from '../dist/index.js';

test('collects nested canonical and legacy asset references, including comparisons, without treating file IDs as assets', () => {
  const body = [{ id: 's', type: 'section', children: [
    { id: 'a', type: 'image', assetId: 'one' },
    { blockId: 'b', type: 'video', mediaId: 'two' },
    { id: 'f', type: 'file', fileId: 'separate-file' }
  ] }];
  const media = [{ assetId: 'one', comparison: { item: { assetId: 'three' } } }];
  assert.deepEqual(contentAssetReferences(body, media).sort(), ['one', 'three', 'two']);
  assert.deepEqual(contentAssetReferences(undefined, undefined), []);
  const cyclic = { type: 'section' }; cyclic.children = [cyclic];
  assert.throws(() => contentAssetReferences([cyclic], []), /cycles/);
});
