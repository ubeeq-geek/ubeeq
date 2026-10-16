import { readBoundedResponseText } from './bounded-response-text.js';
import { parseRetryAfterSeconds } from './provider-errors.js';
import { isNonPublicIntegrationAddress } from './network-address.js';

export class ProfessionalPublishingError extends Error {
  constructor(message: string, readonly code: 'authentication' | 'permission' | 'rate_limit' | 'invalid_media' | 'unsupported' |
    'provider_rejection' | 'transient' | 'outcome_unknown' | 'invalid_response', readonly status?: number, readonly retryAfterSeconds?: number) {
    super(message); this.name = 'ProfessionalPublishingError';
  }
}
type Options = { fetch?: typeof fetch; timeoutMs?: number; maxResponseBytes?: number };
const invalid = (message: string): never => { throw new ProfessionalPublishingError(message, 'invalid_media', 422); };
const bounded = (value: unknown, label: string, maximum: number, allowEmpty = false): string => {
  if (typeof value !== 'string' || value.length > maximum || (!allowEmpty && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) return invalid(`Invalid ${label}.`);
  return value;
};
const tokenValue = (token: string) => { bounded(token, 'credential', 16384); if (/\s/.test(token)) invalid('Invalid credential.'); return token; };
const identifier = (value: string, numeric = false) => {
  if (typeof value !== 'string' || !(numeric ? /^[0-9]{1,100}$/ : /^[A-Za-z0-9_-]{1,200}$/).test(value)) invalid('Invalid remote target identity.'); return value;
};
/** Literal network admission only. The product must prove a preview is a public derivative. */
export function professionalPublishingPublicUrl(value: string): string {
  let url: URL;
  try { url = new URL(bounded(value, 'public URL', 2048)); } catch { return invalid('Invalid public URL.'); }
  if (url.protocol !== 'https:' || isNonPublicIntegrationAddress(url.hostname)) return invalid('A public HTTPS URL is required.');
  if (url.username || url.password || url.hash) return invalid('Public URLs cannot contain credentials or fragments.');
  return url.href;
}

async function json(url: string, init: RequestInit, options: Options, write = false): Promise<{ body: any; response: Response }> {
  const timeoutMs = options.timeoutMs ?? 30_000, maxBytes = options.maxResponseBytes ?? 2_097_152;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 8_388_608)
    throw new Error('Invalid provider transport bounds.');
  const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutError = () => new ProfessionalPublishingError(write ? 'Delivery outcome is unknown.' : 'Provider unavailable.', write ? 'outcome_unknown' : 'transient');
  try {
    return await Promise.race([
      (async () => {
        let response: Response;
        try { response = await (options.fetch || fetch)(url, { ...init, redirect: 'error', signal: controller.signal }); }
        catch { throw timeoutError(); }
        const uncertain = write && (response.ok || response.status === 408 || response.status >= 500 || (response.status >= 300 && response.status < 400));
        if (response.redirected) throw new ProfessionalPublishingError('Provider redirect rejected.', write ? 'outcome_unknown' : 'invalid_response');
        let text: string, body: any = {};
        try { text = await readBoundedResponseText(response, maxBytes); if (text) body = JSON.parse(text); }
        catch { throw new ProfessionalPublishingError('Provider response could not be verified.', uncertain ? 'outcome_unknown' : 'invalid_response', response.status); }
        if (!response.ok) {
          const code = write && response.status === 408 ? 'outcome_unknown' : response.status === 401 ? 'authentication' : response.status === 403 ? 'permission' : response.status === 429 ? 'rate_limit'
            : response.status >= 500 ? (write ? 'outcome_unknown' : 'transient') : (write && response.status >= 300 && response.status < 400) ? 'outcome_unknown' : 'provider_rejection';
          throw new ProfessionalPublishingError(`Provider returned HTTP ${response.status}.`, code, response.status, parseRetryAfterSeconds(response.headers.get('retry-after')));
        }
        if (!body || typeof body !== 'object' || Array.isArray(body) || body.error)
          throw new ProfessionalPublishingError('Invalid provider response.', write ? 'outcome_unknown' : 'invalid_response', response.status);
        return { body, response };
      })(),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(timeoutError()); }, timeoutMs); })
    ]);
  } finally { if (timer) clearTimeout(timer); controller.abort(); }
}
export const FACEBOOK_PAGE_PUBLISH_SCOPE = 'pages_manage_posts';
export const FACEBOOK_PAGE_DISCOVERY_SCOPES = ['pages_show_list', 'pages_read_engagement'] as const;
export type FacebookPageTarget = { provider: 'facebook'; kind: 'facebook_page'; id: string; name: string; pageAccessToken: string; tasks: readonly string[] };
export type ProfessionalTokenIdentity = { principalId: string; name: string; scopes: string[]; expiresAt: string };
export class FacebookPagesClient {
  constructor(private options: Options & { appId: string; appSecret: string; redirectUri: string; graphApiVersion: string }) {
    if (!/^v\d+\.\d+$/.test(options.graphApiVersion)) throw new Error('Pinned Graph API version required.');
  }
  authorize(state: string): string {
    bounded(state, 'OAuth state', 2048); const url = new URL(`https://www.facebook.com/${this.options.graphApiVersion}/dialog/oauth`);
    url.search = new URLSearchParams({ client_id: this.options.appId, redirect_uri: this.options.redirectUri, state, response_type: 'code',
      scope: [...FACEBOOK_PAGE_DISCOVERY_SCOPES, FACEBOOK_PAGE_PUBLISH_SCOPE].join(',') }).toString(); return url.href;
  }
  async verifyToken(token: string): Promise<ProfessionalTokenIdentity> {
    tokenValue(token);
    const url = new URL(`https://graph.facebook.com/${this.options.graphApiVersion}/debug_token`); url.searchParams.set('input_token', token);
    const { body } = await json(url.href, { headers: { Authorization: `Bearer ${this.options.appId}|${this.options.appSecret}` } }, this.options);
    const data = body.data, expires = Math.min(...[data?.expires_at, data?.data_access_expires_at].filter(value => Number.isSafeInteger(value) && value > 0));
    if (data?.is_valid !== true || data.app_id !== this.options.appId || data.type !== 'USER' || !Array.isArray(data.scopes)
      || ![...FACEBOOK_PAGE_DISCOVERY_SCOPES, FACEBOOK_PAGE_PUBLISH_SCOPE].every(scope => data.scopes.includes(scope)) || !Number.isFinite(expires) || expires * 1000 <= Date.now())
      throw new ProfessionalPublishingError('Facebook token is expired, belongs to another app, or lacks Page permissions.', 'permission');
    return { principalId: identifier(data.user_id, true), name: 'Facebook account', scopes: data.scopes.filter((scope: unknown) => typeof scope === 'string'), expiresAt: new Date(expires * 1000).toISOString() };
  }
  async pagesPage(token: string, after?: string): Promise<{ items: FacebookPageTarget[]; nextCursor?: string }> {
    tokenValue(token); if (after !== undefined) bounded(after, 'Page cursor', 2048);
    const url = new URL(`https://graph.facebook.com/${this.options.graphApiVersion}/me/accounts`);
    url.search = new URLSearchParams({ fields: 'id,name,access_token,tasks', limit: '100', ...(after ? { after } : {}) }).toString();
    const { body } = await json(url.href, { headers: { Authorization: `Bearer ${token}` } }, this.options);
    if (!Array.isArray(body.data) || body.data.length > 100) throw new ProfessionalPublishingError('Invalid Page list.', 'invalid_response');
    const items = body.data.map((page: any): FacebookPageTarget => {
      if (typeof page.id !== 'string' || !/^\d{1,100}$/.test(page.id) || typeof page.name !== 'string' || !page.name || page.name.length > 500 || typeof page.access_token !== 'string' || !page.access_token || page.access_token.length > 16384
        || !Array.isArray(page.tasks) || page.tasks.length > 100 || page.tasks.some((task: unknown) => typeof task !== 'string' || task.length > 200)) throw new ProfessionalPublishingError('Incomplete Page.', 'invalid_response');
      return { provider: 'facebook', kind: 'facebook_page', id: page.id, name: page.name, pageAccessToken: page.access_token, tasks: page.tasks };
    });
    if (body.paging?.next && (typeof body.paging?.cursors?.after !== 'string' || !body.paging.cursors.after))
      throw new ProfessionalPublishingError('Page continuation is unavailable.', 'invalid_response');
    // Never follow provider-controlled next URLs with a credential.
    return { items, ...(body.paging?.next ? { nextCursor: bounded(body.paging.cursors.after, 'Page cursor', 2048) } : {}) };
  }
  async pages(token: string): Promise<FacebookPageTarget[]> {
    const items: FacebookPageTarget[] = [], seen = new Set<string>(); let after: string | undefined;
    do {
      const page = await this.pagesPage(token, after); items.push(...page.items); after = page.nextCursor;
      if (after && (seen.has(after) || seen.size >= 9)) throw new ProfessionalPublishingError('Use paginated discovery for a larger Page list.', 'invalid_response');
      if (after) seen.add(after);
    } while (after);
    return items;
  }
  async publish(page: FacebookPageTarget, input: { caption: string; link?: string; previewUrl?: string; altText?: string }): Promise<{ id: string; mediaId?: string }> {
    identifier(page.id, true); tokenValue(page.pageAccessToken);
    if (page.provider !== 'facebook' || page.kind !== 'facebook_page' || !page.tasks?.some(task => ['CREATE_CONTENT', 'MANAGE'].includes(task)))
      throw new ProfessionalPublishingError('The selected Page does not grant content creation.', 'permission');
    const caption = bounded(input.caption, 'caption', 63206, true);
    if (input.link !== undefined && input.previewUrl !== undefined) throw new ProfessionalPublishingError('Choose link or one preview.', 'unsupported');
    const photo = input.previewUrl !== undefined ? professionalPublishingPublicUrl(input.previewUrl) : undefined;
    const link = input.link !== undefined ? professionalPublishingPublicUrl(input.link) : undefined;
    if (!photo && !link && !caption.trim()) invalid('A post requires text, a link, or a preview.');
    const { body } = await json(`https://graph.facebook.com/${this.options.graphApiVersion}/${page.id}/${photo ? 'photos' : 'feed'}`,
      { method: 'POST', headers: { Authorization: `Bearer ${page.pageAccessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(photo ? { url: photo, caption, published: true, ...(input.altText !== undefined ? { alt_text_custom: bounded(input.altText, 'alternative text', 1000) } : {}) }
          : { message: caption, ...(link ? { link } : {}) }) }, this.options, true);
    const id = photo ? body.post_id : body.id;
    if (typeof id !== 'string' || !/^\d+(?:_\d+)?$/.test(id)) throw new ProfessionalPublishingError('Post identity unavailable.', 'outcome_unknown');
    return { id, ...(photo && typeof body.id === 'string' ? { mediaId: body.id } : {}) };
  }
}
export const LINKEDIN_MEMBER_SCOPE = 'w_member_social';
export class LinkedInPostsClient {
  constructor(private options: Options & { clientId: string; clientSecret: string; redirectUri: string; apiVersion: string; organizationPublishingEnabled?: boolean }) {
    if (!/^\d{4}(?:0[1-9]|1[0-2])$/.test(options.apiVersion)) throw new Error('LinkedIn version must be YYYYMM.');
  }
  async verifyToken(token: string): Promise<ProfessionalTokenIdentity> {
    tokenValue(token);
    const { body } = await json('https://www.linkedin.com/oauth/v2/introspectToken', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.options.clientId, client_secret: this.options.clientSecret, token }).toString() }, this.options);
    const scopes = typeof body.scope === 'string' ? body.scope.split(/[ ,]+/).filter(Boolean) : [];
    if (body.active !== true || body.client_id !== this.options.clientId || body.auth_type !== '3L' || !['openid', 'profile', LINKEDIN_MEMBER_SCOPE].every(scope => scopes.includes(scope))
      || !Number.isSafeInteger(body.expires_at) || body.expires_at * 1000 <= Date.now()) throw new ProfessionalPublishingError('LinkedIn member token lacks current application permissions.', 'permission');
    const { body: profile } = await json('https://api.linkedin.com/v2/userinfo', { headers: { Authorization: `Bearer ${token}` } }, this.options);
    return { principalId: identifier(profile.sub), name: bounded(profile.name, 'member name', 500), scopes, expiresAt: new Date(body.expires_at * 1000).toISOString() };
  }
  async publish(token: string, target: { kind: 'linkedin_member' | 'linkedin_organization'; id: string; name: string },
    input: { commentary: string; articleUrl?: string; articleTitle?: string; articleDescription?: string }): Promise<{ id: string }> {
    tokenValue(token); identifier(target.id);
    if (!['linkedin_member', 'linkedin_organization'].includes(target.kind)) invalid('Invalid LinkedIn target kind.');
    if (target.kind === 'linkedin_organization' && this.options.organizationPublishingEnabled !== true) throw new ProfessionalPublishingError('Organization publishing is not approved.', 'unsupported');
    const commentary = bounded(input.commentary, 'commentary', 3000);
    const content = input.articleUrl !== undefined ? { article: { source: professionalPublishingPublicUrl(input.articleUrl),
      title: bounded(input.articleTitle, 'article title', 200), ...(input.articleDescription !== undefined ? { description: bounded(input.articleDescription, 'article description', 256, true) } : {}) } } : undefined;
    const { body, response } = await json('https://api.linkedin.com/rest/posts', { method: 'POST', headers: { Authorization: `Bearer ${token}`,
      'LinkedIn-Version': this.options.apiVersion, 'X-Restli-Protocol-Version': '2.0.0', 'Content-Type': 'application/json' },
      body: JSON.stringify({ author: `urn:li:${target.kind === 'linkedin_member' ? 'person' : 'organization'}:${target.id}`, commentary, visibility: 'PUBLIC',
        distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] }, lifecycleState: 'PUBLISHED', ...(content ? { content } : {}) }) }, this.options, true);
    const id = response.headers.get('x-restli-id') || body.id;
    if (response.status !== 201 || typeof id !== 'string' || !/^urn:li:(share|ugcPost):\d+$/.test(id)) throw new ProfessionalPublishingError('Post identity unavailable.', 'outcome_unknown');
    return { id };
  }
}
