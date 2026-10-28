(() => {
  const url = new URL(location.href);
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  if (url.hostname === 'www.deviantart.com') {
    const accountId = url.pathname.split('/')[1]?.toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,49}$/.test(accountId || '') || ['settings', 'notifications', 'watch', 'search', 'join', 'users', 'account', 'about', 'shop', 'core', 'team', 'dreamup'].includes(accountId)) return null;
    // Public author is a source label, NEVER the signed-in principal. No page scripts or session material are read.
    const items = [...document.querySelectorAll('a[href]')].flatMap(anchor => {
      let link; try { link = new URL(anchor.href); } catch { return []; }
      if (link.origin !== url.origin || !link.pathname.toLowerCase().startsWith(`/${accountId}/art/`)) return [];
      const remoteId = link.pathname.match(/-(\d+)\/?$/)?.[1]; if (!remoteId) return [];
      const image = anchor.querySelector('img');
      const title = (anchor.getAttribute('aria-label') || image?.alt || anchor.textContent || '').trim().slice(0, 500);
      if (!title) return [];
      link.search = ''; link.hash = ''; link.pathname = link.pathname.replace(/\/$/, '');
      return [{ remoteId, title, sourceUrl: link.href, media: 'external_reference' }];
    });
    return { provider: 'deviantart', accountId, siteId: accountId, authenticatedAccount: null,
      sessionScope: 'public_source', items: [...new Map(items.map(row => [row.remoteId, row])).values()].slice(0, 50) };
  }
  if (/\/wp-admin(?:\/|$)/.test(url.pathname) && document.querySelector('#wpadminbar')) {
    const api = document.querySelector('link[rel="https://api.w.org/"]')?.href;
    const base = url.href.slice(0, url.href.indexOf('/wp-admin'));
    return { provider: 'wordpress', siteUrl: base, restDiscovery: api || null, authenticatedAccount: null, items: [] };
  }
  if (url.hostname === 'www.tumblr.com' && /^\/(dashboard|settings|blog)(\/|$)/.test(url.pathname))
    return { provider: 'tumblr', authenticatedAccount: null, items: [] };
  return null;
})();
