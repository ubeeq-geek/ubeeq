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

test('API base validation preserves selected routing prefixes and rejects unsafe URLs', async () => {
  const code = await readFile(new URL('../browser/client.js', import.meta.url), 'utf8');
  const { apiBase } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
  assert.equal(apiBase('https://api.example/tenant/api/'), 'https://api.example/tenant/api');
  assert.equal(apiBase('http://127.0.0.1:5175/local-api'), 'http://127.0.0.1:5175/local-api');
  for (const url of ['http://api.example/api', 'https://user:secret@api.example/api', 'https://api.example/api?token=x', 'https://api.example/api#x', 'https://api.example/api%2Fother', 'https://api.example//api'])
    assert.throws(() => apiBase(url));
});

test('obsolete background errors send the observed revision and cannot overwrite replacement progress', async () => {
  let connection = { token: 'token', jobId: 'job', tabId: 1, profileId: 'profile', containerId: 'default', source: {provider:'deviantart',accountId:'artist'}, progress: {revision:1} };
  let rejectStep, entered;
  const started = new Promise(resolve => { entered=resolve; }), calls=[];
  const sandbox = {
    state:async()=>structuredClone(connection), inspect:async()=>connection.source,
    request:async(_connection,path,body)=>{calls.push({path,body});if(path.endsWith('/step')){entered();return new Promise((_resolve,reject)=>{rejectStep=reject;});}return {};},
    browserApi:{storage:{local:{set:async value=>{connection=value.connection;}}},tabs:{get:async()=>({id:1})},alarms:{create:async()=>{},onAlarm:{addListener(){}}},runtime:{onStartup:{addListener(){}},onMessage:{addListener(){}}}}
  };
  const code = (await readFile(new URL('../browser/background.js', import.meta.url), 'utf8')).replace(/^import[^\n]*\n/, '');
  vm.runInNewContext(code+'\nglobalThis.advance=advance;',sandbox);
  const old=sandbox.advance();await started;
  connection.progress={revision:2,state:'importing'};
  rejectStep(new Error('obsolete request'));await old;
  assert.equal(calls[1].body.revision,1);
  assert.equal(connection.progress.revision,2);assert.equal(connection.error,undefined);
});
