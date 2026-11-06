/** Loopback-only Chromium acceptance: collection controls, opt-in, music and native MP4 download. */
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createReferenceApi } from '../apps/reference-api/dist/server.js';
import { createReferenceApp } from '../apps/web-reference/src/server.mjs';
import { FfmpegSlideshowRenderer } from '@ubeeq/media-ffmpeg';

const directory = await mkdtemp(join(tmpdir(), 'slideshow-browser-'));
const downloads = join(directory, 'downloads'); await mkdir(downloads);
const ffmpegPath = process.env.TEST_FFMPEG_PATH ?? '/usr/bin/ffmpeg', ffprobePath = process.env.TEST_FFPROBE_PATH ?? '/usr/bin/ffprobe';
const execute = promisify(execFile);
const api = createReferenceApi({ databasePath: join(directory, 'state.sqlite'), dataDirectory: directory, publicBaseUrl: 'http://localhost', cellId: 'cell-a', slideshowRenderer: new FfmpegSlideshowRenderer({ ffmpegPath, ffprobePath, timeoutMs: 30000 }) });
await new Promise(resolve => api.server.listen(0, '127.0.0.1', resolve));
const apiBase = 'http://127.0.0.1:' + api.server.address().port;
const app = createReferenceApp({ referenceApiUrl: apiBase }); await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + app.address().port;
let token = '', browser, socket;
try {
  const request = async (path, body) => {
    const response = await fetch(apiBase + '/v1/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); return result;
  };
  const account = { email: 'browser@example.test', password: 'a-safe-local-password' };
  await request('auth/sign-up', account); token = (await request('auth/sign-in', account)).token;
  await request('creators', { handle: 'browser', displayName: 'Browser fixture' });
  const works = [];
  for (const [index, source] of ['red', 'blue', 'music'].entries()) {
    const audio = source === 'music', path = join(directory, audio ? 'music.wav' : `${source}.png`);
    await execute(ffmpegPath, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', audio ? 'sine=frequency=440:duration=1' : `color=${source}:size=128x96`, ...(audio ? [] : ['-frames:v', '1', '-threads', '1']), '-n', path]);
    const bytes = await readFile(path), checksum = createHash('sha256').update(bytes).digest('hex');
    const work = (await request('works', { title: audio ? 'Music track' : `Image ${index + 1}` })).work; works.push(work.id);
    const upload = (await request('uploads', { workId: work.id, mimeType: audio ? 'audio/wav' : 'image/png', byteLength: bytes.length, checksum })).upload;
    const uploaded = await fetch(apiBase + `/v1/uploads/${upload.uploadId}/content`, { method: 'PUT', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ base64: bytes.toString('base64') }) }); assert.ok(uploaded.ok);
    await request(`uploads/${upload.uploadId}/complete`, { workId: work.id, byteLength: bytes.length, checksum });
    await api.runNextJob('upload-worker');
  }
  const collection = (await request('collections', { title: 'Browser image collection' })).collection;
  const membership = await fetch(apiBase + `/v1/collections/${collection.id}/works`, { method: 'PUT', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ workIds: works.slice(0, 2), expectedRevision: collection.revision }) }); assert.ok(membership.ok);
  browser = spawn(process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', ['--headless', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', '--user-data-dir=' + join(directory, 'profile'), 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = await new Promise((resolve, reject) => {
    let stderr = ''; const timer = setTimeout(() => reject(Error('Chromium endpoint timed out')), 15000);
    browser.stderr.on('data', chunk => { stderr += chunk; const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (match) { clearTimeout(timer); resolve(match[1]); } }); browser.on('error', reject);
  });
  socket = new WebSocket(endpoint); await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let sequence = 0; const pending = new Map(), exceptions = [];
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id) { const item = pending.get(message.id); if (item) { pending.delete(message.id); clearTimeout(item.timer); message.error ? item.reject(Error(JSON.stringify(message.error))) : item.resolve(message.result); } }
    else if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails);
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout: ' + method)); }, 15000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const target = await send('Target.createTarget', { url: 'about:blank' }), { sessionId } = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  const call = (method, params = {}) => send(method, params, sessionId);
  const evaluate = async expression => { const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails)); return result.result.value; };
  const wait = async expression => { const end = Date.now() + 15000; while (Date.now() < end) { if (await evaluate(expression)) return; await new Promise(resolve => setTimeout(resolve, 100)); } throw Error('DOM timeout: ' + expression + '\n' + await evaluate('document.body.innerText')); };
  const click = text => evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent===${JSON.stringify(text)}).click()`);
  await call('Page.enable'); await call('Runtime.enable'); await call('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
  await call('Page.addScriptToEvaluateOnNewDocument', { source: `try{localStorage.setItem('ubeeq.reference.token',${JSON.stringify(token)})}catch{}` });
  await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
  await call('Page.navigate', { url: base + '/collections' }); await wait("!!document.querySelector('[aria-label=\"Slideshow video\"]')");
  assert.equal(await evaluate("document.querySelector('[aria-label=\"Slideshow video\"] input[type=checkbox]').checked"), false);
  assert.equal(await evaluate("Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='Generate video')"), false);
  await evaluate("document.querySelector('[aria-label=\"Slideshow video\"] input[type=checkbox]').click()");
  await wait("Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='Generate video')");
  const setInput = async (label, value) => evaluate(`(()=>{const label=Array.from(document.querySelectorAll('label')).find(l=>l.textContent.startsWith(${JSON.stringify(label)}));const input=label.querySelector('input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await setInput('Slide duration', '0.5'); await setInput('Transition duration', '0.1');
  await evaluate("(()=>{const select=Array.from(document.querySelectorAll('label')).find(l=>l.textContent.startsWith('Video format')).querySelector('select');select.value='square';select.dispatchEvent(new Event('change',{bubbles:true}));})()");
  await click('Add music track');
  await wait("Array.from(document.querySelectorAll('label')).some(l=>l.textContent.trim().startsWith('I have permission'))");
  assert.equal(await evaluate("Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Generate video').disabled"), true);
  await evaluate("Array.from(document.querySelectorAll('label')).find(l=>l.textContent.trim().startsWith('I have permission')).querySelector('input').click()");
  await click('Generate video'); await wait("document.body.textContent.includes('Slideshow queued.')");
  const result = await api.runNextJob('slideshow-worker'); assert.equal(result.rendition.state, 'completed');
  await wait("Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='Download MP4')");
  await click('Download MP4');
  const deadline = Date.now() + 10000;
  while (!(await readdir(downloads)).includes('collection-slideshow.mp4') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  const output = join(downloads, 'collection-slideshow.mp4'); assert.ok((await readFile(output)).length > 1000);
  const { stdout } = await execute(ffprobePath, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', output]);
  const probe = JSON.parse(stdout); assert.equal(probe.streams[0].width, 1080); assert.equal(probe.streams[0].height, 1080); assert.equal(probe.streams.filter(s => s.codec_type === 'audio').length, 1);
  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  assert.ok(await evaluate('Math.max(document.body.scrollWidth,document.documentElement.scrollWidth)<=innerWidth'), 'Collection controls overflow on mobile');
  const screenshot = process.env.UBEEQ_SLIDESHOW_SCREENSHOT ?? '/tmp/ubeeq-slideshow-mobile.png';
  await writeFile(screenshot, (await call('Page.captureScreenshot', { format: 'png' })).data, 'base64');
  await call('Page.reload'); await wait("Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='Download MP4')");
  assert.deepEqual(exceptions, []);
  console.log('Chromium slideshow acceptance passed: explicit opt-in, settings, music permission, background render, authenticated native MP4 download, mobile layout, reload persistence. Screenshot: ' + screenshot);
} finally {
  socket?.close();
  if (browser && browser.exitCode === null && browser.signalCode === null) { browser.kill('SIGKILL'); await new Promise(resolve => browser.once('exit', resolve)); }
  await new Promise(resolve => app.close(resolve)); await api.close(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
