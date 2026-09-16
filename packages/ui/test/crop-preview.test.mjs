import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { renderToStaticMarkup } from 'react-dom/server';
import { squareCropFromControls, coverCropFromControls, cropPreviewPoint } from '../dist/index.js';
import { CropCanvas } from '../dist/react.js';

test('percentage crop controls preserve centred and edge selections with bounded zoom', () => {
  const size = { width: 80, height: 40 };
  assert.deepEqual(squareCropFromControls(size, 50, 50, 1), { x: 20, y: 0, size: 40 });
  assert.deepEqual(squareCropFromControls(size, 100, 0, 2), { x: 60, y: 0, size: 20 });
  assert.deepEqual(squareCropFromControls(size, -5, 105, 2), { x: 0, y: 20, size: 20 });
  assert.deepEqual(coverCropFromControls(size, 2400, 900, 100, 0), { x: 0, y: 0, width: 80, height: 30 });
  assert.deepEqual(coverCropFromControls(size, 900, 1200, 100, 0), { x: 50, y: 0, width: 30, height: 40 });
  assert.deepEqual(coverCropFromControls({ width: 1, height: 10000 }, 2400, 900, 50, 50), { x: 0, y: 5000, width: 1, height: 1 });
  assert.deepEqual(size, { width: 80, height: 40 });
});

test('invalid crop controls reject and hidden canvas bounds never emit invalid points', () => {
  for (const zoom of [0, -1, NaN, Infinity]) assert.throws(() => squareCropFromControls({ width: 80, height: 40 }, 50, 50, zoom));
  for (const width of [0, -1, 1.5, Infinity]) assert.throws(() => coverCropFromControls({ width, height: 40 }, 10, 20, 50, 50));
  assert.throws(() => coverCropFromControls({ width: 80, height: 40 }, 0, 20, 50, 50));
  assert.throws(() => squareCropFromControls({ width: 80, height: 40 }, NaN, 50, 1));
  const bounds = { left: 10, top: 20, width: 100, height: 200 };
  assert.deepEqual(cropPreviewPoint(bounds, 60, 120), { x: 0.5, y: 0.5 });
  assert.deepEqual(cropPreviewPoint(bounds, -100, 500), { x: 0, y: 1 });
  assert.equal(cropPreviewPoint({ ...bounds, width: 0 }, 60, 120), undefined);
  assert.equal(cropPreviewPoint(bounds, NaN, 120), undefined);
});

test('shared React crop canvas preserves application styling, dimensions and escaped labels', () => {
  const html = renderToStaticMarkup(React.createElement(CropCanvas, { width: 320, height: 180, className: 'product-crop', label: '<Crop>' }));
  assert.match(html, /width="320"/); assert.match(html, /height="180"/);
  assert.match(html, /class="product-crop"/); assert.match(html, /aria-label="&lt;Crop&gt;"/);
});

test('canvas draws the selected rectangle, clears removed images and guards pointer input', () => {
  const calls = [], effects = [], points = [];
  let bounds = { left: 10, top: 20, width: 100, height: 200 };
  const canvas = {
    getContext: () => ({ clearRect: (...args) => calls.push(['clear', ...args]), drawImage: (...args) => calls.push(['draw', ...args]) }),
    getBoundingClientRect: () => bounds
  };
  const source = new URL('../dist/crop-canvas.js', import.meta.url);
  const realRequire = createRequire(source);
  const module = { exports: {} };
  runInNewContext(readFileSync(source, 'utf8'), { module, exports: module.exports, require: id => id === 'react'
    ? { ...React, useRef: () => ({ current: canvas }), useEffect: effect => effects.push(effect) }
    : realRequire(id) });
  const image = {};
  const props = { image, crop: { x: 4, y: 5, width: 20, height: 30 }, width: 320, height: 180, onPoint: (x, y) => points.push([x, y]) };
  const element = module.exports.CropCanvas(props);
  effects.shift()();
  assert.deepEqual(calls, [['clear', 0, 0, 320, 180], ['draw', image, 4, 5, 20, 30, 0, 0, 320, 180]]);
  const event = { currentTarget: canvas, button: 0, clientX: 60, clientY: 120 };
  element.props.onPointerDown(event);
  element.props.onPointerDown({ ...event, button: 2 });
  bounds = { ...bounds, width: 0 };
  element.props.onPointerDown(event);
  assert.deepEqual(points, [[0.5, 0.5]]);
  module.exports.CropCanvas({ ...props, image: undefined });
  effects.shift()();
  assert.deepEqual(calls.at(-1), ['clear', 0, 0, 320, 180]);
  assert.equal(calls.length, 3);
});
