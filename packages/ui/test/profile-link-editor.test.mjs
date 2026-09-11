import test from 'node:test';
import assert from 'node:assert/strict';
import { createProfileLinkEditor } from '../dist/index.js';

export function fakeDocument() {
  const document = { createElement: tag => ({ tag, ownerDocument: document, children: [], events: {}, attributes: {},
    append(...items) { items.forEach(item => { item.parent = this; this.children.push(item); }); },
    replaceChildren(...items) { this.children = []; this.append(...items); },
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(name, callback) { this.events[name] = callback; },
    remove() { this.parent.children = this.parent.children.filter(item => item !== this); },
    focus() { document.activeElement = this; }
  }) };
  return document;
}
test('link fields preserve arbitrary text, draft edits, order and configured limits', () => {
  const document = fakeDocument(), panel = document.createElement('section');
  const editor = createProfileLinkEditor({ panel, maxLinks: 2, maxLabelLength: 200, maxUrlLength: 2048 });
  const source = [{ label: 'Art | writing <b>', url: 'https://example.test/?a=1|2' }];
  editor.setValue(source); source[0].label = 'mutated';
  const [list, count, add] = panel.children;
  assert.equal(list.children[0].children[0].children[0].value, 'Art | writing <b>');
  assert.equal(list.children[0].children[0].children[0].maxLength, 200);
  assert.equal(list.children[0].children[1].children[0].type, 'url');
  add.events.click(); assert.equal(add.disabled, true); assert.equal(list.children.length, 2);
  add.events.click(); assert.equal(list.children.length, 2);
  const second = list.children[1];
  assert.equal(document.activeElement, second.children[0].children[0]);
  second.children[0].children[0].value = 'Second'; second.children[1].children[0].value = 'https://second.test';
  assert.equal(editor.getValue()[1].label, 'Second');
  list.children[0].children[2].events.click();
  assert.equal(add.disabled, false); assert.equal(count.textContent, '1 of 2 links');
  assert.equal(second.children[0].children[0].attributes['aria-label'], 'External link 1 label');
  const draft = editor.getValue(); draft[0].label = 'changed'; assert.equal(editor.getValue()[0].label, 'Second');
  editor.setValue([]); assert.deepEqual(editor.getValue(), []); assert.equal(list.children.length, 0);
});
test('retained links are never truncated if a product lowers its limit', () => {
  const panel = fakeDocument().createElement('section');
  const editor = createProfileLinkEditor({ panel, maxLinks: 1, maxLabelLength: 20, maxUrlLength: 100 });
  const links = [{ label: 'First', url: 'https://one.test' }, { label: 'Second', url: 'https://two.test' }];
  editor.setValue(links); assert.deepEqual(editor.getValue(), links); assert.equal(panel.children[2].disabled, true);
});
