import type { InstagramCapabilities, InstagramPlacement } from './instagram.js';
import { resolveUserAgent } from './connector-credentials.js';

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
  isAiGenerated?: boolean;
}

export interface InstagramRemoteMedia {
  id: string;
  permalink?: string;
  caption?: string;
  mediaType?: string;
  placement?: string;
  timestamp?: string;
  isAiGenerated?: boolean;
}

export interface InstagramMediaPage { items: InstagramRemoteMedia[]; nextCursor?: string; }
export interface InstagramProviderInsight { metric: string; value: number; title?: string; description?: string; period?: string; }

export class InstagramProviderError extends Error {
  constructor(message: string, readonly code: 'AUTHENTICATION_REQUIRED' | 'RATE_LIMITED' | 'PLATFORM_REJECTED' | 'NOT_FOUND' | 'INVALID_RESPONSE' | 'UNKNOWN', readonly retryAfterSeconds?: number) {
    super(message);
    this.name = 'InstagramProviderError';
  }
}

export class InstagramProvider {
  readonly platform = 'instagram' as const;
  private readonly baseUrl: string;

  constructor(private readonly config: InstagramProviderConfig, private readonly request: typeof fetch = fetch) {
    if (!/^v\d+\.\d+$/.test(config.apiVersion)) throw new Error('A pinned Meta Graph API version is required');
    this.baseUrl = config.graphBaseUrl || `https://graph.facebook.com/${config.apiVersion}`;
  }

  isConfigured(): boolean { return Boolean(this.config.appId && this.config.appSecret && this.config.redirectUri); }

  createAuthorizationUrl(state: string, scopes: string[] = ['instagram_basic', 'instagram_content_publish']): string {
    const url = new URL(`https://www.facebook.com/${this.config.apiVersion}/dialog/oauth`);
    url.searchParams.set('client_id', this.config.appId);
    url.searchParams.set('redirect_uri', this.config.redirectUri);
    url.searchParams.set('state', state);
    url.searchParams.set('scope', scopes.join(','));
    url.searchParams.set('response_type', 'code');
    return url.href;
  }

  async exchangeCodeForToken(code: string): Promise<{ accessToken: string; expiresIn: number }> {
    const url = new URL(`${this.baseUrl}/oauth/access_token`);
    url.searchParams.set('client_id', this.config.appId);
    url.searchParams.set('client_secret', this.config.appSecret);
    url.searchParams.set('redirect_uri', this.config.redirectUri);
    url.searchParams.set('code', code);

    const res = await this.request(url.href, {
      headers: { 'User-Agent': resolveUserAgent(this.config) },
    });
    const data = await res.json() as Record<string, unknown>;
    if (!res.ok || typeof data.access_token !== 'string') {
      throw new InstagramProviderError(String(data.error || 'Failed to exchange authorization code'), 'PLATFORM_REJECTED');
    }
    return {
      accessToken: data.access_token,
      expiresIn: Number(data.expires_in) || 5184000,
    };
  }

  async createMediaContainer(accountId: string, accessToken: string, req: InstagramContainerRequest): Promise<string> {
    const url = `${this.baseUrl}/${accountId}/media`;
    const body: Record<string, unknown> = {
      caption: req.caption,
      access_token: accessToken,
    };

    if (req.placement === 'REEL') {
      body.media_type = 'REELS';
      body.video_url = req.mediaUrl;
    } else if (req.placement === 'CAROUSEL' && req.children) {
      body.media_type = 'CAROUSEL';
      body.children = req.children.join(',');
    } else if (req.video) {
      body.media_type = 'VIDEO';
      body.video_url = req.mediaUrl;
    } else {
      body.image_url = req.mediaUrl;
    }

    if (req.carouselItem) body.is_carousel_item = true;
    if (req.isAiGenerated !== undefined) body.is_ai_generated = req.isAiGenerated;

    const res = await this.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': resolveUserAgent(this.config),
      },
      body: JSON.stringify(body),
    });

    const data = await res.json() as Record<string, unknown>;
    if (!res.ok || typeof data.id !== 'string') {
      throw new InstagramProviderError(String(data.error || 'Failed to create media container'), 'PLATFORM_REJECTED');
    }
    return data.id;
  }

  async publishMedia(accountId: string, accessToken: string, creationId: string): Promise<{ id: string }> {
    const url = `${this.baseUrl}/${accountId}/media_publish`;
    const res = await this.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': resolveUserAgent(this.config),
      },
      body: JSON.stringify({
        creation_id: creationId,
        access_token: accessToken,
      }),
    });
    const data = await res.json() as Record<string, unknown>;
    if (!res.ok || typeof data.id !== 'string') {
      throw new InstagramProviderError(String(data.error || 'Failed to publish media container'), 'PLATFORM_REJECTED');
    }
    return { id: data.id };
  }
}
