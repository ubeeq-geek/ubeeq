import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { createImagePreview, SharpImageProcessor } from '../dist/index.js';

const source = (width, height) => sharp({ create: { width, height, channels: 3, background: '#8844aa' } }).png().toBuffer();

test('fitted preview preserves aspect ratio and does not enlarge', async () => {
  for (const [width, height, expected] of [[640, 320, [320, 160]], [8, 4, [8, 4]]]) {
    const bytes = await createImagePreview(await source(width, height), { width: 320, height: 320 });
    const metadata = await sharp(bytes).metadata();
    assert.equal(metadata.format, 'jpeg');
    assert.deepEqual([metadata.width, metadata.height], expected);
  }
});

test('cover recipe crops and can enlarge an imported image', async () => {
  const bytes = await createImagePreview(await source(8, 4), { width: 160, height: 160, fit: 'cover', attentionCrop: true, withoutEnlargement: false, quality: 80 });
  const metadata = await sharp(bytes).metadata();
  assert.deepEqual([metadata.width, metadata.height], [160, 160]);
});

test('invalid source, dimensions, quality and pixel budget reject', async () => {
  await assert.rejects(createImagePreview(Buffer.from('not an image'), { width: 32, height: 32 }));
  const bytes = await source(20, 20);
  for (const options of [{ width: 0, height: 32 }, { width: 32, height: 32, quality: 101 }, { width: 32, height: 32, maxInputPixels: 100 }]) {
    await assert.rejects(createImagePreview(bytes, options));
  }
});

test('processor returns decoded preview bytes with immutable source lineage', async () => {
  const processor = new SharpImageProcessor();
  const input = { assetId: 'asset-1', sourceVersionId: 'version-2', contentType: 'image/png', source: await source(640, 320) };
  const result = await processor.process(input);
  assert.equal(result.metadata.decodedFormat, 'png');
  assert.equal(result.metadata.width, 640);
  const preview = result.renditions[0];
  assert.equal(preview.sourceVersionId, 'version-2');
  assert.equal(preview.id, 'preview:asset-1:version-2');
  assert.equal(preview.byteLength, preview.body.byteLength);
  assert.equal((await sharp(preview.body).metadata()).format, 'jpeg');
  await assert.rejects(processor.process({ ...input, sourceVersionId: '' }));
  await assert.rejects(processor.process({ ...input, contentType: 'text/plain' }));
});
