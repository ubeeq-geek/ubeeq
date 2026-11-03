import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const moduleName = process.env.BROWSER_TEST_PLAYWRIGHT ? pathToFileURL(process.env.BROWSER_TEST_PLAYWRIGHT).href : 'playwright-core';
const { chromium } = await import(moduleName);
const root = fileURLToPath(new URL('../', import.meta.url));
const extension = resolve(root, 'dist/chromium'), profile = await mkdtemp(join(tmpdir(), 'browser-extension-smoke-'));
const context = await chromium.launchPersistentContext(profile, { executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, ignoreDefaultArgs: ['--disable-extensions'],
  args: ['--no-sandbox', '--enable-unsafe-extension-debugging', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
try {
  let worker = context.serviceWorkers()[0];
  if (!worker) {
    try { worker = await context.waitForEvent('serviceworker', { timeout: 3000 }); }
    catch {
      const cdp = await context.browser().newBrowserCDPSession();
      await cdp.send('Extensions.loadUnpacked', { path: extension });
      worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 10000 });
    }
  }
  const id = new URL(worker.url()).host, panel = await context.newPage();
  const errors = []; panel.on('pageerror', error => errors.push(error.message));
  await panel.goto(`chrome-extension://${id}/panel.html`);
  await panel.locator('#useApproval').waitFor();
  assert.equal(await panel.locator('#pair').isVisible(), true);
  // Exercise provider detection using mocked HTML in a real browser; no real provider account is touched.
  const source = await context.newPage();
  await source.route('https://www.deviantart.com/**', route => route.fulfill({ contentType: 'text/html', body: '<header>Signed in as another account</header><a href="/artist/art/First-100"><img alt="First artwork"></a><a href="/artist/art/First-100">Duplicate</a><a href="/someone-else/art/Other-101">Other author</a>' }));
  await source.goto('https://www.deviantart.com/artist/gallery');
  const { readFile } = await import('node:fs/promises');
  const detect = await readFile(resolve(extension, 'detect.js'), 'utf8');
  const detected = await source.evaluate(detect);
  assert.equal(detected.authenticatedAccount, null); assert.equal(detected.accountId, 'artist'); assert.equal(detected.items.length, 1); assert.equal(detected.items[0].remoteId, '100');
  // Native extension storage and accessible disconnect modal work under the extension CSP.
  await worker.evaluate(async () => chrome.storage.local.set({ connection: { origin: 'https://api.example', webOrigin: 'https://app.example', studioName: 'Creator Workspace', creatorId: 'creator', applicationCode: 'UB' } }));
  await panel.reload(); await panel.locator('#disconnect').click();
  assert.equal(await panel.locator('#disconnectDialog').isVisible(), true);
  assert.equal(await panel.locator('#keep').evaluate(element => document.activeElement === element), true);
  await panel.locator('#keep').click(); assert.equal(await panel.locator('#disconnectDialog').isVisible(), false);
  assert.deepEqual(errors, []);
  console.log(`PASS Chromium ${context.browser().version()}: extension load, panel CSP, public-author separation, bounded detection, duplicate exclusion, accessible dialog.`);
} finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
