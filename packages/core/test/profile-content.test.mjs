import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProfileExternalLinks, sanitizeLimitedRichText, limitedRichTextToPlainText } from '../dist/index.js';

test('profile links preserve explicit product policy and reject forged platform domains', () => {
  const policy = { allowCustom: false, domainsByLabel: { Example: ['example.test'] } };
  const source = [
    { label: 'example', url: 'https://sub.example.test/a' },
    { label: 'Example', url: 'https://example.test.attacker.test/' },
    { label: 'Example', url: 'https://notexample.test/' },
    { label: 'Example', url: 'https://user:secret@example.test/' },
    { label: 'Custom', url: 'https://custom.test/' },
    { label: 'Example', url: 'javascript:alert(1)' },
    null, [], { url: 'not a URL' }
  ];
  assert.deepEqual(normalizeProfileExternalLinks(source, policy), [{ label: 'Example', url: 'https://sub.example.test/a' }]);
  assert.deepEqual(normalizeProfileExternalLinks(source, { ...policy, allowCustom: true }).map(link => link.label), ['Example', 'Custom']);
  assert.deepEqual(normalizeProfileExternalLinks([{ url: 'http://custom.test' }], { allowCustom: true, domainsByLabel: {} }), [{ label: 'custom.test', url: 'http://custom.test/' }]);
  assert.equal(normalizeProfileExternalLinks(Array(20).fill(source[0]), policy).length, 12);
  assert.deepEqual(normalizeProfileExternalLinks(source, { ...policy, maxLinks: 0 }), []);
  assert.deepEqual(normalizeProfileExternalLinks({}, policy), []);
});

test('legacy profile bios preserve limited formatting and escape executable markup', () => {
  assert.equal(sanitizeLimitedRichText('<p><b>Bold</b> <i>italic</i> <u>under</u></p><p>next</p>', 100), '<strong>Bold</strong> <em>italic</em> <u>under</u><br>next');
  assert.equal(sanitizeLimitedRichText('<strong onclick="bad()">name</strong><img src=x onerror=bad()>&lt;script&gt;bad&lt;/script&gt;', 100), 'name</strong>&lt;script&gt;bad&lt;/script&gt;');
  assert.equal(sanitizeLimitedRichText('<a href="javascript:bad()">label</a>', 100), 'label');
  assert.equal(sanitizeLimitedRichText('<strong>abcdef</strong>', 3), '<strong>abc</strong>');
  assert.equal(sanitizeLimitedRichText('   ', 3), undefined);
  assert.equal(limitedRichTextToPlainText('<strong>A &amp; B</strong><br>next'), 'A & B\nnext');
  assert.throws(() => sanitizeLimitedRichText('text', -1), /limit/);
});
