import type { InstagramCapabilities, InstagramConnection, InstagramContainerStatus, InstagramPlacement } from './instagram.js';
import {resolveUserAgent} from './connector-credentials.js';

export interface InstagramProviderConfig {
  appId: string;
  appSecret: string;
  redirectUri: string;
  apiVersion: string;
  graphBaseUrl?: string;
  approvedCapabilities: Partial<InstagramCapabilities>;
  instanceUserAgent?: string;
}

export interface InstagramAccount {
  id: string;
  username: string;
  accountType: 'BUSINESS' | 'CREATOR';
}

export interface InstagramContainerRequest {
  placement: InstagramPlacement;
  mediaUrl: string;
  caption?: string;
  accessibilityText?: string;
  children?: string[];
  carouselItem?: boolean;
  video?: boolean;
  /** Maps to Meta's self-disclosure flag on a top-level media container. */
  isAiGenerated?: boolean;
}

export interface InstagramRemoteMedia {
  id: string;
  permalink?: string;
  caption?: string;
  mediaType?: string;
  placement?: string;
  timestamp?: string;
  /** Undefined means the field was unavailable; it must not be treated as false. */
  isAiGenerated?: boolean;
}

export interface InstagramMediaPage { items: InstagramRemoteMedia[]; nextCursor?: string }
export interface InstagramProviderInsight { metric: string; value: number; title?: string; description?: string; period?: string }

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};
const string = (value: unknown): string | undefined => typeof value === 'string' && value ? value : undefined;
const boolean = (value: unknown): boolean | undefined => typeof value === 'boolean' ? value : undefined;

export class InstagramProviderError extends Error {
  constructor(message: string, readonly code: 'AUTHENTICATION_REQUIRED' | 'RATE_LIMITED' | 'PLATFORM_REJECTED' | 'NOT_FOUND' | 'INVALID_RESPONSE' | 'UNKNOWN', readonly retryAfterSeconds?: number) { super(message); this.name = 'InstagramProviderError'; }
}

/** Server-only Graph adapter. Callers persist the configured apiVersion with every connection and publication. */
export class InstagramProvider {
  readonly platform = 'instagram' as const;
  constructor(private readonly config: InstagramProviderConfig, private readonly request: typeof fetch = fetch) {
    if (!/^v\d+\.\d+$/.test(config.apiVersion)) throw new Error('A pinned Meta Graph API version is required');
  }

  isConfigured(): boolean { return Boolean(this.config.appId && this.config.appSecret && this.config.redirectUri); }
  createAuthorizationUrl(state: string, scopes: string[] = ['instagram_basic', 'instagram_content_publish', 'pages_show_list']): string {
    const url = new URL(`https://www.facebook.com/${this.config.apiVersion}/dialog/oauth`);
    url.search = new URLSearchParams({ client_id: this.config.appId, redirect_uri: this.config.redirectUri, state, response_type: 'code', scope: scopes.join(',') }).toString();
    return url.toString();
  }

  async exchangeAuthorizationCode(code: string): Promise<{ accessToken: string; expiresIn?: number }> {
    const body = await this.call<{ access_token?: string; expires_in?: number }>('/oauth/access_token', undefined, {
      client_id: this.config.appId, client_secret: this.config.appSecret, redirect_uri: this.config.redirectUri, code
    }, 'POST');
    if (!body.access_token) throw new InstagramProviderError('Meta did not return an access token', 'INVALID_RESPONSE');
    return { accessToken: body.access_token, expiresIn: body.expires_in };
  }

  async getProfessionalAccounts(accessToken: string): Promise<InstagramAccount[]> {
    const result = await this.call<{ data?: unknown[] }>('/me/accounts', accessToken, { fields: 'instagram_business_account{id,username,account_type}' });
    return (result.data || []).flatMap((page) => {
      const account = record(record(page).instagram_business_account);
      const id = string(account.id); const username = string(account.username);
      const accountType = account.account_type === 'CREATOR' ? 'CREATOR' as const : account.account_type === 'BUSINESS' ? 'BUSINESS' as const : undefined;
      return id && username && accountType ? [{ id, username, accountType }] : [];
    });
  }

  async getCapabilities(connection: InstagramConnection): Promise<InstagramCapabilities> {
    const enabled = (key: keyof InstagramCapabilities) => connection.state === 'CONNECTED' && connection.capabilities[key] && this.config.approvedCapabilities[key] === true;
    return { accountRead: enabled('accountRead'), mediaRead: enabled('mediaRead'), imagePublish: enabled('imagePublish'), carouselPublish: enabled('carouselPublish'), reelPublish: enabled('reelPublish'), storyPublish: enabled('storyPublish'), mediaUpdate: enabled('mediaUpdate'), mediaDeleteOrArchive: enabled('mediaDeleteOrArchive'), insightsRead: enabled('insightsRead'), commentsRead: enabled('commentsRead'), commentsReply: enabled('commentsReply') };
  }

  async getPublishingLimit(accessToken: string, accountId: string): Promise<Record<string, unknown>> {
    return this.call(`/${accountId}/content_publishing_limit`, accessToken, { fields: 'config,quota_usage' });
  }

  async createContainer(accessToken: string, accountId: string, input: InstagramContainerRequest): Promise<string> {
    if (input.carouselItem && input.isAiGenerated !== undefined) {
      throw new Error('Meta does not accept is_ai_generated on carousel child containers');
    }
    const params: Record<string, string> = { caption: input.caption || '' };
    if (input.children?.length) { params.media_type = 'CAROUSEL'; params.children = input.children.join(','); }
    else if (input.placement === 'REEL') { params.media_type = 'REELS'; params.video_url = input.mediaUrl; }
    else if (input.placement === 'STORY') { params.media_type = 'STORIES'; params[input.video ? 'video_url' : 'image_url'] = input.mediaUrl; }
    else params.image_url = input.mediaUrl;
    if (input.carouselItem) params.is_carousel_item = 'true';
    if (input.accessibilityText) params.alt_text = input.accessibilityText;
    // Meta documents this as a top-level self-disclosure. Omit false so an
    // unavailable/unknown local assertion is never converted into a claim.
    if (input.isAiGenerated === true) params.is_ai_generated = 'true';
    const result = await this.call<{ id?: string }>(`/${accountId}/media`, accessToken, params, 'POST');
    if (!result.id) throw new InstagramProviderError('Meta did not return a container id', 'INVALID_RESPONSE');
    return result.id;
  }

  async getContainerStatus(accessToken: string, containerId: string): Promise<InstagramContainerStatus> {
    const result = await this.call<{ status_code?: string }>(`/${containerId}`, accessToken, { fields: 'status_code' });
    const status = result.status_code;
    return status === 'FINISHED' || status === 'IN_PROGRESS' || status === 'ERROR' || status === 'EXPIRED' ? status : 'UNKNOWN';
  }

  async publishContainer(accessToken: string, accountId: string, containerId: string): Promise<string> {
    const result = await this.call<{ id?: string }>(`/${accountId}/media_publish`, accessToken, { creation_id: containerId }, 'POST');
    if (!result.id) throw new InstagramProviderError('Meta publish completion is ambiguous', 'UNKNOWN');
    return result.id;
  }

  async revokeAuthorization(accessToken: string): Promise<void> {
    await this.call('/me/permissions', accessToken, {}, 'DELETE');
  }

  async getMedia(accessToken: string, mediaId: string): Promise<InstagramRemoteMedia> {
    const result = await this.call<Record<string, unknown>>(`/${mediaId}`, accessToken, { fields: 'id,permalink,caption,media_type,media_product_type,timestamp,is_ai_generated' });
    const id = string(result.id);
    if (!id) throw new InstagramProviderError('Meta did not return a media id', 'INVALID_RESPONSE');
    return { id, permalink: string(result.permalink), caption: string(result.caption), mediaType: string(result.media_type), placement: string(result.media_product_type), timestamp: string(result.timestamp), isAiGenerated: boolean(result.is_ai_generated) };
  }

  async listMedia(accessToken: string, accountId: string, cursor?: string, limit = 25): Promise<InstagramMediaPage> {
    const result = await this.call<{ data?: unknown[]; paging?: { cursors?: { after?: string } } }>(`/${accountId}/media`, accessToken, {
      fields: 'id,permalink,caption,media_type,media_product_type,timestamp,is_ai_generated', limit: String(Math.max(1, Math.min(50, Math.trunc(limit)))), ...(cursor ? { after: cursor } : {})
    });
    const items = (result.data || []).flatMap((value) => {
      const item = record(value); const id = string(item.id);
      return id ? [{ id, permalink: string(item.permalink), caption: string(item.caption), mediaType: string(item.media_type), placement: string(item.media_product_type), timestamp: string(item.timestamp), isAiGenerated: boolean(item.is_ai_generated) }] : [];
    });
    return { items, nextCursor: string(result.paging?.cursors?.after) };
  }

  async getInsights(accessToken: string, referenceId: string, metricIdentifiers: string[]): Promise<InstagramProviderInsight[]> {
    if (!metricIdentifiers.length) return [];
    const result = await this.call<{ data?: unknown[] }>(`/${referenceId}/insights`, accessToken, { metric: metricIdentifiers.join(',') });
    return (result.data || []).flatMap((value) => {
      const item = record(value); const metric = string(item.name);
      const values = Array.isArray(item.values) ? item.values : [];
      const latest = values.at(-1); const latestRecord = record(latest);
      const totalValue = record(item.total_value);
      const numeric = Number(latestRecord.value ?? totalValue.value ?? item.total_value);
      return metric && Number.isFinite(numeric) ? [{ metric, value: numeric, title: string(item.title), description: string(item.description), period: string(item.period) }] : [];
    });
  }

  /** Preserve the original public SDK call signatures while sharing the
   * complete adapter. New Native callers use the truthful optional expiry from
   * exchangeAuthorizationCode; the old API retains its established fallback. */
  async exchangeCodeForToken(code: string): Promise<{accessToken:string;expiresIn:number}> {
    const tokens=await this.exchangeAuthorizationCode(code);
    return {...tokens,expiresIn:tokens.expiresIn??5184000};
  }
  async createMediaContainer(accountId:string,accessToken:string,input:InstagramContainerRequest):Promise<string> {
    return this.createContainer(accessToken,accountId,input);
  }
  async publishMedia(accountId:string,accessToken:string,creationId:string):Promise<{id:string}> {
    return {id:await this.publishContainer(accessToken,accountId,creationId)};
  }

  private async call<T = Record<string, unknown>>(path: string, accessToken?: string, params: Record<string, string> = {}, method: 'GET' | 'POST' | 'DELETE' = 'GET'): Promise<T> {
    const configured = (this.config.graphBaseUrl || 'https://graph.facebook.com').replace(/\/$/, '');
    // Existing SDK callers supplied a versioned graphBaseUrl; original Native
    // callers supplied the host. Preserve both actual configurations.
    const base = /\/v\d+\.\d+$/.test(configured) ? configured : `${configured}/${this.config.apiVersion}`;
    const url = new URL(`${base}${path}`);
    const headers: Record<string, string> = {'User-Agent':resolveUserAgent(this.config), ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {})};
    const response = method === 'POST' || method === 'DELETE'
      ? await this.request(url, { method, redirect:'error', headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) })
      : await this.request(`${url}?${new URLSearchParams(params)}`, { headers, redirect:'error' });
    const body = await response.json() as T & { error?: { message?: string; code?: number } };
    if (!response.ok || body.error) {
      const code = response.status === 401 ? 'AUTHENTICATION_REQUIRED' : response.status === 404 ? 'NOT_FOUND' : response.status === 429 ? 'RATE_LIMITED' : response.status >= 500 ? 'UNKNOWN' : 'PLATFORM_REJECTED';
      const retryAfter = Number(response.headers.get('retry-after'));
      throw new InstagramProviderError(body.error?.message || `Meta request failed (${response.status})`, code, Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : undefined);
    }
    return body;
  }
}
