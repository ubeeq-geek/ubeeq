import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const moduleName = process.env.BROWSER_TEST_PLAYWRIGHT ? pathToFileURL(process.env.BROWSER_TEST_PLAYWRIGHT).href : 'playwright-core';
const { chromium } = await import(moduleName);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
try {
  const context = await browser.newContext(), page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const source = { provider: 'deviantart', accountId: 'artist', items: [
      { remoteId: '100', title: 'First <unsafe> artwork', sourceUrl: 'https://www.deviantart.com/artist/art/First-100' },
      { remoteId: '101', title: 'Second artwork', sourceUrl: 'https://www.deviantart.com/artist/art/Second-101' }
    ] };
    let connection = { origin: 'https://api.example', webOrigin: 'https://app.example', studioName: 'Creator Workspace', creatorId: 'creator', applicationCode: 'UB', profileId: 'profile', token: 'fixture' };
    window.chrome = { storage: { local: { get: async () => ({ connection }), set: async data => { connection = data.connection; }, remove: async () => { connection = undefined; } }, onChanged: { addListener() {} } },
      tabs: { query: async () => [{ id: 1 }], get: async () => ({ id: 1 }) }, scripting: { executeScript: async () => [{ result: source }] },
      permissions: { request: async () => false }, runtime: { sendMessage: async () => {} }, alarms: { clear: async () => {} } };
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (url, options) => {
      if (!String(url).startsWith('https://api.example/')) return nativeFetch(url, options);
      const input = options.body ? JSON.parse(options.body) : {};
      if (String(url).endsWith('/preview')) return Response.json({ previewId: 'preview', source, items: source.items });
      if (String(url).endsWith('/jobs')) { window.lastImport = input; return Response.json({ id: 'job', state: 'importing', imported: 0, alreadyPresent: 0, failed: 0, remaining: input.selected.length, total: input.selected.length, items: [] }); }
      return Response.json({ disconnected: true });
    };
  });
  await page.route('https://panel.test/**', async route => {
    const name = new URL(route.request().url()).pathname.slice(1) || 'panel.html';
    const allowed = ['panel.html', 'panel.js', 'panel.css', 'client.js'];
    if (!allowed.includes(name)) return route.abort();
    await route.fulfill({ body: await readFile(new URL(`../browser/${name}`, import.meta.url)), contentType: name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html',
      headers: { 'Content-Security-Policy': "script-src 'self'; object-src 'none'; base-uri 'none'" } });
  });
  await page.goto('https://panel.test/panel.html'); await page.locator('#detect').click();
  assert.match(await page.locator('#source').textContent(), /Signed-in account unverified/);
  await page.locator('#preview').click(); await page.locator('#count').filter({ hasText: '2 selected' }).waitFor(); assert.match(await page.locator('#count').textContent(), /2 selected/);
  assert.equal(await page.locator('#items unsafe').count(), 0);
  await page.locator('#name').fill('First'); assert.match(await page.locator('#count').textContent(), /1 selected/);
  await page.locator('#name').fill(''); assert.match(await page.locator('#count').textContent(), /1 selected/);
  await page.locator('#import').click(); await page.locator('#progress').filter({ hasText: '1 selected' }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.lastImport.selected), ['100']);
  await page.locator('#disconnect').click(); assert.equal(await page.locator('#keep').evaluate(node => document.activeElement === node), true);
  await page.keyboard.press('Escape'); assert.equal(await page.locator('#disconnectDialog').isVisible(), false);
  assert.deepEqual(errors, []);
  const output = process.env.BROWSER_PREVIEW_PATH;
  if (output) { await mkdir(fileURLToPath(new URL('.', pathToFileURL(output))), { recursive: true }); await page.screenshot({ path: output, fullPage: true }); }
  console.log(`PASS Chromium ${browser.version()}: panel module/CSP, source confirmation, preview, filter/selection fencing, structured import, HTML injection prevention, keyboard modal. Extension APIs were mocked; this is not an extension-install qualification.`);
} finally { await browser.close(); }
