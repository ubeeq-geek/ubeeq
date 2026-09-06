import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { createImagePreview } from '../dist/index.js';

const atLeast = (version, minimum) => {
  const parts = version.split('.').map(Number);
  for (let index = 0; index < minimum.length; index++) {
    if (!Number.isSafeInteger(parts[index])) return false;
    if (parts[index] !== minimum[index]) return parts[index] > minimum[index];
  }
  return true;
};

test('loaded decoder meets the patched Sharp/libvips baseline', () => {
  // GHSA-f88m-g3jw-g9cj also applies when a globally installed libvips is used.
  assert.ok(atLeast(sharp.versions.sharp, [0, 35, 4]), JSON.stringify(sharp.versions));
  assert.ok(atLeast(sharp.versions.vips, [8, 18, 3]), JSON.stringify(sharp.versions));
});

test('GIF and TIFF decode through the bounded preview path after the upgrade', async () => {
  for (const format of ['gif', 'tiff']) {
    const source = await sharp({ create: { width: 24, height: 12, channels: 3, background: '#8844aa' } }).toFormat(format).toBuffer();
    const preview = await createImagePreview(source, { width: 12, height: 12 });
    const metadata = await sharp(preview).metadata();
    assert.equal(metadata.format, 'jpeg');
    assert.deepEqual([metadata.width, metadata.height], [12, 6]);
    await assert.rejects(createImagePreview(source, { width: 12, height: 12, maxInputPixels: 100 }));
  }
});
