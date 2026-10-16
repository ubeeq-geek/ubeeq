import { readBoundedResponseText } from './bounded-response-text.js';
export type RedditTokens = { accessToken: string; refreshToken?: string; expiresIn: number; scopes: string[] };
export type RedditSubmission = { kind: 'link' | 'self'; subreddit: string; title: string; url?: string; text?: string; flairId?: string; nsfw?: boolean };
export class RedditApiError extends Error {
  constructor(message: string, readonly status?: number, readonly retryAfterSeconds?: number, readonly uncertain = false) { super(message); this.name = 'RedditApiError'; }
}
/** OAuth credentials and fetch are supplied by the owning product; no tenant or product policy lives here. */
export class RedditClient {
  constructor(private options: { clientId: string; clientSecret: string; redirectUri: string; userAgent: string; fetch?: typeof fetch }) {}
  authorize(state: string) {
    const url = new URL('https://www.reddit.com/api/v1/authorize');
    url.search = new URLSearchParams({ client_id: this.options.clientId, response_type: 'code', state, redirect_uri: this.options.redirectUri, duration: 'permanent', scope: 'identity read submit' }).toString();
    return url.href;
  }
  private async json(url: string, init: RequestInit, write = false): Promise<any> {
    let response: Response;
    try { response = await (this.options.fetch || fetch)(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(30000), headers: { 'User-Agent': this.options.userAgent, ...init.headers } }); }
    catch { throw new RedditApiError(write ? 'Submission delivery is uncertain. Check Reddit before submitting again.' : 'Reddit could not be reached.', undefined, undefined, write); }
    const wait = Number(response.headers.get('retry-after'));
    if (!response.ok) throw new RedditApiError(`Reddit returned HTTP ${response.status}.`, response.status, Number.isFinite(wait) && wait > 0 ? wait : undefined, write && response.status >= 500);
    let data: any;
    try { data = JSON.parse(await readBoundedResponseText(response, 2 * 1024 * 1024)); }
    catch { throw new RedditApiError('Reddit response could not be verified.', response.status, undefined, write); }
    if (data?.json?.errors?.length) throw new RedditApiError(data.json.errors.map((row: unknown[]) => String(row[0])).join(', ').slice(0, 300), 422);
    return data;
  }
  private async token(fields: Record<string, string>): Promise<RedditTokens> {
    const basic = Buffer.from(`${this.options.clientId}:${this.options.clientSecret}`).toString('base64');
    const data = await this.json('https://www.reddit.com/api/v1/access_token', { method: 'POST', headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() });
    if (typeof data.access_token !== 'string') throw new RedditApiError('Reddit did not return an access token.');
    return { accessToken: data.access_token, refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : undefined, expiresIn: Number(data.expires_in) || 3600, scopes: String(data.scope || '').split(/[ ,]+/).filter(Boolean) };
  }
  exchange(code: string) { return this.token({ grant_type: 'authorization_code', code, redirect_uri: this.options.redirectUri }); }
  refresh(refreshToken: string) { return this.token({ grant_type: 'refresh_token', refresh_token: refreshToken }); }
  identity(token: string) { return this.json('https://oauth.reddit.com/api/v1/me', { headers: { Authorization: `Bearer ${token}` } }) as Promise<{ id: string; name: string }> ; }
  async subreddit(token: string, name: string) {
    if (!/^[A-Za-z0-9_]{2,21}$/.test(name)) throw new RedditApiError('Use a valid subreddit name.', 422);
    const headers = { Authorization: `Bearer ${token}` };
    const [about, rules, requirements] = await Promise.all([
      this.json(`https://oauth.reddit.com/r/${name}/about`, { headers }),
      this.json(`https://oauth.reddit.com/r/${name}/about/rules`, { headers }),
      this.json(`https://oauth.reddit.com/api/v1/${name}/post_requirements`, { headers })
    ]);
    return { about: about.data, rules: rules.rules || [], requirements };
  }
  async submit(token: string, input: RedditSubmission): Promise<{ id: string; url: string }> {
    if (!/^[A-Za-z0-9_]{2,21}$/.test(input.subreddit) || !input.title.trim() || input.title.length > 300 || !['link', 'self'].includes(input.kind)) throw new RedditApiError('Invalid Reddit submission.', 422);
    if (input.kind === 'link') { const url = new URL(input.url || ''); if (url.protocol !== 'https:' || url.username || url.password) throw new RedditApiError('Use a public HTTPS link.', 422); }
    if ((input.text?.length || 0) > 40000) throw new RedditApiError('Text is too long.', 422);
    const fields = { api_type: 'json', sr: input.subreddit, kind: input.kind, title: input.title, ...(input.kind === 'link' ? { url: input.url! } : { text: input.text || '' }), ...(input.flairId ? { flair_id: input.flairId } : {}), nsfw: String(Boolean(input.nsfw)), sendreplies: 'false', resubmit: 'false' };
    const data = await this.json('https://oauth.reddit.com/api/submit', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() }, true);
    const id = data.json?.data?.name, rawUrl = data.json?.data?.url;
    if (typeof id !== 'string' || !/^t3_[a-z0-9]+$/.test(id) || typeof rawUrl !== 'string') throw new RedditApiError('Submission was sent but its identity could not be verified.', undefined, undefined, true);
    const url = new URL(rawUrl); if (url.protocol !== 'https:' || !['www.reddit.com', 'reddit.com', 'old.reddit.com'].includes(url.hostname)) throw new RedditApiError('Unexpected submission URL.', undefined, undefined, true);
    return { id, url: url.href };
  }
  async readPost(token: string, id: string) {
    if (!/^t3_[a-z0-9]+$/.test(id)) throw new RedditApiError('Invalid post ID.', 422);
    const data = await this.json(`https://oauth.reddit.com/api/info?id=${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${token}` } });
    return data.data?.children?.[0]?.data as { name: string; author: string; title: string; permalink: string; removed_by_category?: string; selftext?: string } | undefined;
  }
}
