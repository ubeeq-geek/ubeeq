/** Serialize this fixed function with scripting.executeScript. It never submits, clicks, fetches or reads website session material. */
export function preparePremiumGalleryForm(intent, doc = globalThis.document, currentLocation = globalThis.location) {
  const stop = message => ({ prepared: false, created: false, message });
  let page;
  try { page = new URL(currentLocation.href); } catch { return stop('Open the confirmed account’s DeviantArt gallery manager.'); }
  if (page.protocol !== 'https:' || page.hostname !== 'www.deviantart.com' || page.username || page.password || page.port
    || !intent || intent.kind !== 'premium' || intent.currency !== 'USD' || intent.automaticCreationReady !== false
    || !/^[a-z0-9][a-z0-9-]{0,49}$/i.test(intent.account?.username || '')
    || !page.pathname.toLowerCase().match(new RegExp(`^/${intent.account.username.toLowerCase()}/gallery(?:/|$)`)))
    return stop('The current page does not match the confirmed DeviantArt account.');
  if (typeof intent.name !== 'string' || !intent.name.trim() || intent.name.length > 50 || /[\u0000-\u001f\u007f]/.test(intent.name)
    || !Number.isSafeInteger(intent.priceCents) || intent.priceCents < 1 || intent.priceCents > 100000000)
    return stop('The proposed gallery title or price is invalid.');
  const visible = node => !node.hidden && node.getAttribute('aria-hidden') !== 'true' && node.getClientRects().length > 0;
  const label = node => (node.getAttribute('aria-label') || [...(node.labels || [])].map(item => {
    const copy = item.cloneNode(true); copy.querySelectorAll('input,select,textarea,button').forEach(control => control.remove());
    return copy.textContent || '';
  }).join(' ')
    || (node.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => doc.getElementById(id)?.textContent || '').join(' ')).trim().replace(/\s+/g, ' ');
  const dialogs = [...doc.querySelectorAll('dialog[open], [role="dialog"]')].filter(visible);
  if (dialogs.length !== 1) return stop('Open a single New Gallery dialog on DeviantArt and choose Premium Gallery.');
  const dialog = dialogs[0];
  const selected = [...dialog.querySelectorAll('input[type="radio"]:checked, [role="radio"][aria-checked="true"], [role="tab"][aria-selected="true"]')].map(label);
  const premiumHeading = [...dialog.querySelectorAll('h1,h2,h3,[role="heading"]')].some(node => /^(create|new) (?:a )?premium gallery$/i.test(node.textContent?.trim() || ''));
  if ((!selected.some(value => /^premium(?: gallery)?$/i.test(value)) && !premiumHeading)
    || selected.some(value => /^(regular|public|watchers[- ]only)(?: gallery)?$/i.test(value)))
    return stop('Choose Premium Gallery in DeviantArt first. Regular and Watchers-Only forms will not be filled.');
  const inputs = [...dialog.querySelectorAll('input')].filter(node => visible(node) && !node.disabled && !node.readOnly);
  const titles = inputs.filter(node => ['text', ''].includes(node.type) && /^(?:gallery )?(name|title)$/i.test(label(node)));
  const prices = inputs.filter(node => ['text', 'number', ''].includes(node.type) && /^(?:usd )?price(?: \(usd\)| in usd)?$/i.test(label(node)));
  const currencies = [...dialog.querySelectorAll('select')].filter(node => /^currency/i.test(label(node)) && visible(node));
  if (currencies.length > 1 || currencies.some(node => !/^currency$/i.test(label(node)))) return stop('The currency selection is ambiguous. Fill this form manually on DeviantArt.');
  const currency = currencies[0];
  const usd = currency ? currency.value === 'USD' : prices.length === 1 && /\busd\b/i.test(label(prices[0]));
  const parent = [...dialog.querySelectorAll('select,input')].find(node => /^(parent|parent gallery)$/i.test(label(node)) && node.value);
  if (titles.length !== 1 || prices.length !== 1 || !usd || parent)
    return stop('The premium form’s title, USD price, or gallery type could not be identified safely. Fill it manually on DeviantArt.');
  const price = (intent.priceCents / 100).toFixed(2), nameInput = titles[0], priceInput = prices[0];
  if (nameInput.maxLength > 0 && intent.name.length > nameInput.maxLength
    || priceInput.min && Number(price) < Number(priceInput.min) || priceInput.max && Number(price) > Number(priceInput.max))
    return stop('The title or price exceeds the limits shown by DeviantArt. Adjust the proposal first.');
  const setter = Object.getOwnPropertyDescriptor(doc.defaultView.HTMLInputElement.prototype, 'value')?.set;
  if (!setter) return stop('This form cannot be prepared safely. Fill it manually on DeviantArt.');
  for (const [node, value] of [[nameInput, intent.name], [priceInput, price]]) {
    setter.call(node, value);
    node.dispatchEvent(new doc.defaultView.Event('input', { bubbles: true }));
    node.dispatchEvent(new doc.defaultView.Event('change', { bubbles: true }));
  }
  return { prepared: true, created: false, requiresNativeConfirmation: true, browserAccountVerified: false,
    message: 'Title and USD price prepared. Verify the signed-in account, Premium Gallery type and price on DeviantArt, then use its Create button yourself. No artwork has been added.' };
}
