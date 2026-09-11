import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProfileCoverPicker } from '../dist/react.js';
const options = [{ id: 'one', label: 'First', url: '/one.jpg' }, { id: 'two', label: 'Second', url: '/two.jpg' }];
const props = { options, selectedPreset: 'one', previewUrl: '/one.jpg', title: 'Assigned', description: 'Caller description', onChange() {} };
test('cover picker renders caller metadata and no control for an empty catalogue', () => {
  assert.equal(renderToStaticMarkup(createElement(ProfileCoverPicker, { ...props, options: [] })), '');
  const html = renderToStaticMarkup(createElement(ProfileCoverPicker, props));
  assert.match(html, /aria-expanded="false"/); assert.match(html, /First/);
  assert.match(html, /Caller description/); assert.match(html, /src="\/one.jpg" alt=""/);
});
test('cover picker opens, selects, closes and blocks selection while disabled', async () => {
  const code = await readFile(new URL('../dist/profile-cover-picker.js', import.meta.url), 'utf8');
  let open = false; const selected = [], module = { exports: {} };
  const jsx = (type, props) => ({ type, props });
  vm.runInNewContext(code, { module, exports: module.exports, require(name) {
    if (name === 'react') return { useState: () => [open, value => { open = typeof value === 'function' ? value(open) : value; }] };
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
    throw new Error(name);
  } });
  const render = patch => module.exports.ProfileCoverPicker({ ...props, onChange: id => selected.push(id), ...patch });
  let tree = render(); tree.props.children[0].props.onClick(); assert.equal(open, true);
  tree = render(); const list = tree.props.children[1];
  assert.equal(list.props.role, 'listbox');
  assert.equal(list.props.children[0].props['aria-selected'], true);
  list.props.children[1].props.onClick(); assert.deepEqual(selected, ['two']); assert.equal(open, false);
  open = true; tree = render({ disabled: true });
  assert.equal(tree.props.children[0].props.disabled, true);
  for (const option of tree.props.children[1].props.children) { assert.equal(option.props.disabled, true); option.props.onClick(); }
  assert.deepEqual(selected, ['two']); assert.equal(open, true);
});
