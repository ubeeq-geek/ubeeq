export class SourceUrlPolicyError extends Error {
  readonly code = 'source_url_policy';
}

/** Anonymous source GET only. The caller owns deadlines and final-body limits/disposal. */
export const fetchApprovedSource = async (input: {
  url: string; approveUrl(url: string): boolean; signal: AbortSignal;
  maxRedirects?: number; fetcher?: typeof fetch;
}): Promise<Response> => {
  const { approveUrl, signal, fetcher = fetch, maxRedirects = 3 } = input;
  if (typeof approveUrl !== 'function' || !signal || typeof signal.throwIfAborted !== 'function' || !Number.isSafeInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 10) throw new SourceUrlPolicyError('Invalid source fetch configuration.');
  const validate = (value: string, base?: string): string => {
    if (typeof value !== 'string' || !value || value.length > 8192) throw new SourceUrlPolicyError('Invalid source URL.');
    let url: URL;
    try { url = new URL(value, base); } catch { throw new SourceUrlPolicyError('Invalid source URL.'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new SourceUrlPolicyError('Source requires credential-free HTTPS on the default port.');
    url.hash = '';
    const canonical = url.href;
    if (canonical.length > 8192) throw new SourceUrlPolicyError('Source URL exceeds length budget.');
    if (approveUrl(canonical) !== true) throw new SourceUrlPolicyError('Source URL is not approved.');
    return canonical;
  };
  let current = validate(input.url);
  const visited = new Set<string>();
  for (let redirects = 0; ; redirects++) {
    signal.throwIfAborted();
    if (visited.has(current)) throw new SourceUrlPolicyError('Source redirect loop.');
    visited.add(current);
    const response = await fetcher(current, { method: 'GET', redirect: 'manual', credentials: 'omit', referrerPolicy: 'no-referrer', signal });
    const discard = async () => { await response.body?.cancel().catch(() => {}); };
    try {
      signal.throwIfAborted();
      // A transport that followed redirects despite manual mode is not acceptable.
      if (response.redirected || (response.url && new URL(response.url).href !== current)) throw new SourceUrlPolicyError('Source transport changed the requested URL.');
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      if (redirects >= maxRedirects) throw new SourceUrlPolicyError('Source redirect budget exceeded.');
      const location = response.headers.get('location');
      if (!location) throw new SourceUrlPolicyError('Source redirect has no location.');
      current = validate(location, current);
    } catch (error) { await discard(); throw error; }
    await discard();
  }
};
