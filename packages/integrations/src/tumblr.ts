import { resolveUserAgent, type HttpClientOptions } from './connector-credentials.js';

export type TumblrIntegrationOwnership = 'managed' | 'creator_owned';
export type TumblrAuthProtocol = 'oauth2' | 'oauth1';
export type TumblrPostState = 'published' | 'draft' | 'queue' | 'private';
export type TumblrPublicationMode = 'full' | 'selected_assets' | 'announcement';

export interface TumblrConnector {
  id: string;
  tenantId: string;
  userId: string;
  creatorId: string;
  ownership: TumblrIntegrationOwnership;
  authProtocol: TumblrAuthProtocol;
  status: 'pending' | 'connected' | 'expired' | 'revoked' | 'error' | 'disabled';
  tumblrUserId?: string;
  tumblrUserName?: string;
  applicationLabel?: string;
  credentialsEncrypted: Record<string, unknown>;
  scopes?: string[];
  connectedAt?: string;
  lastValidatedAt?: string;
  disconnectedAt?: string;
}

export interface TumblrBlogDestination {
  id: string;
  tenantId: string;
  connectorId: string;
  creatorId: string;
  identifier: string;
  name?: string;
  title?: string;
  url?: string;
  avatarUrl?: string;
  enabled?: boolean;
}

export interface TumblrPostInput {
  type?: 'text' | 'photo' | 'quote' | 'link' | 'chat' | 'audio' | 'video';
  title?: string;
  body?: string;
  caption?: string;
  tags?: string[];
  state?: TumblrPostState;
  sourceUrl?: string;
}

export class TumblrApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'TumblrApiError';
  }
}

export class TumblrApiClient {
  private readonly baseUrl: string;

  constructor(
    private readonly credentials: { clientId?: string; clientSecret?: string; redirectUri?: string },
    apiBaseUrl?: string,
    private readonly options?: HttpClientOptions,
    private readonly request: typeof fetch = fetch
  ) {
    this.baseUrl = apiBaseUrl || 'https://api.tumblr.com/v2';
  }

  createAuthorizationUrl(state: string, scopes: string[] = ['basic', 'write', 'offline_access']): string {
    const url = new URL('https://www.tumblr.com/oauth2/authorize');
    url.searchParams.set('client_id', this.credentials.clientId || '');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', scopes.join(' '));
    url.searchParams.set('state', state);
    url.searchParams.set('redirect_uri', this.credentials.redirectUri || '');
    return url.href;
  }

  async exchangeCode(code: string): Promise<{ accessToken: string; refreshToken?: string; expiresIn?: number; scopes: string[] }> {
    const url = `${this.baseUrl}/oauth2/token`;
    const res = await this.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': resolveUserAgent(this.options),
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: this.credentials.clientId || '',
        client_secret: this.credentials.clientSecret || '',
        redirect_uri: this.credentials.redirectUri || '',
      }).toString(),
    });

    const data = await res.json() as Record<string, unknown>;
    if (!res.ok || typeof data.access_token !== 'string') {
      throw new TumblrApiError(String(data.error_description || data.error || 'Failed to exchange Tumblr authorization code'), res.status);
    }
    return {
      accessToken: data.access_token,
      refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : undefined,
      expiresIn: Number(data.expires_in) || undefined,
      scopes: typeof data.scope === 'string' ? data.scope.split(/[ ,]+/).filter(Boolean) : [],
    };
  }

  async refreshAccessToken(refreshToken: string): Promise<{ accessToken: string; refreshToken?: string; expiresIn?: number; scopes: string[] }> {
    const url = `${this.baseUrl}/oauth2/token`;
    const res = await this.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': resolveUserAgent(this.options),
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: this.credentials.clientId || '',
        client_secret: this.credentials.clientSecret || '',
      }).toString(),
    });

    const data = await res.json() as Record<string, unknown>;
    if (!res.ok || typeof data.access_token !== 'string') {
      throw new TumblrApiError(String(data.error_description || 'Failed to refresh Tumblr access token'), res.status);
    }
    return {
      accessToken: data.access_token,
      refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : undefined,
      expiresIn: Number(data.expires_in) || undefined,
      scopes: typeof data.scope === 'string' ? data.scope.split(/[ ,]+/).filter(Boolean) : [],
    };
  }

  async createPost(blogIdentifier: string, token: string, post: TumblrPostInput): Promise<{ id: string; url?: string }> {
    const url = `${this.baseUrl}/blog/${encodeURIComponent(blogIdentifier)}/posts`;
    const res = await this.request(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': resolveUserAgent(this.options),
      },
      body: JSON.stringify(post),
    });

    const data = await res.json() as { response?: { id?: string | number; display_avatar?: boolean }; meta?: { status?: number; msg?: string } };
    if (!res.ok || !data.response?.id) {
      throw new TumblrApiError(data.meta?.msg || 'Tumblr post failed', res.status);
    }
    return { id: String(data.response.id) };
  }
}
