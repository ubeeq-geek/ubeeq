import test from 'node:test';
import assert from 'node:assert/strict';
import { renderGhostLexical, validateGhostLexical } from '../dist/index.js';

test('Ghost content preserves semantic node output and uses caller-owned attribution text', () => {
  const blocks = [{ type: 'paragraph', text: '<literal>& text' }, { type: 'heading', level: 3, text: 'Heading' },
    { type: 'image', src: 'https://images.example/a.jpg', alt: 'Alt', caption: 'Caption' },
    { type: 'code', text: 'const x = 1;' }, { type: 'link', href: 'http://example.com', text: 'Link' }];
  const before = structuredClone(blocks);
  const text = value => ({ type: 'text', version: 1, text: value });
  const link = (url, label) => ({ type: 'paragraph', version: 1, children: [{ type: 'link', version: 1, url, children: [text(label)] }] });
  const expected = { root: { type: 'root', version: 1, children: [
    { type: 'paragraph', version: 1, children: [text('<literal>& text')] },
    { type: 'heading', version: 1, tag: 'h3', children: [text('Heading')] },
    { type: 'image', version: 1, src: 'https://images.example/a.jpg', altText: 'Alt', caption: 'Caption' },
    { type: 'code', version: 1, children: [text('const x = 1;')] },
    link('http://example.com', 'Link'), link('https://canonical.example/work', 'Read the original')
  ] } };
  const rendered = renderGhostLexical(blocks, 'https://canonical.example/work', { canonicalLinkText: 'Read the original' });
  assert.equal(rendered, JSON.stringify(expected));
  assert.equal(validateGhostLexical(rendered), rendered);
  assert.deepEqual(blocks, before);
  assert.equal(JSON.parse(renderGhostLexical([], 'https://example.com')).root.children[0].children[0].children[0].text, 'View the canonical Work');
});

test('Ghost serializer rejects unsafe URL schemes and non-HTTPS images', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,test', 'file:///tmp/file']) {
    assert.throws(() => renderGhostLexical([{ type: 'link', href: url }], 'https://example.com'), /safe HTTP/);
    assert.throws(() => renderGhostLexical([], url), /safe HTTP/);
  }
  assert.throws(() => renderGhostLexical([{ type: 'image', src: 'http://example.com/image' }], 'https://example.com'), /safe HTTP/);
});

test('Ghost validator rejects invalid documents, unsupported nodes and malformed child containers', () => {
  assert.throws(() => validateGhostLexical('{'), /valid JSON/);
  for (const root of [null, [], 'root']) assert.throws(() => validateGhostLexical(JSON.stringify({ root })), /objects/);
  assert.throws(() => validateGhostLexical(JSON.stringify({ root: { type: 'paragraph' } })), /root node/);
  for (const node of [{ type: 'html', html: '<script>bad()</script>' }, { type: 'paragraph', children: {} }, { type: 'image' },
    { type: 'link', url: 'javascript:alert(1)' }, { type: 'image', src: 'http://example.com/image' }]) {
    assert.throws(() => validateGhostLexical(JSON.stringify({ root: { type: 'root', children: [node] } })));
  }
});

test('Ghost legacy validation preserves metadata and compact serialization without claiming full schema sanitization', () => {
  const value = { root: { type: 'root', version: 1, children: [{ type: 'paragraph', version: 1, custom: { retained: true }, children: [{ type: 'text', text: '<literal text>' }] }] } };
  assert.equal(validateGhostLexical(JSON.stringify(value, null, 2)), JSON.stringify(value));
});
