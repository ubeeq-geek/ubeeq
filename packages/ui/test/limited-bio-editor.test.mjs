import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LimitedBioEditor } from '../dist/react.js';
import { sanitizeProfileBio, profileBioToText } from '../dist/index.js';

test('shared bio editor renders formatting controls and product limits', () => {
  const html = renderToStaticMarkup(createElement(LimitedBioEditor, {
    value: 'Hello', maxLength: 80, placeholder: 'Product prompt', onChange() { assert.fail(); }
  }));
  assert.match(html, /role="textbox"/);
  assert.match(html, /aria-multiline="true"/);
  assert.match(html, /aria-label="Bold"/);
  assert.match(html, /aria-label="Italic"/);
  assert.match(html, /aria-label="Underline"/);
  assert.match(html, /data-placeholder="Product prompt"/);
  assert.match(html, /5 \/ 80/);
});

test('shared editor synchronizes unfocused content, rejects overflow and pastes plain text', async () => {
  const code = await readFile(new URL('../dist/limited-bio-editor.js', import.meta.url), 'utf8');
  const ref = { current: null }, changes = [], commands = [];
  let effect;
  const editor = { innerHTML: '', focus() { document.activeElement = this; } };
  const document = { activeElement: null, execCommand(command, _show, text) {
    commands.push([command, text]);
    if (command === 'insertText') editor.innerHTML += text;
  } };
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useRef: () => ref, useEffect: callback => { effect = callback; }
  };
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, document,
    require(name) {
      if (name === 'react') return react;
      if (name === 'react/jsx-runtime') {
        const jsx = (type, props) => ({ type, props, children: Array.isArray(props.children) ? props.children : [props.children] });
        return { jsx, jsxs: jsx };
      }
      if (name === './profile-bio.js') return { sanitizeProfileBio, profileBioToText };
      throw new Error(name);
    }
  });
  const tree = module.exports.LimitedBioEditor({ value: 'Hello', maxLength: 8, onChange: value => changes.push(value) });
  const input = tree.children[1];
  input.props.ref(editor);
  assert.equal(editor.innerHTML, 'Hello');
  editor.innerHTML = 'draft'; document.activeElement = editor; effect();
  assert.equal(editor.innerHTML, 'draft');
  document.activeElement = null; effect(); assert.equal(editor.innerHTML, 'Hello');
  editor.innerHTML = 'Allowed'; input.props.onInput(); assert.deepEqual(changes, ['Allowed']);
  editor.innerHTML = 'Too many characters'; input.props.onBlur();
  assert.equal(editor.innerHTML, 'Hello'); assert.equal(changes.length, 1);
  let prevented = 0;
  input.props.onPaste({ preventDefault() { prevented++; }, clipboardData: { getData(type) {
    assert.equal(type, 'text/plain'); return '!';
  } } });
  assert.equal(prevented, 1); assert.equal(changes.at(-1), 'Hello!');
  for (const [index, command] of ['bold', 'italic', 'underline'].entries()) {
    const button = tree.children[0].children[index];
    button.props.onMouseDown({ preventDefault() { prevented++; } });
    button.props.onClick();
    assert.equal(document.activeElement, editor);
    assert.equal(commands.at(-1)[0], command);
  }
  assert.equal(prevented, 4);
  assert.deepEqual(commands[0], ['insertText', '!']);
});
