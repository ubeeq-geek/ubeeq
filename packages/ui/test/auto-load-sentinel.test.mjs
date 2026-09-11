import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AutoLoadSentinel } from '../dist/react.js';

test('load-more control exposes caller labels, loading state, and no implicit form submission', () => {
  const props = { enabled: true, loading: false, onLoadMore() {}, className: 'product-layout', loadLabel: 'Next page', loadingLabel: 'Fetching' };
  const render = patch => renderToStaticMarkup(createElement(AutoLoadSentinel, { ...props, ...patch }));
  assert.equal(render({ enabled: false }), '');
  assert.match(render({}), /class="product-layout"/);
  assert.match(render({}), /type="button"[^>]*>Next page/);
  assert.match(render({ loading: true }), /disabled=""[^>]*>Fetching/);
});

test('intersection lifecycle gates automatic loading and preserves manual fallback', async () => {
  const code = await readFile(new URL('../dist/auto-load-sentinel.js', import.meta.url), 'utf8');
  let effect, callback, observed, disconnected = 0, calls = 0, margin;
  const ref = { current: {} }, module = { exports: {} };
  const context = { module, exports: module.exports, IntersectionObserver: class {
    constructor(cb, options) { callback = cb; margin = options.rootMargin; }
    observe(node) { observed = node; }
    disconnect() { disconnected++; }
  }, require(name) {
    if (name === 'react') return { useRef: () => ref, useEffect: fn => { effect = fn; } };
    if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }) };
    throw new Error(name);
  } };
  vm.runInNewContext(code, context);
  const render = patch => module.exports.AutoLoadSentinel({ enabled: true, loading: false, onLoadMore: () => { calls++; }, ...patch });
  render({ rootMargin: '100px' }); const cleanup = effect();
  assert.equal(observed, ref.current); assert.equal(margin, '100px');
  callback([{ isIntersecting: false }]); assert.equal(calls, 0);
  callback([{ isIntersecting: true }, { isIntersecting: true }]); assert.equal(calls, 1);
  cleanup(); assert.equal(disconnected, 1);
  render({ loading: true }); assert.equal(effect(), undefined);
  assert.equal(render({ enabled: false }), null); assert.equal(effect(), undefined);
  context.IntersectionObserver = undefined;
  const tree = render({}); assert.equal(effect(), undefined);
  tree.props.children.props.onClick(); assert.equal(calls, 2);
});
