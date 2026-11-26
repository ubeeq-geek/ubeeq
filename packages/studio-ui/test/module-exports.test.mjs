import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

test('ES module and CommonJS consumers receive functional public views', async () => {
  const esm = await import('@ubeeq/studio-ui');
  const cjs = createRequire(import.meta.url)('@ubeeq/studio-ui');
  for (const exports of [esm, cjs]) {
    assert.equal(typeof exports.StudioBrandProvider, 'function');
    const html = renderToStaticMarkup(React.createElement(exports.StudioBrandProvider, { brand: { studioName: 'Example Studio' } }, React.createElement(exports.WorksView, { works: [] })));
    assert.match(html, /Example Studio/);
    assert.match(html, /No works found/);
  }
});
