import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { createCropSourcePreview, createImagePreview } from '../dist/index.js';

test('crop source previews preserve raw geometry and produce bounded upright JPEGs without mutating sources', async () => {
  const pixels = Buffer.alloc(16 * 8 * 3);
  for (let index = 0; index < 16 * 8; index++) pixels[index * 3 + (index % 16 < 8 ? 0 : 2)] = 255;
  for (const orientation of [1, 2, 6, 8]) {
    const source = await sharp(pixels, { raw: { width: 16, height: 8, channels: 3 } }).withMetadata({ orientation }).png().toBuffer();
    const original = Buffer.from(source), options = { maxPreviewEdge: 8 };
    const pending = createCropSourcePreview(source, options); source.fill(0); options.maxPreviewEdge = 1;
    const result = await pending;
    assert.equal(result.sourceWidth, 16); assert.equal(result.sourceHeight, 8); assert.equal(result.orientation, orientation);
    assert.deepEqual([result.width, result.height], orientation >= 5 ? [4, 8] : [8, 4]);
    const expected = await createImagePreview(original, { width: 8, height: 8 });
    assert.deepEqual(result.body, expected);
    assert.equal((await sharp(result.body).metadata()).orientation, undefined);
    assert.equal(result.byteLength, result.body.byteLength);
  }
});
test('crop source previews reject source, decoded pixel, output and configuration budget violations', async () => {
  const source = await sharp({ create: { width: 16, height: 8, channels: 3, background: 'blue' } }).png().toBuffer();
  for (const options of [{ maxSourceBytes: source.length - 1 }, { maxInputPixels: 100 }, { maxOutputBytes: 1 }, { maxPreviewEdge: 0 }, { maxPreviewEdge: 4097 }, { maxSourceBytes: Infinity }])
    await assert.rejects(createCropSourcePreview(source, options));
  await assert.rejects(createCropSourcePreview(Buffer.from('invalid')));
});
