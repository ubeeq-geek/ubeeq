import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { SharpImageRenditionProcessor } from '../dist/index.js';

const source = (width, height) => sharp({ create: { width, height, channels: 3, background: '#8844aa' } }).png().toBuffer();
const input = bytes => ({ assetId: 'asset', sourceVersionId: 'version', contentType: 'image/png', source: bytes });

test('seven rendition recipes preserve fitted dimensions, square crops and source lineage', async () => {
  const result = await new SharpImageRenditionProcessor().process(input(await source(2000, 1000)));
  assert.equal(result.renditions.length, 7);
  assert.equal(result.measuredUnits, 7);
  assert.equal(result.metadata.squareCropX, 500);
  assert.equal(result.metadata.squareCropSize, 1000);
  const expected = [[320, 160], [640, 320], [1280, 640], [1920, 960], [256, 256], [512, 512], [1024, 1024]];
  for (const [index, rendition] of result.renditions.entries()) {
    const decoded = await sharp(rendition.body).metadata();
    assert.deepEqual([decoded.width, decoded.height], expected[index]);
    assert.equal(decoded.format, 'jpeg');
    assert.equal(rendition.sourceVersionId, 'version');
    assert.equal(rendition.byteLength, rendition.body.byteLength);
    assert.equal(rendition.role, 'preview');
    assert.equal(rendition.storage, undefined);
  }
  assert.equal(result.renditions[0].id, 'preview:asset:version');
  assert.equal(new Set(result.renditions.map(item => item.id)).size, 7);
});

test('small sources are not enlarged for fitted output; crop options are snapshotted and clamped', async () => {
  const options = { squareCrop: { x: 100, y: -4, size: 4 } };
  const processor = new SharpImageRenditionProcessor(options);
  options.squareCrop.size = 1;
  const result = await processor.process(input(await source(8, 4)));
  assert.equal(result.metadata.squareCropX, 4);
  assert.equal(result.metadata.squareCropY, 0);
  assert.equal(result.metadata.squareCropSize, 4);
  for (const rendition of result.renditions.slice(0, 4)) {
    const decoded = await sharp(rendition.body).metadata();
    assert.deepEqual([decoded.width, decoded.height], [8, 4]);
  }
});

test('malformed sources, missing lineage and finite resource budgets fail closed', async () => {
  const valid = input(await source(20, 20));
  for (const options of [{ maxSourceBytes: 1 }, { maxInputPixels: 100 }, { maxOutputBytes: 1 }]) {
    await assert.rejects(new SharpImageRenditionProcessor(options).process(valid), /budget|pixel limit/);
  }
  for (const options of [{ maxInputPixels: 0 }, { maxOutputBytes: Infinity }, { squareCrop: { x: NaN, y: 0, size: 1 } }]) {
    assert.throws(() => new SharpImageRenditionProcessor(options));
  }
  await assert.rejects(new SharpImageRenditionProcessor().process(input(Buffer.from('invalid'))));
  await assert.rejects(new SharpImageRenditionProcessor().process({ ...valid, assetId: '' }));
  await assert.rejects(new SharpImageRenditionProcessor().process({ ...valid, contentType: 'text/plain' }));
});

test('request crops override defaults without cross-request mutation and leave fitted recipes unchanged', async () => {
  const red = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ff0000' } }).png().toBuffer();
  const blue = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#0000ff' } }).png().toBuffer();
  const bytes = await sharp({ create: { width: 16, height: 8, channels: 3, background: '#000000' } }).composite([
    { input: red, left: 0, top: 0 }, { input: blue, left: 8, top: 0 }
  ]).png().toBuffer();
  const processor = new SharpImageRenditionProcessor({ squareCrop: { x: 0, y: 0, size: 8 } });
  const crop = { x: 8, y: 0, size: 8 };
  const rightPromise = processor.process({ ...input(bytes), squareCrop: crop });
  crop.x = 0; crop.size = 1;
  const [right, left] = await Promise.all([rightPromise, processor.process(input(bytes))]);
  assert.equal(right.metadata.squareCropX, 8); assert.equal(right.metadata.squareCropSize, 8);
  assert.equal(left.metadata.squareCropX, 0); assert.equal(left.metadata.squareCropSize, 8);
  for (let i = 0; i < 4; i++) assert.deepEqual(right.renditions[i].body, left.renditions[i].body);
  const rightPixel = await sharp(right.renditions[4].body).resize(1, 1).raw().toBuffer();
  const leftPixel = await sharp(left.renditions[4].body).resize(1, 1).raw().toBuffer();
  assert.ok(rightPixel[2] > 240 && rightPixel[0] < 15);
  assert.ok(leftPixel[0] > 240 && leftPixel[2] < 15);
  for (const squareCrop of [{ x: NaN, y: 0, size: 1 }, { x: 0, y: 0 }, { x: 0, y: Infinity, size: 1 }]) {
    await assert.rejects(processor.process({ ...input(bytes), squareCrop }), /Invalid square crop/);
  }
});
