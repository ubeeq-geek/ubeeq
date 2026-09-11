import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProfileAvatar } from '../dist/react.js';

const render = props => renderToStaticMarkup(createElement(ProfileAvatar, { fallbackPalette: ['red', 'white', 'blue'], ...props }));
test('profile avatar preserves image semantics and escapes caller text', () => {
  assert.equal(render({ src: '/image.png', alt: 'A & B', className: 'avatar' }), '<img class="avatar" src="/image.png" alt="A &amp; B"/>');
  assert.equal(render({ src: '/image.png' }), '<img class="" src="/image.png" alt=""/>');
});
test('profile fallback uses caller colors and distinguishes meaningful and decorative content', () => {
  const meaningful = render({ alt: 'Creator profile', className: 'avatar' });
  assert.match(meaningful, /class="avatar ubeeq-profile-fallback"/);
  assert.match(meaningful, /--profile-avatar-outer:red;--profile-avatar-inner:white;--profile-avatar-core:blue/);
  assert.match(meaningful, /role="img" aria-label="Creator profile"/);
  assert.match(meaningful, /class="ubeeq-profile-fallback-mark" aria-hidden="true"/);
  const decorative = render({});
  assert.match(decorative, /class="ubeeq-profile-fallback"/);
  assert.doesNotMatch(decorative, /role=|aria-label=/);
  assert.equal((decorative.match(/aria-hidden="true"/g) || []).length, 2);
});
