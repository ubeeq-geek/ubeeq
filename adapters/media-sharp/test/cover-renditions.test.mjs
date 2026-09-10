import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { renderCoverRenditions, renderImageRendition } from '../dist/index.js';
import { pickCoverCrop } from '@ubeeq/processing';

const source = () => sharp({ create: { width: 80, height: 40, channels: 3, background: '#2255cc' } }).png().toBuffer();
const variants = () => [{ name: 'wide', width: 120, height: 40 }, { name: 'tall', width: 40, height: 80 }];

test('cover set preserves focal and explicit crop recipes with caller-owned names and sizes', async () => {
  const bytes = await source(), choices = variants();
  choices[1].crop = { x: 500, y: -1, width: 20, height: 40 };
  const result = await renderCoverRenditions(bytes, { variants: choices, focalPoint: { x: 2, y: -1 } });
  assert.deepEqual(result.focalPoint, { x: 1, y: 0 });
  assert.equal(result.sourceWidth, 80); assert.equal(result.sourceHeight, 40);
  assert.deepEqual(result.renditions.map(item => item.name), ['wide', 'tall']);
  for (const [index, item] of result.renditions.entries()) {
    const choice = choices[index];
    const crop = pickCoverCrop(80, 40, choice.width, choice.height, { x: 1, y: 0 }, choice.crop);
    assert.deepEqual(item.crop, crop);
    assert.deepEqual(item.body, await renderImageRendition(bytes, { width: choice.width, height: choice.height, crop }));
    assert.equal(item.contentType, 'image/jpeg'); assert.equal(item.byteLength, item.body.byteLength);
    const info = await sharp(item.body).metadata();
    assert.deepEqual([info.width, info.height], [choice.width, choice.height]);
    assert.equal(item.storage, undefined);
  }
});

test('cover source, focal point and nested crop selection are snapshotted before decoder awaits', async () => {
  const bytes = await source();
  const options = { variants: [{ name: 'square', width: 20, height: 20, crop: { x: 5, y: 6, width: 20, height: 20 } }], focalPoint: { x: 0, y: 1 } };
  const expected = await renderCoverRenditions(bytes, options);
  const pending = renderCoverRenditions(bytes, options);
  bytes.fill(0); options.variants[0].crop.x = 50; options.variants[0].width = 99; options.focalPoint.x = 1;
  assert.deepEqual(await pending, expected);
});

test('cover sets reject malformed selections and enforce source, decoder and aggregate output budgets', async () => {
  const bytes = await source();
  for (const options of [
    { variants: [] }, { variants: Array(17).fill(variants()[0]) }, { variants: [variants()[0], variants()[0]] },
    { variants: [{ name: '../path', width: 1, height: 1 }] }, { variants: [{ name: 'bad', width: 0, height: 1 }] },
    { variants: variants(), focalPoint: { x: NaN, y: 0 } },
    ...['maxSourceBytes', 'maxInputPixels', 'maxOutputPixels', 'maxOutputBytes'].flatMap(key => [0, 1].map(value => ({ variants: variants(), [key]: value }))),
    { variants: [...variants(), { name: 'bad-crop', width: 1, height: 1, crop: { x: NaN, y: 0, width: 1, height: 1 } }] }
  ]) await assert.rejects(renderCoverRenditions(bytes, options));
  await assert.rejects(renderCoverRenditions(Buffer.from('not an image'), { variants: variants() }));
  const output = await renderCoverRenditions(bytes, { variants: variants() });
  await assert.rejects(renderCoverRenditions(bytes, { variants: variants(), maxOutputBytes: output.renditions[0].byteLength }), /byte budget/);
  await assert.rejects(renderCoverRenditions(bytes, { variants: variants(), maxOutputPixels: 4800 }), /pixel budget/);
});
