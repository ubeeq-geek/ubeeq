import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BlockPreview } from '../dist/react.js';

const render = (value, mediaOptions = []) => renderToStaticMarkup(createElement(BlockPreview, { value, mediaOptions }));
test('read-only body preview renders structured text without editing or mutating the draft', () => {
  const value = [{ blockId: 'section', type: 'section', title: 'Chapter', blocks: [
    { blockId: 'heading', type: 'heading', level: 3, text: 'Heading' },
    { blockId: 'text', type: 'paragraph', text: '<script>literal</script>' },
    { blockId: 'quote', type: 'quote', quote: 'A quotation', author: 'Author' },
    { blockId: 'rule', type: 'divider' },
    { blockId: 'link', type: 'link', url: 'https://example.test/path', label: 'Visit' },
    { blockId: 'credit', type: 'credit', author: 'Creator', text: 'Attribution' }
  ] }];
  const before = structuredClone(value), html = render(value);
  for (const text of ['Chapter', '<h3>', 'A quotation', '<cite>Author</cite>', '<hr', 'Visit', 'Attribution']) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /<script>|contenteditable|<textarea|<button/);
  assert.deepEqual(value, before);
});

test('preview never embeds block URLs or raw HTML and labels unsupported content', () => {
  const value = [
    { blockId: 'link', type: 'link', url: 'javascript:alert(1)', label: 'Unsafe' },
    { blockId: 'raw', type: 'html_fragment', html: '<iframe src="https://remote.test"></iframe>' },
    { blockId: 'embed', type: 'embed', url: 'https://remote.test/embed' },
    { blockId: 'image', type: 'image', mediaId: 'asset', url: 'https://remote.test/image' }
  ];
  const html = render(value, [{ mediaId: 'asset', label: 'Private image', thumbnailUrl: 'https://remote.test/from-options' }]);
  assert.doesNotMatch(html, /<iframe|<img|href="javascript:|src="https:/);
  assert.match(html, /Unsafe \(link unavailable\)/);
  assert.match(html, /html_fragment block is retained/);
  assert.match(html, /embed block is retained/);
  assert.match(html, /Private image — image preview unavailable/);
});

test('preview uses only supplied object URLs and handles bounded trees and missing media', () => {
  const html = render([{ blockId: 'video', type: 'video', mediaId: 'asset', caption: 'Caption' }, { blockId: 'missing', type: 'file', fileId: 'missing' }],
    [{ mediaId: 'asset', label: 'Video', thumbnailUrl: 'blob:authorized-preview' }]);
  assert.match(html, /src="blob:authorized-preview"/);
  assert.match(html, /Static preview only/);
  assert.match(html, /Media unavailable/);
  let value = [];
  for (let i = 0; i < 100; i++) value = [{ blockId: `nested-${i}`, type: 'section', blocks: value }];
  assert.match(render(value), /role="alert"/);
  assert.match(render([]), /No body content yet/);
});
