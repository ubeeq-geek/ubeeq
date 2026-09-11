import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { validateProfileExternalLinks } from '../dist/index.js';

test('link validation uses the supplied catalogue and exact domain boundaries', () => {
  const domains = { Portfolio: ['portfolio.test'] };
  const validate = (label, url, custom = true) => validateProfileExternalLinks([{ label, url }], domains, custom);
  assert.deepEqual(validate(' PORTFOLIO ', 'https://user.portfolio.test/path'), []);
  assert.equal(validate('Portfolio', 'https://portfolio.test.attacker.test/').length, 1);
  assert.equal(validate('Portfolio', 'https://notportfolio.test/').length, 1);
  assert.equal(validate('Portfolio', 'javascript:alert(1)').length, 1);
  assert.equal(validate('', 'https://example.test')[0].index, 0);
  assert.equal(validate('Custom', '', true).length, 1);
  assert.equal(validate('Custom', 'not a URL', true).length, 1);
  assert.deepEqual(validate('Custom', 'http://example.test', true), []);
  assert.equal(validate('Custom', 'http://example.test', false).length, 1);
  assert.deepEqual(validateProfileExternalLinks([{ label: 'Portfolio', url: 'https://different.test' }], { Portfolio: ['different.test'] }), []);
});

test('preset editor filters catalogue, edits/removes drafts and obeys custom-link and count settings', async () => {
  const code = await readFile(new URL('../dist/profile-external-links-editor.js', import.meta.url), 'utf8');
  const states = []; let index = 0;
  const jsx = (type, props) => ({ type, props });
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, require(name) {
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
    if (name === 'react') return { useState(initial) { const slot = index++; states[slot] ??= initial; return [states[slot], value => { states[slot] = value; }]; } };
    throw new Error(name);
  } });
  const nodes = tree => !tree || typeof tree !== 'object' ? [] : Array.isArray(tree) ? tree.flatMap(nodes) : [tree, ...nodes(tree.props?.children)];
  const changes = [];
  const props = { value: [{ label: 'Portfolio', url: 'https://portfolio.test' }], onChange: value => changes.push(value), maxLinks: 2,
    maxLabelLength: 80, maxUrlLength: 1000, linkPresetGroups: [{ label: 'Art', links: ['Portfolio'] }, { label: 'Audio', links: ['Music'] }], invalidIndexes: [0] };
  const render = (patch = {}) => { index = 0; return nodes(module.exports.ProfileExternalLinksEditor({ ...props, ...patch })); };
  const find = (items, key, value) => items.find(item => item.props?.[key] === value);
  let tree = render();
  const label = find(tree, 'aria-label', 'External link 1 label');
  assert.equal(label.props['aria-invalid'], true); assert.equal(label.props.maxLength, 80);
  label.props.onChange({ target: { value: 'New label' } }); assert.equal(changes.at(-1)[0].label, 'New label');
  assert.equal(props.value[0].label, 'Portfolio');
  find(tree, 'aria-label', 'Remove Portfolio').props.onClick(); assert.equal(changes.at(-1).length, 0);
  find(tree, 'children', 'Music').props.onClick(); assert.equal(changes.at(-1)[1].label, 'Music');
  find(tree, 'aria-label', 'Filter external link platforms').props.onChange({ target: { value: ' mus ' } });
  tree = render(); assert.ok(find(tree, 'children', 'Music')); assert.equal(find(tree, 'children', 'Portfolio'), undefined);
  find(tree, 'aria-label', 'Filter external link platform category').props.onChange({ target: { value: 'Art' } });
  tree = render(); assert.ok(find(tree, 'children', 'No platforms match this filter.'));
  states[0] = ''; states[1] = 'all';
  tree = render({ allowCustom: false, maxLinks: 1 });
  assert.equal(find(tree, 'aria-label', 'External link 1 label').props.readOnly, true);
  assert.equal(find(tree, 'children', '+ Custom URL'), undefined);
  const preset = find(tree, 'children', 'Music'); assert.equal(preset.props.disabled, true);
  const before = changes.length; preset.props.onClick(); assert.equal(changes.length, before);
});
