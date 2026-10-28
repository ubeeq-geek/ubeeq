export const browserApi = globalThis.browser || globalThis.chrome;
export function appOrigin(input) {
  const url = new URL(input);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
    !(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))
    throw new Error('Enter an HTTPS application origin, or a local development origin.');
  return url.origin;
}
export async function state() { return (await browserApi.storage.local.get('connection')).connection; }
export async function request(connection, path, data) {
  const response = await fetch(`${appOrigin(connection.origin)}/browser-extension${path}`, {
    method: data === undefined ? 'GET' : 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store',
    headers: { ...(connection.token ? { Authorization: `Bearer ${connection.token}` } : {}), 'Content-Type': 'application/json' },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }), signal: AbortSignal.timeout(20000)
  });
  const result = await response.json();
  if (!response.ok) {
    const messages = { gallery_setup_unavailable: 'Premium gallery assistance is not available for this application.',
      shared_authorization_admin_required: 'Use your own DA connection with administrator access to every linked Creator Identity, or create a separate connection.',
      account_unverified: 'Reconnect and verify this DA account in your application first.', premium_gallery_unverified: 'This exact gallery could not be verified as Premium. Check it on DA and refresh; a regular gallery will not be substituted.',
      gallery_setup_expired: 'This gallery setup expired. Prepare a new setup; any gallery you created on DA remains intact.',
      invalid_gallery_setup: 'Enter a title of up to 50 characters and a positive USD price for a new top-level Premium Gallery.',
      provider_authorization_required: 'Reconnect this DA account in your application, then resume the gallery setup.',
      extension_unavailable: 'Browser connections are disabled for this application.', pairing_required: 'Pair this browser again.',
      creator_access_required: 'Creator access changed. Ask an administrator to review this pairing.', account_changed: 'The source or browser session changed. Return to the confirmed source before resuming.',
      rate_limited: 'Requests are cooling down. Resume later.', lease_busy: 'An import step is already running. Retry shortly.', approval_expired: 'Approval expired or was already used. Create a new approval in your application.' };
    throw new Error(messages[result.code] || result.message || result.code || 'Unable to complete this step.');
  }
  return result;
}
export function visibleItems(items, filter = {}) {
  return items.filter(row => row.title.toLowerCase().includes((filter.name || '').toLowerCase()) &&
    (!filter.from || row.publishedAt && row.publishedAt >= filter.from) && (!filter.to || row.publishedAt && row.publishedAt <= filter.to));
}
export async function inspect(tabId) {
  const result = await browserApi.scripting.executeScript({ target: { tabId }, files: ['detect.js'] });
  if (!result[0]?.result) throw new Error('This page is not a recognized source. Open your DeviantArt gallery, WordPress admin, or Tumblr dashboard.');
  return result[0].result;
}
