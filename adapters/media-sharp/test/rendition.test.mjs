import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { renderImageRendition } from '../dist/index.js';

test('crop renderer matches legacy JPEG bytes without rotating EXIF-oriented pixels', async () => {
  const pixels = Buffer.from(Array.from({ length: 20 * 10 * 3 }, (_, index) => index % 251));
  const source = await sharp(pixels, { raw: { width: 20, height: 10, channels: 3 } }).withMetadata({ orientation: 6 }).png().toBuffer();
  const expected = await sharp(source, { limitInputPixels: false }).extract({ left: 5, top: 0, width: 10, height: 10 })
    .resize(32, 32).jpeg({ quality: 82, mozjpeg: true }).toBuffer();
  const actual = await renderImageRendition(source, { width: 32, height: 32, crop: { x: 5, y: 0, width: 10, height: 10 }, maxInputPixels: false });
  assert.deepEqual(Buffer.from(actual), expected);
  const fitted = await renderImageRendition(source, { width: 100, height: 100, fit: 'inside', withoutEnlargement: true });
  const metadata = await sharp(fitted).metadata();
  assert.deepEqual([metadata.width, metadata.height], [20, 10]);
});

test('renderer rejects invalid geometry, quality, pixel budget and undecodable input', async () => {
  const source = await sharp({ create: { width: 20, height: 10, channels: 3, background: 'red' } }).png().toBuffer();
  for (const extra of [{ width: 0 }, { quality: 101 }, { maxInputPixels: 100 }, { crop: { x: -1, y: 0, width: 10, height: 10 } }, { crop: { x: 15, y: 0, width: 10, height: 10 } }]) {
    await assert.rejects(renderImageRendition(source, { width: 20, height: 20, ...extra }));
  }
  await assert.rejects(renderImageRendition(Buffer.from('invalid'), { width: 20, height: 20 }));
});
