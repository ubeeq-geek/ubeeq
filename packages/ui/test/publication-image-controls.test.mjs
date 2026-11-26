import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import { PublicationImageControls, selectPublicationImageModel } from '../dist/react.js';
import { CreatorClient } from '../dist/index.js';
import { inheritedPublicationImageSelection } from '@ubeeq/core';
const model = (publicationId = 'volume') => ({ publicationId, configurationRevision: 2, selection: { ...inheritedPublicationImageSelection(), variant: { mode: 'override', value: 'original' } },
  effective: { variant: 'original', watermark: { text: 'Volume' }, watermarkDormant: true, dimensions: { width: 1000, height: 800 },
    provenance: { variant: { source: 'publication', id: publicationId } }, blockers: [] }, accountLabel: 'Creator account', galleryLabels: ['Premium Volume'], copyLabel: 'Volume' });
const props = () => ({ selectedPublicationId: 'volume', model: model(), variants: [{ value: 'original', label: 'Original', enabled: true },
  { value: 'share', label: 'Share', enabled: true }, { value: 'share-alternate', label: 'Alternate Share', enabled: false }], collections: [],
  onSave: async () => model(), onPreview: async () => {} });
const children = tree => React.isValidElement(tree) ? [tree, ...React.Children.toArray(tree.props.children).flatMap(children)] : [];

test('controls show the actual variant/inheritance, unknown delivery, disabled variants and accessible labels', () => {
  const html = renderToStaticMarkup(React.createElement(PublicationImageControls, props()));
  for (const expected of ['Image version', 'Creator account', 'Premium Volume', 'Original', 'This publication', 'Unknown', 'retained and dormant', 'Save for this publication', 'review and publication']) assert.ok(html.includes(expected), expected);
  assert.match(html, /<option(?=[^>]*value="share-alternate")(?=[^>]*disabled="")[^>]*>/);
  assert.match(html, /<label for=/);
});

test('missing selected identity never falls back to a sibling after refresh', () => {
  assert.equal(selectPublicationImageModel('volume', [model('preview'), model('collection')]), undefined);
  const html = renderToStaticMarkup(React.createElement(PublicationImageControls, { ...props(), model: model('preview') }));
  assert.match(html, /selected publication is unavailable/); assert.equal(html.includes('<form'), false);
});

const formHarness = input => {
  let cursor = 0; const hooks = [];
  const source = new URL('../dist/publication-image-controls.js', import.meta.url), realRequire = createRequire(source), module = { exports: {} };
  const fakeReact = { ...React,
    useId: () => 'image-form',
    useRef(initial) { const index = cursor++; return hooks[index] ??= { current: initial }; },
    useState(initial) {
      const index = cursor++; if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial;
      return [hooks[index], value => { hooks[index] = typeof value === 'function' ? value(hooks[index]) : value; }];
    }, useEffect(effect) { const index = cursor++; if (!(index in hooks)) { hooks[index] = true; effect(); } }
  };
  runInNewContext(readFileSync(source, 'utf8'), { module, exports: module.exports, structuredClone, crypto: webcrypto, Error,
    require: id => id === 'react' ? fakeReact : realRequire(id) });
  let inputProps = input;
  return {
    update(value) { inputProps = value; },
    render() { cursor = 0; const wrapper = module.exports.PublicationImageControls(inputProps); return wrapper.type(wrapper.props); }
  };
};
const flush = () => new Promise(resolve => setImmediate(resolve));

test('duplicate submission is blocked; conflict retains draft and retries the same idempotency key', async () => {
  const input = props(), calls = []; let rejectSave;
  input.onSave = value => { calls.push(value); return new Promise((_, reject) => { rejectSave = reject; }); };
  const harness = formHarness(input);
  let tree = harness.render();
  children(tree).find(e => e.type === 'select' && e.props.id.endsWith('-variant')).props.onChange({ target: { value: 'share' } });
  tree = harness.render(); const form = children(tree).find(e => e.type === 'form');
  form.props.onSubmit({ preventDefault() {} }); form.props.onSubmit({ preventDefault() {} });
  assert.equal(calls.length, 1); assert.equal(calls[0].publicationId, 'volume'); assert.equal(calls[0].expectedConfigurationRevision, 2);
  rejectSave(Error('Image settings changed. Reload this Publication.')); await flush();
  tree = harness.render();
  assert.equal(children(tree).find(e => e.type === 'select' && e.props.id.endsWith('-variant')).props.value, 'share');
  assert.ok(children(tree).some(e => e.props.role === 'alert' && e.props.children.includes('Image settings changed')));
  children(tree).find(e => e.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.equal(calls.length, 2); assert.equal(calls[1].requestId, calls[0].requestId);
  rejectSave(Error('Still unavailable')); await flush();
});

test('external refresh preserves an unsaved draft; explicit reload adopts the current revision', async () => {
  const input = props(), calls = [], harness = formHarness(input);
  let tree = harness.render();
  children(tree).find(e => e.type === 'select' && e.props.id.endsWith('-variant')).props.onChange({ target: { value: 'share' } });
  const newer = { ...model(), configurationRevision: 3 };
  harness.update({ ...input, model: newer, onSave: async value => { calls.push(value); return newer; } });
  tree = harness.render();
  assert.equal(children(tree).find(e => e.type === 'select' && e.props.id.endsWith('-variant')).props.value, 'share');
  assert.ok(children(tree).some(e => e.props.role === 'status' && e.props.children.includes('changed elsewhere')));
  children(tree).find(e => e.type === 'button' && e.props.children === 'Reload saved settings').props.onClick(); await flush();
  tree = harness.render();
  assert.equal(children(tree).find(e => e.type === 'select' && e.props.id.endsWith('-variant')).props.value, 'original');
  children(tree).find(e => e.type === 'form').props.onSubmit({ preventDefault() {} }); await flush();
  assert.equal(calls[0].expectedConfigurationRevision, 3);
});

test('same-origin image client sends explicit encoded IDs and configuration revision with one request key', async () => {
  const calls = [], client = new CreatorClient(async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => model() }; });
  await client.publicationImageSelection('work/id', 'publication/id');
  await client.savePublicationImageSelection('work/id', 'publication/id', { selection: inheritedPublicationImageSelection(), expectedConfigurationRevision: 2, requestId: 'request' });
  assert.match(calls[0].url, /works\/work%2Fid\/publications\/publication%2Fid\/image-selection$/);
  assert.equal(calls[1].init.method, 'PUT'); assert.equal(calls[1].init.headers['idempotency-key'], 'request');
  assert.equal(JSON.parse(calls[1].init.body).expectedConfigurationRevision, 2);
  assert.throws(() => client.publicationImageSelection('work', ''), /explicit Work and Publication/);
});
