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

test('loaded decoder meets the patched Sharp/libvips/librsvg baseline', t => {
  t.diagnostic(JSON.stringify({ platform: process.platform, arch: process.arch, sharp: sharp.versions.sharp, vips: sharp.versions.vips, rsvg: sharp.versions.rsvg }));
  // GHSA-f88m-g3jw-g9cj also applies when a globally installed libvips is used.
  assert.ok(atLeast(sharp.versions.sharp, [0, 35, 5]), JSON.stringify(sharp.versions));
  assert.ok(atLeast(sharp.versions.vips, [8, 18, 3]), JSON.stringify(sharp.versions));
  // GHSA-wq5f-xc86-pv6w also requires patched librsvg in custom native builds.
  assert.ok(typeof sharp.versions.rsvg === 'string' && atLeast(sharp.versions.rsvg, [2, 63, 2]), JSON.stringify(sharp.versions));
});

test('patched native SVG decoding retains vector rasterization', async () => {
  const source = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="12"><rect width="24" height="12" fill="#8844aa"/></svg>');
  const output = await sharp(source).png().toBuffer();
  const metadata = await sharp(output).metadata();
  assert.equal(metadata.format, 'png');
  assert.deepEqual([metadata.width, metadata.height], [24, 12]);
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
