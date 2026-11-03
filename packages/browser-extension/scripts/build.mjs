import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
const shared = { manifest_version: 3, name: 'Ubeeq Connect', version: '0.1.0',
  description: 'Connect a creator application and preview selected source references. Provider adapters are experimental.',
  permissions: ['storage', 'activeTab', 'scripting', 'alarms'],
  optional_host_permissions: ['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*'],
  action: { default_title: 'Connect account', default_popup: 'panel.html' },
  content_security_policy: { extension_pages: "script-src 'self'; object-src 'none'; base-uri 'none'" } };
for (const browser of ['chromium', 'firefox']) {
  const target = new URL(`dist/${browser}/`, root);
  await rm(target, { recursive: true, force: true }); await mkdir(target, { recursive: true });
  await cp(new URL('browser/', root), target, { recursive: true });
  const manifest = browser === 'chromium'
    ? { ...shared, background: { service_worker: 'background.js', type: 'module' }, side_panel: { default_path: 'panel.html' }, permissions: [...shared.permissions, 'sidePanel'] }
    : { ...shared, background: { scripts: ['background.js'], type: 'module' }, sidebar_action: { default_panel: 'panel.html', default_title: 'Connect account' },
      browser_specific_settings: { gecko: { id: 'connect@ubeeq.site', strict_min_version: '140.0', data_collection_permissions: { required: ['authenticationInfo', 'websiteContent'] } } } };
  await writeFile(new URL('manifest.json', target), JSON.stringify(manifest, null, 2) + '\n');
}
console.log('Built unpacked Chrome/Edge and Firefox extensions in dist/.');
