import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const detect = await readFile(new URL('../browser/detect.js', import.meta.url), 'utf8');
function inspect(url, anchors = [], wordpress = false) {
  return vm.runInNewContext(detect, { URL, location: { href: url }, document: {
    querySelector: selector => selector === '#wpadminbar' && wordpress ? {} : null,
    querySelectorAll: () => anchors.map(([href, title]) => ({ href, textContent: title, getAttribute: () => null, querySelector: () => null }))
  } });
}
test('DeviantArt author remains an explicitly unverified public source and item count is bounded', () => {
  const result = inspect('https://www.deviantart.com/artist/gallery', Array.from({ length: 70 }, (_, id) => [`https://www.deviantart.com/artist/art/Title-${id}`, `Title ${id}`]));
  assert.equal(result.authenticatedAccount, null); assert.equal(result.items.length, 50); assert.equal(result.sessionScope, 'public_source');
  assert.equal(inspect('https://www.deviantart.com/settings'), null);
  assert.equal(inspect('http://www.deviantart.com/artist/gallery'), null);
});
test('public profile links cannot become account authorization or foreign-author items', () => {
  const result = inspect('https://www.deviantart.com/artist/gallery', [['https://www.deviantart.com/other/art/Other-1', 'Other'], ['https://www.deviantart.com/artist/art/Art-2?x=y', 'Work'], ['https://www.deviantart.com/artist/art/Art-2', 'Duplicate']]);
  assert.equal(result.items.length, 1); assert.equal(result.items[0].sourceUrl, 'https://www.deviantart.com/artist/art/Art-2');
  assert.equal(result.authenticatedAccount, null);
});
test('custom WordPress and Tumblr only offer guided setup, and admin detection preserves subdirectories', () => {
  const wp = inspect('https://site.example/subdirectory/wp-admin/post.php', [], true);
  assert.equal(wp.siteUrl, 'https://site.example/subdirectory'); assert.equal(wp.authenticatedAccount, null);
  assert.equal(inspect('https://site.example/wp-admin/', [], false), null);
  assert.equal(inspect('https://www.tumblr.com/dashboard').provider, 'tumblr');
  assert.equal(inspect('https://artist.tumblr.com/'), null);
});
test('target manifests have no cookie, arbitrary execution, default host or externally-connectable access', async () => {
  for (const family of ['chromium', 'firefox']) {
    const manifest = JSON.parse(await readFile(new URL(`../dist/${family}/manifest.json`, import.meta.url), 'utf8'));
    assert.equal(manifest.manifest_version, 3); assert.equal(manifest.host_permissions, undefined); assert.equal(manifest.externally_connectable, undefined);
    assert.ok(!manifest.permissions.some(value => ['cookies', 'webRequest', 'debugger', 'tabs'].includes(value)));
    assert.equal(manifest.content_scripts, undefined);
    assert.match(manifest.content_security_policy.extension_pages, /script-src 'self'/);
  }
});
