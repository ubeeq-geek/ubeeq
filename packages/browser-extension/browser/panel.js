import { preparePremiumGalleryForm } from './premium-gallery-form.mjs';
import { browserApi, appOrigin, apiBase, state, request, visibleItems, inspect } from './client.js';
const $ = id => document.getElementById(id);
let connection = await state(), detected, preview, selected = new Set(), busy = false;
function displayGallerySetup() {
  const setup = connection?.gallerySetup;
  $('gallerySteps').hidden = !setup;
  if (!setup) return;
  $('gallerySummary').textContent = `${setup.account.username} · ${setup.name} · proposed USD ${(setup.priceCents / 100).toFixed(2)} · Creator ${connection.creatorName || connection.creatorId}`;
  $('galleryManager').href = setup.galleryUrl;
  if (setup.state === 'access_verified') $('galleryVerified').textContent = 'Premium access type and account verified through the API. The price has not been verified by the API; confirm it on DeviantArt. No publishing destination has been selected.';
}
function display() {
  displayGallerySetup();
  $('pair').hidden = Boolean(connection); $('connected').hidden = !connection;
  $('heading').textContent = connection ? `Connect to ${connection.studioName}` : 'Connect account';
  $('destination').textContent = connection ? `${connection.studioName} · Creator Identity ${connection.creatorName || connection.creatorId} · ${connection.applicationCode}` : '';
  $('error').textContent = connection?.error || '';
  if (connection?.source) $('source').textContent = `${connection.source.provider} public source: ${connection.source.accountId} · Signed-in account unverified.`;
  const progress = connection?.progress;
  $('progressSection').hidden = !progress && !connection?.pendingStart;
  if (progress) {
    $('progress').textContent = `${progress.state}: ${progress.imported} imported, ${progress.alreadyPresent} already present, ${progress.failed} failed, ${progress.remaining} remaining of ${progress.total} selected.`;
    $('results').replaceChildren();
    for (const item of progress.items.filter(row => row.workId)) {
      const link = document.createElement('a');
      link.href = `${connection.webOrigin}/studio/workspace?creatorId=${encodeURIComponent(connection.creatorId)}&section=works&workId=${encodeURIComponent(item.workId)}`;
      link.target = '_blank'; link.rel = 'noreferrer'; link.textContent = `Open imported Work ${item.remoteId}`;
      $('results').append(link, document.createElement('br'));
    }
  }
}
async function run(fn) {
  if (busy) return; busy = true; $('error').textContent = '';
  document.querySelectorAll('button').forEach(button => { button.disabled = true; });
  try { await fn(); } catch (error) { ($('disconnectDialog').open ? $('dialogError') : $('error')).textContent = error.message; }
  finally { if (connection?.pendingStart) $('progressSection').hidden = false; busy = false; document.querySelectorAll('button').forEach(button => { button.disabled = false; }); }
}
const save = async () => browserApi.storage.local.set({ connection });
$('useApproval').onclick = () => run(async () => {
  const [tab] = await browserApi.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('Open the application’s approved browser connection page.');
  const [result] = await browserApi.scripting.executeScript({ target: { tabId: tab.id }, func: () => {
    const approval = document.querySelector('[data-ubeeq-browser-approval]');
    return approval ? { code: approval.getAttribute('data-ubeeq-browser-approval'), apiBase: approval.getAttribute('data-ubeeq-api-base') || approval.getAttribute('data-ubeeq-api-origin') } : null;
  } });
  if (!result?.result) throw new Error('Approve a browser connection on this application’s Integrations page first.');
  $('origin').value = apiBase(result.result.apiBase); $('code').value = result.result.code; $('connect').focus();
});
$('connect').onclick = async () => {
  // Permission request stays directly in the user gesture, before any asynchronous work.
  let origin;
  try { origin = apiBase($('origin').value); } catch (error) { $('error').textContent = error.message; return; }
  if (!await browserApi.permissions.request({ origins: [`${new URL(origin).origin}/*`] })) { $('error').textContent = 'Application access was declined. Your selections are preserved.'; return; }
  await run(async () => {
    const profileId = (await browserApi.storage.local.get('profileId')).profileId || crypto.randomUUID();
    await browserApi.storage.local.set({ profileId });
    const result = await request({ apiBase: origin }, '/exchange', { code: $('code').value, profileId });
    connection = { ...result, apiBase: origin, profileId, webOrigin: appOrigin(result.webOrigin), studioName: result.studioName };
    $('code').value = ''; await save(); display(); $('detect').focus();
  });
};
$('detect').onclick = () => run(async () => {
  const [tab] = await browserApi.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('Open the source in an active tab.');
  detected = await inspect(tab.id);
  connection.tabId = tab.id; connection.containerId = tab.cookieStoreId || 'default';
  $('source').textContent = detected.provider === 'deviantart' ? `DeviantArt public source: ${detected.accountId}. Signed-in account unverified.` : `${detected.provider}: guided authorization required`;
  $('confirmation').hidden = detected.provider !== 'deviantart'; $('guided').hidden = detected.provider === 'deviantart';
  $('previewSection').hidden = true; selected.clear();
  if (detected.provider !== 'deviantart') {
    $('guidance').textContent = detected.provider === 'tumblr' ? 'Continue with your creator-owned Tumblr application and choose a blog. Browser detection does not create an account grant.' : 'Continue to site validation and dedicated Application Password setup. Approval support varies by site; the manual path remains available.';
    const link = new URL('/studio/workspace', connection.webOrigin); link.searchParams.set('creatorId', connection.creatorId); link.searchParams.set('section', 'integrations'); link.searchParams.set('platform', detected.provider);
    if (detected.siteUrl) link.searchParams.set('siteUrl', detected.siteUrl);
    $('setup').href = link.href;
  }
  await save();
});
function renderItems() {
  const rows = visibleItems(preview?.items || [], { name: $('name').value });
  const visible = new Set(rows.map(row => row.remoteId)); selected = new Set([...selected].filter(id => visible.has(id)));
  $('items').replaceChildren();
  for (const row of rows) {
    const label = document.createElement('label'), input = document.createElement('input'), link = document.createElement('a');
    input.type = 'checkbox'; input.disabled = row.alreadyPresent; input.checked = selected.has(row.remoteId);
    input.onchange = () => { delete preview.requestId; input.checked ? selected.add(row.remoteId) : selected.delete(row.remoteId); updateCount(); };
    link.href = row.sourceUrl; link.target = '_blank'; link.rel = 'noreferrer'; link.textContent = row.title;
    label.append(input, link, document.createTextNode(row.alreadyPresent ? ' · already present' : ' · external reference')); $('items').append(label);
  }
  updateCount();
}
function updateCount() { $('count').textContent = `${selected.size} selected of ${visibleItems(preview?.items || [], { name: $('name').value }).length} visible`; }
$('name').oninput = () => { if (preview) delete preview.requestId; renderItems(); };
$('preview').onclick = () => run(async () => {
  const observed = await inspect(connection.tabId);
  if (observed.accountId !== detected.accountId || observed.provider !== detected.provider) throw new Error('The source changed. Detect and confirm it again.');
  preview = await request(connection, '/preview', { source: observed, items: observed.items });
  connection.source = preview.source; selected = new Set(preview.items.filter(row => !row.alreadyPresent).map(row => row.remoteId));
  $('previewSection').hidden = false; $('confirmation').hidden = true; await save(); renderItems(); $('name').focus();
});
$('import').onclick = () => run(async () => {
  if (!selected.size) throw new Error('Select at least one visible item.');
  const observed = await inspect(connection.tabId);
  if (observed.accountId !== connection.source.accountId || observed.provider !== connection.source.provider) throw new Error('The source changed. Detect and confirm it again.');
  connection.pendingStart = { previewId: preview.previewId, selected: [...selected], filter: { name: $('name').value }, requestId: preview.requestId ||= crypto.randomUUID() };
  await save();
  connection.progress = await request(connection, '/jobs', connection.pendingStart);
  delete connection.pendingStart;
  connection.jobId = connection.progress.id; await save(); display();
  await browserApi.runtime.sendMessage({ type: 'resume' }); $('status').textContent = 'Import started. You may close this panel; keep the browser and confirmed source tab open.';
});
$('resume').onclick = () => run(async () => {
  // Reselecting after restart is explicit; tabs IDs can change across browser sessions.
  const [tab] = await browserApi.tabs.query({ active: true, currentWindow: true });
  const observed = await inspect(tab.id);
  if (observed.provider !== connection.source.provider || observed.accountId !== connection.source.accountId || (tab.cookieStoreId || 'default') !== connection.containerId)
    throw new Error('Open the confirmed source in its original browser container before resuming.');
  connection.tabId = tab.id;
  if (connection.pendingStart) {
    connection.progress = await request(connection, '/jobs', connection.pendingStart);
    connection.jobId = connection.progress.id; delete connection.pendingStart;
  } else connection.progress = await request(connection, `/jobs/${connection.jobId}/retry`, {});
  connection.error = null;
  await save(); display(); await browserApi.runtime.sendMessage({ type: 'resume' });
});
$('cancel').onclick = () => run(async () => {
  connection.progress = await request(connection, `/jobs/${connection.jobId}/cancel`, {});
  if (preview) delete preview.requestId;
  delete connection.pendingStart; await save(); display();
});
$('galleryAccounts').onclick = () => run(async () => {
  const result = await request(connection, '/gallery-accounts');
  $('galleryAccount').replaceChildren(new Option('Choose an account', ''));
  for (const account of result.items) $('galleryAccount').append(new Option(account.username, account.id));
  if (!result.items.length) throw new Error('Connect a DeviantArt account in your application first. Shared accounts require administrator access to every linked Creator Identity.');
});
$('galleryPrepare').onclick = () => run(async () => {
  const price = $('galleryPrice').value.trim();
  if (!/^\d{1,7}(?:\.\d{1,2})?$/.test(price)) throw new Error('Enter a positive USD price with at most two decimal places.');
  const [whole, cents = ''] = price.split('.'), priceCents = Number(whole) * 100 + Number(cents.padEnd(2, '0'));
  connection.gallerySetup = await request(connection, '/gallery-setups', { externalAccountId: $('galleryAccount').value, name: $('galleryName').value,
    kind: 'premium', currency: 'USD', priceCents });
  await save(); displayGallerySetup(); $('galleryManager').focus();
});
$('galleryFill').onclick = () => run(async () => {
  const setup = await request(connection, `/gallery-setups/${connection.gallerySetup.id}`);
  const [tab] = await browserApi.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('Open the premium gallery form in the confirmed DA account.');
  const [result] = await browserApi.scripting.executeScript({ target: { tabId: tab.id }, func: preparePremiumGalleryForm, args: [setup] });
  if (!result?.result?.prepared) throw new Error(result?.result?.message || 'The native form could not be identified. Fill it manually on DeviantArt.');
  $('galleryStatus').textContent = result.result.message;
});
$('galleryRefresh').onclick = () => run(async () => {
  const result = await request(connection, `/gallery-setups/${connection.gallerySetup.id}/candidates`);
  $('galleryCandidate').replaceChildren(new Option('Choose the gallery you created', ''));
  for (const gallery of result.items) $('galleryCandidate').append(new Option(`${gallery.name} · Premium`, gallery.remoteId));
  if (!result.items.length) throw new Error('No premium gallery with this title was verified through the API. Complete creation on DeviantArt, then refresh; a regular gallery will not be substituted.');
});
$('galleryVerify').onclick = () => run(async () => {
  if (!$('galleryCandidate').value) throw new Error('Choose the exact premium gallery to verify.');
  connection.gallerySetup = await request(connection, `/gallery-setups/${connection.gallerySetup.id}/verify`, { remoteId: $('galleryCandidate').value });
  await save(); displayGallerySetup();
});
$('disconnect').onclick = () => { $('dialogError').textContent = ''; $('disconnectDialog').showModal(); $('keep').focus(); };
$('keep').onclick = () => $('disconnectDialog').close();
$('revoke').onclick = () => run(async () => {
  await request(connection, '/disconnect', {});
  await browserApi.alarms.clear('import');
  await browserApi.storage.local.remove('connection');
  connection = undefined; $('disconnectDialog').close(); display();
});
browserApi.storage.onChanged.addListener(changes => { if (changes.connection && !busy) { connection = changes.connection.newValue; display(); } });
display();
