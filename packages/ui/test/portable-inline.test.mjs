import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeInlineHtml, inlineHtmlToText } from '../dist/index.js';

test('portable inline formatting is normalized, inert and idempotent', () => {
  const input = '<b class=x>Bold &amp; bright</b><i>Italic</i><u>Under</u><strike>Gone</strike><code>&lt;x&gt;</code><br><a href="https://example.test/?a=1&amp;b=2" onclick="bad()">Link</a>';
  const html = sanitizeInlineHtml(input);
  assert.match(html, /<strong>Bold &amp; bright<\/strong><em>Italic<\/em>/);
  assert.match(html, /<s>Gone<\/s><code>&lt;x&gt;<\/code><br>/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.doesNotMatch(html, /onclick|class=/);
  assert.equal(sanitizeInlineHtml(html), html);
  assert.equal(inlineHtmlToText('<strong>A &amp; B</strong><br>&lt;text&gt;'), 'A & B\n<text>');
});

test('malformed markup, foreign content and encoded unsafe links cannot emit active HTML', () => {
  for (const input of [
    '<img src=x onerror=alert(1)><strong>kept</strong>',
    '<svg><a href="javascript:bad()">foreign</a></svg><math><mtext><img src=x onerror=bad()></mtext></math>',
    '<script>alert(1)</script><style>body{display:none}</style><iframe src="https://evil.test">hidden</iframe>',
    '<a href="jav&#x61;script:alert(1)" style="color:red">text</a>',
    '<a href="java&#9;script:alert(1)">text</a><a href="data:text/html,bad">data</a>',
    '<b><i>mismatched</b> content</i><!-- comment --><template><img src=x></template>'
  ]) {
    const html = sanitizeInlineHtml(input);
    assert.doesNotMatch(html, /<(?:script|style|iframe|img|svg|math|template)|onerror|onclick|href="(?:javascript|data):|<!--/i);
    assert.equal(sanitizeInlineHtml(html), html);
  }
});

test('portable sanitization does not depend on DOMParser and rejects oversized input', () => {
  const before = globalThis.DOMParser;
  globalThis.DOMParser = class { constructor() { throw new Error('DOM must not be used'); } };
  try { assert.equal(sanitizeInlineHtml('<b>Same</b>'), '<strong>Same</strong>'); }
  finally { if (before === undefined) delete globalThis.DOMParser; else globalThis.DOMParser = before; }
  assert.throws(() => sanitizeInlineHtml('x'.repeat(1_048_577)), /input budget/);
  assert.throws(() => sanitizeInlineHtml('<br>'.repeat(50_001)), /structure budget/);
});
