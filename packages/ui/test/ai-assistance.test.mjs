import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { AiAction, AiAssistanceProvider, TitlePolishControl, titleDiff } from '../dist/ai-assistance.js';
const require = createRequire(import.meta.url);
const enabled = { enabled: true, showAiAssistance: true, generation: 1 };
test('AI surfaces are absent without an enabled capability and preference', () => {
  for (const value of [undefined, { ...enabled, enabled: false }, { ...enabled, showAiAssistance: false }]) {
    const action = createElement(AiAction, { onClick: () => assert.fail() });
    const control = createElement(TitlePolishControl, { title: 'title', titleId: 'id', client: {}, onApply: () => assert.fail() });
    const content = createElement('div', {}, action, control);
    assert.equal(renderToStaticMarkup(value ? createElement(AiAssistanceProvider, { value }, content) : content), '<div></div>');
  }
});
test('shared action has explicit AI label, decorative sparkles, keyboard semantics and pending copy', () => {
  const html = renderToStaticMarkup(createElement(AiAssistanceProvider, { value: enabled }, createElement(AiAction, { onClick() {} })));
  assert.match(html, /aria-label="Polish title with AI"/); assert.match(html, /aria-hidden="true"/); assert.match(html, /Polish title ·/); assert.match(html, />AI</);
  const pending = renderToStaticMarkup(createElement(AiAssistanceProvider, { value: enabled }, createElement(AiAction, { pending: true, onClick() {} })));
  assert.match(pending, /Polishing…/); assert.match(pending, /disabled/);
});
test('comparison emphasizes changed words and preserves multilingual strings', () => {
  const diff = titleDiff('its a trap', 'It’s a Trap');
  assert.deepEqual(diff.original.filter(w => w.changed).map(w => w.text), ['its', 'trap']);
  assert.equal(titleDiff('你好 世界', '你好，世界').suggestion.map(w => w.text).join(''), '你好，世界');
});
function harness() {
  const states = [], refs = [], effects = []; let si = 0, ri = 0, ei = 0;
  let props, tree, changed = false, finish;
  const applied = [], calls = [];
  const react = {
    createContext: () => ({}), useContext: () => enabled,
    useRef: initial => refs[ri++] ??= { current: initial },
    useState: initial => { const i = si++; if (!(i in states)) states[i] = initial; return [states[i], value => { const next = typeof value === 'function' ? value(states[i]) : value; if (next !== states[i]) changed = true; states[i] = next; }]; },
    useEffect: (callback, deps) => { const i = ei++, old = effects[i]; if (!old || deps.some((d, i) => d !== old.deps[i])) effects[i] = { deps, callback, cleanup: old?.cleanup, pending: true }; }
  };
  const module = { exports: {} };
  vm.runInNewContext(readFileSync(new URL('../dist/ai-assistance.js', import.meta.url), 'utf8'), { module, exports: module.exports, require: name => name === 'react' ? react : require(name), AbortController, Error });
  const client = { availability: async () => ({ available: true, remaining: 3, permitted: true }), polish: async (...args) => { calls.push(args); return new Promise(resolve => { finish = resolve; }); } };
  props = { titleId: 'id', title: 'its a trap', client, onApply: title => applied.push(title) };
  const render = () => {
    si = ri = ei = 0; changed = false;
    const visible = module.exports.TitlePolishControl(props); tree = visible.type(visible.props);
    for (const e of effects) if (e.pending) { e.cleanup?.(); e.pending = false; e.cleanup = e.callback(); }
    return tree;
  };
  const flush = async () => { for (let i = 0; i < 5; i++) { await Promise.resolve(); if (changed) render(); } };
  const walk = value => !value || typeof value !== 'object' ? [] : [value, ...[value.props?.children].flat(Infinity).flatMap(child => walk(child))];
  const nodes = () => walk(tree);
  render();
  return { flush, render, nodes, applied, calls, edit: title => { props = { ...props, title }; render(); }, finish: () => finish({ status: 'changed', suggestion: 'It’s a Trap' }), run: () => nodes().find(n => typeof n.type === 'function' && n.type.name === 'AiAction').props.onClick(), dispose: () => effects.forEach(e => e.cleanup?.()) };
}
test('suggestions require Apply; editing source or unmounting discards in-flight results', async () => {
  const f = harness(); await f.flush();
  f.run(); await f.flush(); assert.equal(f.calls.length, 1); assert.equal(f.applied.length, 0);
  f.finish(); await f.flush();
  const apply = f.nodes().find(n => n.type === 'button' && n.props.children === 'Apply'); assert.ok(apply);
  assert.equal(f.applied.length, 0); apply.props.onClick(); assert.deepEqual(f.applied, ['It’s a Trap']); f.dispose();
  for (const unmount of [false, true]) {
    const g = harness(); await g.flush(); g.run(); await g.flush();
    if (unmount) g.dispose(); else { g.edit('new title'); g.edit('its a trap'); }
    g.finish(); await g.flush();
    assert.equal(g.nodes().filter(n => n.type === 'button' && n.props.children === 'Apply').length, 0); assert.deepEqual(g.applied, []); g.dispose();
  }
});
test('even a captured stale Apply callback cannot overwrite a newer edit', async () => {
  const f = harness(); await f.flush(); f.run(); await f.flush(); f.finish(); await f.flush();
  const apply = f.nodes().find(n => n.type === 'button' && n.props.children === 'Apply');
  f.edit('new title'); apply.props.onClick(); assert.deepEqual(f.applied, []); f.dispose();
});
