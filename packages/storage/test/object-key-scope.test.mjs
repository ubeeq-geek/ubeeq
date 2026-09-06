import test from 'node:test';
import assert from 'node:assert/strict';
import { isObjectKeyWithinPrefix } from '../dist/index.js';

test('canonical object key containment rejects traversal and prefix collisions', () => {
  const prefix = 'owner/branding';
  assert.equal(isObjectKeyWithinPrefix('owner/branding/profile/source.png', prefix), true);
  assert.equal(isObjectKeyWithinPrefix('owner/branding/profile/source.png', prefix + '/'), true);
  for (const key of ['other/branding/profile/source.png', 'owner/branding-other/file', prefix, prefix + '/',
    '/owner/branding/file', 'owner/branding/../secret', 'owner/branding/./file', 'owner/branding//file',
    'owner/branding/..\\secret', 'owner/branding/%2e%2e/secret', 'owner/branding/%252e%252e/secret', 'owner/branding/file\0']) {
    assert.equal(isObjectKeyWithinPrefix(key, prefix), false, key);
  }
  for (const root of ['', '/owner', '../owner', 'owner//branding', 'owner/%2f']) assert.equal(isObjectKeyWithinPrefix('owner/branding/file', root), false);
});
