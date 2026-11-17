import { parse, serializeOuter, type DefaultTreeAdapterMap } from 'parse5';
import { commerceHtml, commerceJavaScript } from './page.js';
import type { CommerceRuntimeConfiguration } from './runtime.js';
import { resolveStorefrontAccountConfig, type ResolvedStorefrontAccountConfig, type StorefrontBrandConfig } from './brandConfig.js';

type Node = DefaultTreeAdapterMap['node'];
const element = (node: Node): node is DefaultTreeAdapterMap['element'] => 'tagName' in node;

function find(node: Node, predicate: (node: DefaultTreeAdapterMap['element']) => boolean): DefaultTreeAdapterMap['element'] | undefined {
  if (element(node) && predicate(node)) return node;
  if ('childNodes' in node) {
    for (const child of node.childNodes) {
      const found = find(child, predicate);
      if (found) return found;
    }
  }
}

const escape = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export const customerBootstrap = String.raw`'use strict';
(()=>{const media=window.matchMedia('(prefers-color-scheme: dark)');const apply=()=>{let saved;try{saved=localStorage.getItem('ubeeq.appearance');}catch{}const preference=['light','dark','system'].includes(saved)?saved:'system';document.documentElement.dataset.appearance=preference;document.documentElement.dataset.colorScheme=preference==='system'?(media.matches?'dark':'light'):preference;};apply();media.addEventListener('change',apply);window.addEventListener('storage',event=>{if(event.key==='ubeeq.appearance')apply();});})();`;

export const createCustomerEnhancements = (brand: StorefrontBrandConfig, accountConfig: ResolvedStorefrontAccountConfig) => String.raw`'use strict';
(()=>{
 const memberKey=${JSON.stringify(accountConfig.sessionCookieName)};let member;
 const readMember=()=>{try{const value=JSON.parse(localStorage.getItem(memberKey)||sessionStorage.getItem(memberKey)||'null');return value&&typeof value.token==='string'&&Date.parse(value.expiresAt)>Date.now()&&typeof value.account?.userId==='string'?value:undefined;}catch{return undefined;}};
 const localSessionKey='ubeeq.local-test.purchase-session';
 const readLocalSession=()=>{try{const value=JSON.parse(sessionStorage.getItem(localSessionKey)||'null');return value&&typeof value.token==='string'&&value.userId===sessionStorage.getItem('ubeeq.local-test-account')&&Date.parse(value.expiresAt)>Date.now()?value:undefined;}catch{return undefined;}};
 const restoreAccountSession=()=>{member=readMember();let credential=member?.token||'';if(!credential){try{const token=localStorage.getItem('idToken')||sessionStorage.getItem('idToken');if(token){const payload=JSON.parse(atob(token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));if(payload.exp*1000>Date.now())credential=token;}}catch{}}if(!credential)credential=readLocalSession()?.token||'';if(credential)sessionStorage.setItem('ubeeq.commerce.session',credential);else if(sessionStorage.getItem(localSessionKey)){sessionStorage.removeItem(localSessionKey);sessionStorage.removeItem('ubeeq.commerce.session');}return credential;};
 restoreAccountSession();
 const syncAccountSession=()=>{const token=restoreAccountSession();if(!token)sessionStorage.removeItem('ubeeq.commerce.session');window.dispatchEvent(new CustomEvent('ubeeq:commerce-session-changed',{detail:{token}}));update();};
 window.addEventListener('storage',event=>{if(event.key===memberKey||event.key==='idToken'||event.key===null)syncAccountSession();});
 window.addEventListener('focus',()=>{syncAccountSession();});
 window.addEventListener('ubeeq:commerce-account-session',event=>{const value=event.detail;if(value?.account&&typeof value.token==='string'){member=value;try{for(const key of ['idToken','accessToken','refreshToken','username','ubeeq.local-test-account','ubeeq.local-developer-session']){localStorage.removeItem(key);sessionStorage.removeItem(key);}localStorage.setItem(memberKey,JSON.stringify(value));window.dispatchEvent(new Event('ubeeq:member-session-changed'));}catch{}update();}});
 const byId=id=>document.getElementById(id);let params,owner,checkoutStatus='confirming';const readContext=()=>{params=new URLSearchParams(location.search);owner=params.get('owner');if(!owner){try{owner=decodeURIComponent(location.pathname.match(/^\/buy\/([^/]+)/)?.[1]||'');}catch{owner='';}}};readContext();
 const heading={store:['Collections from creators',${JSON.stringify(`Support creators and keep your collections together in ${brand.productName}.`)}],purchases:['My purchases','Your collections, subscriptions, gifts, and downloads in one place.'],checkout:['Confirming your payment','We’re checking your payment and preparing your collection access.'],proof:['Your collection access','Use your email link to sign in, claim a purchase, or verify your account.'],discordCallback:['Connect Discord','Add optional Discord access to your purchases.']};
 const setText=(id,value)=>{if(byId(id)&&byId(id).textContent!==value)byId(id).textContent=value;};
 const update=()=>{
  readContext();
  heading.checkout=checkoutStatus==='completed'?['Payment confirmed','Your purchase is complete. View your access below.']:checkoutStatus==='cancelled'?['Payment cancelled','Return to the collection whenever you’re ready.']:checkoutStatus==='needs_review'?['Payment needs attention','Contact the creator for help with this payment.']:['Confirming your payment','We’re checking your payment and preparing your collection access.'];
  heading.proof=location.pathname.endsWith('/claim')?['Claim your purchase','Add a purchase you’ve already made to your verified account.']:location.pathname.endsWith('/verify-email')?['Verify your email','Confirm your email address for secure account access.']:['Sign in','Sign in securely to continue browsing collections or review a purchase. No payment is made when you sign in.'];
  const visible=Object.keys(heading).find(id=>byId(id)&&!byId(id).hidden)||'store';
  if(byId('commercePageTitle'))setText('commercePageTitle',heading[visible][0]);
  if(byId('commercePageDescription'))setText('commercePageDescription',heading[visible][1]);
  document.title=heading[visible][0]+${JSON.stringify(' · ' + brand.productName)};
 };
 update();
})();`;

export const defaultCustomerCss = `
.app-shell { font-family: system-ui, -apple-system, sans-serif; margin: 0; padding: 0; background: #fbfbfb; color: #1a1a1a; }
.topbar { border-bottom: 1px solid #e5e5e5; background: #fff; padding: 12px 24px; }
.topbar-inner { max-width: 1200px; margin: 0 auto; display: flex; justify-content: space-between; align-items: center; }
.brand-css-logo { display: flex; align-items: center; gap: 10px; text-decoration: none; color: inherit; font-weight: 700; font-size: 1.15rem; }
.brand-css-tagline { font-size: 0.8rem; color: #666; font-weight: 400; margin-left: 6px; }
.commerce-global-nav { display: flex; gap: 16px; }
.commerce-global-nav a { text-decoration: none; color: #444; font-size: 0.95rem; }
.commerce-layout { max-width: 1200px; margin: 24px auto; display: grid; grid-template-columns: 1fr 340px; gap: 32px; padding: 0 16px; }
.commerce-account-rail { border: 1px solid #e5e5e5; border-radius: 12px; background: #fff; padding: 24px; }
.commerce-footer { max-width: 1200px; margin: 48px auto 24px; padding: 24px 16px; border-top: 1px solid #eee; display: flex; justify-content: space-between; font-size: 0.85rem; color: #666; }
.commerce-skip { position: absolute; left: -9999px; }
.commerce-skip:focus { left: 16px; top: 16px; z-index: 1000; background: #fff; padding: 8px 16px; border: 2px solid #000; }
`;

export function renderStorefrontPage(brand: StorefrontBrandConfig): NonNullable<CommerceRuntimeConfiguration['customerPage']> {
  const accountConfig = resolveStorefrontAccountConfig(brand);
  const document = parse(commerceHtml);

  const section = (id: string) => {
    const node = find(document, (n) => n.attrs.some((a) => a.name === 'id' && a.value === id));
    if (!node) throw new Error(`Commerce shell is missing ${id}`);
    return node;
  };

  const signin = section('signin');
  signin.attrs.push({ name: 'hidden', value: '' });

  const recovery = section('recovery');
  recovery.attrs.push({ name: 'hidden', value: '' });

  const identity = section('identity');
  identity.tagName = 'aside';
  identity.attrs.push({ name: 'class', value: 'commerce-account' });
  identity.attrs.push({ name: 'aria-label', value: accountConfig.accountLabel });

  const recoveryHtml = serializeOuter(recovery);
  identity.childNodes = identity.childNodes.filter((n) => n !== recovery);
  const accountHtml = serializeOuter(identity).replace(
    '</aside>',
    `<details id="commerceAccountSettings" hidden><summary>Email and recovery settings</summary>${recoveryHtml}</details></aside>`
  );

  const store = section('store');
  const finder = section('findStore');
  store.childNodes = store.childNodes.filter((n) => n !== finder);
  const storeHtml = serializeOuter(store)
    .replace('<h2>Storefront</h2>', '<h2 class="sr-only">Available collections</h2>')
    .replace(
      '</section>',
      `<p id="commerceStoreEmpty" class="muted" hidden>Open a creator’s purchase link to browse their collections, or visit My purchases to return to content you already own.</p><details id="commerceStoreFinder"><summary>Open a creator storefront</summary>${serializeOuter(finder)}</details></section>`
    );

  const sections = ['checkout', 'purchases', 'proof', 'discordCallback']
    .map((id) => {
      let html = serializeOuter(section(id));
      if (id === 'purchases') {
        html = html.replace(
          '<h2>My purchases</h2>',
          '<h2 class="sr-only">Your purchased collections</h2><div id="commercePurchaseSignin" class="panel" hidden><h3>Sign in to see your purchases</h3><p class="muted">Use the email you used at checkout to return to your collections, subscriptions, and gifts.</p><a href="#identity">Sign in with email</a></div>'
        );
      }
      if (id === 'checkout') {
        html = html.replace(
          '<h2>Purchase status</h2>',
          '<h2 class="sr-only">Purchase status</h2><p id="commerceCheckoutSignin" class="status" hidden>Sign in with the email used for this purchase to view its status.</p>'
        );
      }
      return html;
    })
    .join('');

  const originalStyle = find(document, (n) => n.tagName === 'style');
  const sharedStyle =
    originalStyle?.childNodes
      .filter((n) => n.nodeName === '#text')
      .map((n) => (n as DefaultTreeAdapterMap['textNode']).value)
      .join('') ?? '';

  const title = escape(brand.productName);
  const studio = escape(brand.studioName);
  const tagline = escape(brand.tagline ?? 'Self-hosted creator commerce');
  const logo = brand.logoSvg || `<span class="brand-css-orb-wrap">●</span>`;
  const ribbonLabel = escape(brand.legacyCustomerAccountConfig?.passwordRibbonLabel ?? `Set up your ${accountConfig.accountLabel}`);

  const html = `<!doctype html><html lang="en" data-product-brand="${escape(brand.brandId)}" data-stealth-mode="hide"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Purchases · ${title}</title><script src="/commerce/customer.js"></script><script src="/commerce/media-privacy.js"></script><style>${sharedStyle}</style><link rel="stylesheet" href="/commerce/customer.css"></head>
<body class="app-shell commerce-shell" data-theme="ubeeq"><a class="commerce-skip" href="#commerceContent">Skip to content</a>
<header class="topbar topbar-public"><div class="topbar-inner"><a href="/" class="brand-css-logo" aria-label="${title} home">${logo}<span><span class="brand-css-wordmark">${title}</span><span class="brand-css-tagline">${tagline}</span></span></a><nav class="commerce-global-nav" aria-label="${title}"><a href="/discover">Explore</a><a href="/account">Account</a><a href="/studio/workspace">${studio}</a></nav></div></header>
<main id="commerceContent" tabindex="-1"><header class="commerce-page-heading"><div><p class="commerce-eyebrow">Purchases &amp; access</p><h1 id="commercePageTitle">Collections from creators</h1><p id="commercePageDescription" class="muted">Support creators and keep your collections together in ${title}.</p></div><span id="commerceSandbox" class="commerce-badge" hidden>Sandbox · test payments</span></header>
<aside id="commerceEverPasswordRibbon" class="commerce-member-ribbon" aria-label="${ribbonLabel}" hidden><p><strong>Your account is ready.</strong> Add a password so you can also sign in without an email link.</p><div><a href="/account/password">Set a password</a><button id="commerceDismissPasswordRibbon" type="button" class="secondary" aria-label="Dismiss password reminder">×</button></div></aside><nav class="commerce-tabs" aria-label="Purchases"><a id="commerceStoreLink" href="/commerce">Storefront</a><a id="commercePurchasesLink" href="/commerce/purchases">My purchases</a></nav><p id="notice" role="status" aria-live="polite" tabindex="-1"></p>
<div class="commerce-layout"><div class="commerce-main">${storeHtml}${sections}</div><div class="commerce-account-rail">${accountHtml}<button id="signout" class="secondary" hidden>Sign out</button><div class="commerce-assurance"><h3>Secure payments</h3><p>Checkout is handled securely. Your payment details stay with the provider.</p><p>Collection access and downloads are available here after payment is confirmed.</p></div></div></div>
<footer class="commerce-footer"><span>${title} · ${tagline}</span><a href="/commerce/purchases">Return to your purchases</a></footer>
<div hidden aria-hidden="true">${serializeOuter(section('creator'))}</div></main><script src="/commerce/client.js" defer></script></body></html>`;

  return {
    html,
    stylesheet: (brand.themeCss ?? '') + '\n' + defaultCustomerCss,
    bootstrapJavaScript: customerBootstrap,
    clientJavaScript: (brand.clientEnhancements ?? createCustomerEnhancements(brand, accountConfig)) + '\n' + commerceJavaScript,
    contentSecurityPolicy:
      "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; img-src 'self' blob:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  };
}
