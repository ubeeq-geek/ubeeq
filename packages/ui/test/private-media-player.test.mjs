import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createPrivateMediaPlayback } from '../dist/index.js';
import { PrivateMediaPlayer } from '../dist/react.js';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
const copy = { initial: 'Private media', loading: 'Loading', loaded: 'Loaded', loadError: 'Load failed', playbackError: 'Unsupported codec', button: 'Load', label: 'Private player' };
test('private player renders accessible controls without a request or source', () => {
  const html = renderToStaticMarkup(createElement(PrivateMediaPlayer, { kind: 'video', copy, caption: '<caption>', load: async () => { assert.fail('must not load'); } }));
  assert.match(html, /preload="none"/); assert.match(html, /&lt;caption&gt;/);
  assert.doesNotMatch(html, /src=|autoplay/i);
});
test('private player deduplicates, retries failed downloads and disposes late audio/video results', async () => {
  const code = await readFile(new URL('../dist/private-media-player.js', import.meta.url), 'utf8');
  for (const kind of ['audio', 'video']) for (const late of [false, true]) {
    const refs = [], states = [], allocated = [], revoked = [];
    let ri = 0, si = 0, effect, finish, reject, downloads = 0;
    const module = { exports: {} };
    const react = { createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
      useRef: initial => refs[ri++] ||= { current: initial },
      useState: initial => { const index = si++; if (!(index in states)) states[index] = initial; return [states[index], value => { states[index] = value; }]; },
      useEffect: callback => { effect = callback; } };
    vm.runInNewContext(code, { module, exports: module.exports, require: name => name === 'react' ? react : {
      createPrivateMediaPlayback: load => createPrivateMediaPlayback(load, { createObjectURL: blob => { allocated.push(blob); return 'blob:private'; }, revokeObjectURL: url => revoked.push(url) })
    } });
    const load = () => { downloads++; return new Promise((resolve, fail) => { finish = resolve; reject = fail; }); };
    const render = () => { ri = si = 0; return module.exports.PrivateMediaPlayer({ kind, copy, load }); };
    let tree = render();
    const element = { pause() { this.paused = true; }, removeAttribute(name) { this.removed = name; }, load() { this.reloaded = true; } };
    tree.children[2].props.ref.current = element;
    const dispose = effect(); assert.equal(downloads, 0);
    const failed = tree.children[0].props.onClick(); reject('failure'); await failed;
    tree = render(); assert.equal(tree.children[1].children[0], copy.loadError); assert.equal(tree.children[0].props.disabled, false);
    const pending = tree.children[0].props.onClick(); await tree.children[0].props.onClick(); assert.equal(downloads, 2);
    if (late) dispose();
    const before = [...states]; finish(new Blob(['media'])); await pending;
    if (late) assert.deepEqual(states, before);
    else {
      tree = render(); assert.equal(tree.children[2].type, kind); assert.equal(tree.children[2].props.src, 'blob:private');
      tree.children[2].props.onError(); tree = render(); assert.equal(tree.children[1].children[0], copy.playbackError);
      dispose();
    }
    assert.equal(allocated.length, late ? 0 : 1); assert.deepEqual(revoked, late ? [] : ['blob:private']);
    assert.equal(element.paused, true); assert.equal(element.removed, 'src'); assert.equal(element.reloaded, true);
  }
});
