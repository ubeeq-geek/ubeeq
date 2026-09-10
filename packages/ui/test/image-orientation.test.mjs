import test from 'node:test';
import assert from 'node:assert/strict';
import * as node from '../dist/index.js';
import * as browser from '../dist/browser/image-orientation.js';

for (const [target, api] of [['node', node], ['browser', browser]]) {
  test(`${target}: all EXIF rotations/reflections map bounded rectangles and round-trip exactly`, () => {
    const size = { width: 5, height: 3 }, crop = { x: 1, y: 0, width: 2, height: 1 };
    const expected = [[1, 0, 2, 1], [2, 0, 2, 1], [2, 2, 2, 1], [1, 2, 2, 1],
      [0, 1, 1, 2], [2, 1, 1, 2], [2, 2, 1, 2], [0, 2, 1, 2]];
    for (let orientation = 1; orientation <= 8; orientation++) {
      const mapped = api.cropRectToOriented(size, crop, orientation);
      assert.deepEqual(Object.values(mapped), expected[orientation - 1]);
      assert.deepEqual(api.cropRectToSource(size, mapped, orientation), crop);
      const dimensions = api.orientedImageSize(size, orientation);
      assert.deepEqual(dimensions, orientation >= 5 ? { width: 3, height: 5 } : size);
      const full = { x: 0, y: 0, ...size };
      assert.deepEqual(api.cropRectToSource(size, api.cropRectToOriented(size, full, orientation), orientation), full);
      for (let y = 0; y < size.height; y++) for (let x = 0; x < size.width; x++) {
        const pixel = { x, y, width: 1, height: 1 };
        assert.deepEqual(api.cropRectToSource(size, api.cropRectToOriented(size, pixel, orientation), orientation), pixel);
      }
    }
    assert.deepEqual(api.cropRectToOriented(size, crop), crop);
    assert.deepEqual(size, { width: 5, height: 3 });
  });
  test(`${target}: invalid orientation, dimensions and out-of-bounds selections reject`, () => {
    const size = { width: 5, height: 3 }, crop = { x: 0, y: 0, width: 1, height: 1 };
    for (const value of [0, 9, NaN, Infinity, 1.5, '6', null]) assert.throws(() => api.orientedImageSize(size, value));
    for (const width of [0, -1, Infinity, 1.5]) assert.throws(() => api.orientedImageSize({ ...size, width }));
    for (const invalid of [{ ...crop, x: -1 }, { ...crop, x: 5 }, { ...crop, width: 0 }, { ...crop, height: 4 }, { ...crop, x: NaN }, { ...crop, width: Number.MAX_SAFE_INTEGER }])
      assert.throws(() => api.cropRectToOriented(size, invalid, 6));
    assert.throws(() => api.cropRectToSource(size, { x: 3, y: 0, width: 1, height: 1 }, 6));
    assert.deepEqual(api.cropRectToOriented({ width: 1, height: 3 }, { x: 0, y: 0, width: 1, height: 3 }, 6), { x: 0, y: 0, width: 3, height: 1 });
  });
  test(`${target}: upright focal fractions map back without mutation or implicit clamping`, () => {
    const point = { x: 0.2, y: 0.7 };
    const expected = [[0.2, 0.7], [0.8, 0.7], [0.8, 0.3], [0.2, 0.3], [0.7, 0.2], [0.7, 0.8], [0.3, 0.8], [0.3, 0.2]];
    for (let orientation = 1; orientation <= 8; orientation++) {
      const actual = api.orientedFocalPointToSource(point, orientation);
      assert.ok(Math.abs(actual.x - expected[orientation - 1][0]) < 1e-12);
      assert.ok(Math.abs(actual.y - expected[orientation - 1][1]) < 1e-12);
    }
    for (const x of [-0.1, 1.1, NaN, Infinity]) assert.throws(() => api.orientedFocalPointToSource({ x, y: 0.5 }));
    assert.deepEqual(point, { x: 0.2, y: 0.7 });
  });
}
