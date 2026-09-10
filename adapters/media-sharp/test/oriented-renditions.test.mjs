import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { renderImageRendition, renderCoverRenditions, SharpImageRenditionProcessor } from '../dist/index.js';

const rawWidth = 16, rawHeight = 8;
const pixels = Buffer.from(Array.from({ length: rawWidth * rawHeight * 3 }, (_, i) => (i * 29 + Math.floor(i / 17) * 31) % 256));
const request = source => ({ assetId: 'asset', sourceVersionId: 'original-version', contentType: 'image/png', source });

// Independent integer-pixel mapping. Expected JPEGs do not use autoOrient/rotate
// or the production geometry helpers, so operation-order mistakes are visible.
function uprightPixels(tag) {
  const width = tag >= 5 ? rawHeight : rawWidth, height = tag >= 5 ? rawWidth : rawHeight;
  const data = Buffer.alloc(pixels.length);
  for (let y = 0; y < rawHeight; y++) for (let x = 0; x < rawWidth; x++) {
    const [dx, dy] = [null, [x, y], [rawWidth - 1 - x, y], [rawWidth - 1 - x, rawHeight - 1 - y],
      [x, rawHeight - 1 - y], [y, x], [rawHeight - 1 - y, x],
      [rawHeight - 1 - y, rawWidth - 1 - x], [y, rawWidth - 1 - x]][tag];
    pixels.copy(data, (dy * width + dx) * 3, (y * rawWidth + x) * 3, (y * rawWidth + x + 1) * 3);
  }
  return { data, width, height };
}
const sourceFor = tag => sharp(pixels, { raw: { width: rawWidth, height: rawHeight, channels: 3 } })
  .withMetadata({ orientation: tag }).png().toBuffer();
async function expectedJpeg(tag, crop, width, height, fit = 'cover', withoutEnlargement = false) {
  const expected = uprightPixels(tag);
  let image = sharp(expected.data, { raw: { width: expected.width, height: expected.height, channels: 3 } });
  if (crop) image = image.extract({ left: crop.x, top: crop.y, width: crop.width, height: crop.height });
  return image.resize(width, height, { fit, withoutEnlargement }).jpeg({ quality: 82, mozjpeg: true }).toBuffer();
}

test('oriented renderer crops the upright raster for all eight EXIF tags, including mirrored asymmetric crops', async () => {
  for (let tag = 1; tag <= 8; tag++) {
    const source = await sourceFor(tag), crop = { x: 1, y: 2, width: 5, height: 3 };
    const output = await renderImageRendition(source, { coordinateSpace: 'oriented', crop, width: 25, height: 15 });
    assert.deepEqual(Buffer.from(output), await expectedJpeg(tag, crop, 25, 15), `orientation ${tag}`);
    assert.equal((await sharp(output).metadata()).orientation, undefined);
    const fit = await renderImageRendition(source, { coordinateSpace: 'oriented', width: 40, height: 40, fit: 'inside', withoutEnlargement: true });
    assert.deepEqual(Buffer.from(fit), await expectedJpeg(tag, undefined, 40, 40, 'inside', true));
    const legacy = await renderImageRendition(source, { crop, width: 25, height: 15 });
    const explicitRaw = await renderImageRendition(source, { coordinateSpace: 'raw', crop, width: 25, height: 15 });
    assert.deepEqual(legacy, explicitRaw);
    assert.deepEqual(Buffer.from(legacy), await expectedJpeg(1, crop, 25, 15));
  }
});

test('oriented rendition sets report matching dimensions and crops with immutable raw-source lineage', async () => {
  for (let tag = 1; tag <= 8; tag++) {
    const source = await sourceFor(tag), dimensions = uprightPixels(tag);
    const squareCrop = { x: 1, y: 2, size: 4 };
    const result = await new SharpImageRenditionProcessor({ coordinateSpace: 'oriented', renditionNames: ['w320', 'square256'] })
      .process({ ...request(source), squareCrop });
    assert.equal(result.metadata.coordinateSpace, 'oriented');
    assert.equal(result.metadata.sourceOrientation, tag);
    assert.deepEqual([result.metadata.width, result.metadata.height], [dimensions.width, dimensions.height]);
    assert.deepEqual([result.metadata.rawSourceWidth, result.metadata.rawSourceHeight], [16, 8]);
    assert.deepEqual([result.metadata.squareCropX, result.metadata.squareCropY, result.metadata.squareCropSize], [1, 2, 4]);
    assert.equal(result.metadata.aspectRatio, Number((dimensions.width / dimensions.height).toFixed(5)));
    assert.deepEqual(Buffer.from(result.renditions[0].body), await expectedJpeg(tag, undefined, 320, 320, 'inside', true));
    assert.deepEqual(Buffer.from(result.renditions[1].body), await expectedJpeg(tag, { x: 1, y: 2, width: 4, height: 4 }, 256, 256));
    assert.ok(result.renditions.every(item => item.sourceVersionId === 'original-version' && !item.storage));
    assert.equal((await sharp(source).metadata()).orientation, tag);
    // Crop bounds are evaluated after orientation, including default centring.
    const centred = await new SharpImageRenditionProcessor({ coordinateSpace: 'oriented', renditionNames: ['square256'] }).process(request(source));
    assert.deepEqual([centred.metadata.squareCropX, centred.metadata.squareCropY], tag >= 5 ? [0, 4] : [4, 0]);
  }
});

test('oriented cover focal selections and explicit overrides use upright geometry for all EXIF tags', async () => {
  for (let tag = 1; tag <= 8; tag++) {
    const source = await sourceFor(tag), dimensions = uprightPixels(tag);
    const result = await renderCoverRenditions(source, { coordinateSpace: 'oriented', focalPoint: { x: 0, y: 1 }, variants: [
      { name: 'wide', width: 12, height: 6 }, { name: 'detail', width: 5, height: 3, crop: { x: 1, y: 2, width: 5, height: 3 } }
    ] });
    assert.equal(result.coordinateSpace, 'oriented');
    assert.equal(result.sourceOrientation, tag);
    assert.deepEqual([result.sourceWidth, result.sourceHeight], [dimensions.width, dimensions.height]);
    assert.deepEqual([result.rawSourceWidth, result.rawSourceHeight], [16, 8]);
    assert.deepEqual(result.renditions[0].crop, tag >= 5 ? { x: 0, y: 12, width: 8, height: 4 } : { x: 0, y: 0, width: 16, height: 8 });
    for (const [i, output] of result.renditions.entries()) {
      assert.deepEqual(Buffer.from(output.body), await expectedJpeg(tag, output.crop, i ? 5 : 12, i ? 3 : 6));
      assert.equal((await sharp(output.body).metadata()).orientation, undefined);
    }
  }
});

test('oriented configuration is snapshotted and keeps source, pixel and output budgets enforced', async () => {
  const source = await sourceFor(6);
  const options = { coordinateSpace: 'oriented', renditionNames: ['square256'], squareCrop: { x: 0, y: 8, size: 8 } };
  const processor = new SharpImageRenditionProcessor(options);
  options.coordinateSpace = 'raw'; options.squareCrop.y = 0;
  const result = await processor.process(request(source));
  assert.equal(result.metadata.coordinateSpace, 'oriented');
  assert.equal(result.metadata.squareCropY, 8);
  const coverOptions = { coordinateSpace: 'oriented', variants: [{ name: 'square', width: 8, height: 8 }] };
  const expected = await renderCoverRenditions(source, coverOptions);
  const copy = Buffer.from(source), pending = renderCoverRenditions(copy, coverOptions);
  coverOptions.coordinateSpace = 'raw'; copy.fill(0);
  assert.deepEqual(await pending, expected);
  for (const coordinateSpace of [null, '', 'auto', false, 6]) {
    assert.throws(() => new SharpImageRenditionProcessor({ coordinateSpace }), /coordinate space/);
    await assert.rejects(renderCoverRenditions(source, { coordinateSpace, variants: [{ name: 'one', width: 1, height: 1 }] }), /coordinate space/);
    await assert.rejects(renderImageRendition(source, { coordinateSpace, width: 1, height: 1 }), /coordinate space/);
  }
  for (const limits of [{ maxSourceBytes: 1 }, { maxInputPixels: 1 }, { maxOutputBytes: 1 }]) {
    await assert.rejects(new SharpImageRenditionProcessor({ coordinateSpace: 'oriented', renditionNames: ['square256'], ...limits }).process(request(source)));
    await assert.rejects(renderCoverRenditions(source, { coordinateSpace: 'oriented', variants: [{ name: 'one', width: 8, height: 8 }], ...limits }));
  }
});
