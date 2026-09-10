import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeProfileBio, profileBioToText } from '../dist/index.js';

test('biography fallback preserves literal escaping, line breaks and legacy text conversion', () => {
  assert.equal(sanitizeProfileBio(''), ''); assert.equal(profileBioToText(''), '');
  assert.equal(sanitizeProfileBio('<b>A & "B"</b>\r\n\'C\''), '&lt;b&gt;A &amp; &quot;B&quot;&lt;/b&gt;<br>&#039;C&#039;');
  assert.equal(profileBioToText('<b>A &amp; B</b><br/>C'), 'A &amp; B\nC');
});

test('browser-node serialization normalizes permitted tags and discards attributes and unknown elements', () => {
  const saved = Object.fromEntries(['DOMParser', 'Node', 'HTMLElement'].map(key => [key, globalThis[key]]));
  class Element { constructor(tagName, childNodes = []) { this.tagName = tagName; this.childNodes = childNodes; } }
  const text = value => ({ nodeType: 3, textContent: value });
  globalThis.Node = { TEXT_NODE: 3 }; globalThis.HTMLElement = Element;
  globalThis.DOMParser = class { parseFromString(value, type) {
    assert.equal(type, 'text/html'); assert.equal(value, '<body>fixture</body>');
    return { body: { childNodes: [new Element('P', [new Element('B', [text('<safe>')]), new Element('I', [text('&')]), new Element('U', [text('line')]),
      new Element('A', [text('link')]), new Element('IMG'), { nodeType: 8, textContent: 'comment' }]), new Element('BR'), new Element('BR')] } };
  } };
  try { assert.equal(sanitizeProfileBio('fixture'), '<strong>&lt;safe&gt;</strong><em>&amp;</em><u>line</u>link<br><br>'); }
  finally { for (const [key, value] of Object.entries(saved)) if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
});
