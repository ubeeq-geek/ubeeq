import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { cropRectToOriented, cropRectToSource, orientedImageSize } from '@ubeeq/ui';

// Monorepo conformance check: native decoding is not a UI runtime dependency.
const require = createRequire(import.meta.url);
const sharp = createRequire(require.resolve('@ubeeq/media-sharp'))('sharp');
const size = { width: 6, height: 4 }, pixels = Buffer.alloc(size.width * size.height * 3);
for (let index = 0; index < size.width * size.height; index++) pixels.set([index * 7, index * 3, index], index * 3);
for (let orientation = 1; orientation <= 8; orientation++) {
  const source = await sharp(pixels, { raw: { ...size, channels: 3 } }).withMetadata({ orientation }).png().toBuffer();
  const raw = await sharp(source).raw().toBuffer({ resolveWithObject: true });
  const upright = await sharp(source).autoOrient().raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual(orientedImageSize(size, orientation), { width: upright.info.width, height: upright.info.height });
  assert.equal(raw.info.channels, 3); assert.equal(upright.info.channels, 3);
  for (let y = 0; y < size.height; y++) for (let x = 0; x < size.width; x++) {
    const pixel = { x, y, width: 1, height: 1 }, mapped = cropRectToOriented(size, pixel, orientation);
    const from = (y * size.width + x) * 3, to = (mapped.y * upright.info.width + mapped.x) * 3;
    assert.deepEqual(upright.data.subarray(to, to + 3), raw.data.subarray(from, from + 3), `orientation ${orientation}, source pixel ${x},${y}`);
    assert.deepEqual(cropRectToSource(size, mapped, orientation), pixel);
  }
}
console.log('Validated all 8 EXIF orientations against native pixels (192 source pixels).');
