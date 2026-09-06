import test from 'node:test';
import assert from 'node:assert/strict';
import { pickSquareCrop, pickCoverCrop } from '../dist/index.js';

test('square crop centers by default and clamps explicit pixel coordinates', () => {
  assert.deepEqual(pickSquareCrop(100, 50), { x: 25, y: 0, size: 50 });
  assert.deepEqual(pickSquareCrop(100, 50, { x: -8, y: 500, size: 20.9 }), { x: 0, y: 30, size: 20 });
  assert.deepEqual(pickSquareCrop(100, 50, { x: 10, y: 10, size: 1000 }), { x: 10, y: 0, size: 50 });
  assert.throws(() => pickSquareCrop(0, 50));
  assert.throws(() => pickSquareCrop(100, 50, { x: NaN, y: 0, size: 1 }));
});

test('cover crop follows focal point, preserves requested rectangles and never rounds to zero pixels', () => {
  assert.deepEqual(pickCoverCrop(100, 50, 10, 10, { x: 1, y: 0 }), { x: 50, y: 0, width: 50, height: 50 });
  assert.deepEqual(pickCoverCrop(100, 50, 10, 10, { x: 0.5, y: 0.5 }, { x: 90, y: -10, width: 30, height: 20 }), { x: 70, y: 0, width: 30, height: 20 });
  assert.deepEqual(pickCoverCrop(1, 1000, 1000, 1, { x: 0.5, y: 0.5 }), { x: 0, y: 500, width: 1, height: 1 });
  assert.throws(() => pickCoverCrop(100, 50, 10, 0, { x: 0.5, y: 0.5 }));
  assert.throws(() => pickCoverCrop(100, 50, 10, 10, { x: Infinity, y: 0.5 }));
});
