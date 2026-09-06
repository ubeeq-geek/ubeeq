import test from 'node:test';
import assert from 'node:assert/strict';
import { selectPrivateAssetRendition } from '../dist/index.js';

test('private rendition selection requires current completed source lineage', () => {
  const asset = { status: 'pending', storage: { scope: 'private', versionId: 'v1' }, processing: { state: 'completed', sourceVersionId: 'v1',
    renditions: [{ id: 'preview', role: 'preview', sourceVersionId: 'v1', storage: { scope: 'private', versionId: 'out-v1' } }] } };
  const selected = selectPrivateAssetRendition(asset, 'preview');
  selected.storage.scope = 'public';
  assert.equal(asset.processing.renditions[0].storage.scope, 'private');
  const variants = [
    { ...asset, status: 'deleted' }, { ...asset, processing: undefined },
    { ...asset, storage: { ...asset.storage, versionId: 'v2' } },
    { ...asset, processing: { ...asset.processing, state: 'pending' } },
    { ...asset, processing: { ...asset.processing, sourceVersionId: 'v2' } },
    ...[{ sourceVersionId: 'v2' }, { role: 'source' }, { storage: { scope: 'public', versionId: 'out-v1' } }].map(change =>
      ({ ...asset, processing: { ...asset.processing, renditions: [{ ...asset.processing.renditions[0], ...change }] } }))
  ];
  for (const value of variants) assert.throws(() => selectPrivateAssetRendition(value, 'preview'), { code: 'not_found' });
  assert.throws(() => selectPrivateAssetRendition(asset, 'unknown'), { code: 'not_found' });
});
