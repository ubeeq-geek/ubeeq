import { resolveUserAgent, type HttpClientOptions } from './connector-credentials.js';

export const PATREON_API_VERSION = '2' as const;

export type PatreonConnectionState =
  | 'PENDING_OAUTH' | 'CONNECTED' | 'REAUTH_REQUIRED' | 'INSUFFICIENT_SCOPE'
  | 'CAMPAIGN_NOT_FOUND' | 'WEBHOOK_DEGRADED' | 'RATE_LIMITED' | 'DISCONNECTED' | 'ERROR';

export type PatreonCapability =
  | 'campaign_sync' | 'post_reference_sync' | 'tier_mapping' | 'patreon_backed_access' | 'webhooks';

export interface PatreonConnection {
  id: string;
  ownerId: string;
  mode: 'STUDIO_MANAGED' | 'CREATOR_OWNED';
  credential: string;
  scopes: string[];
  state: PatreonConnectionState;
  selectedCampaignIds: string[];
  capabilities: PatreonCapability[];
  apiVersion: '2';
  lastSuccessfulSync?: string;
  webhookState: 'DISABLED' | 'ACTIVE' | 'DEGRADED';
  policyVersion: string;
  createdAt: string;
  updatedAt: string;
}

export interface PatreonCampaign {
  connectionId: string;
  id: string;
  creatorAccountId: string;
  url?: string;
  name: string;
  active: boolean;
  lastSync: string;
}

export interface PatreonTier {
  campaignId: string;
  id: string;
  benefitIds: string[];
  title: string;
  amountCents?: number;
  currency?: string;
  state: 'published' | 'archived';
  lastSync: string;
}

export interface PatreonPostReference {
  id: string;
  connectionId: string;
  campaignId: string;
  remotePostId: string;
  remoteUrl?: string;
  title: string;
  excerpt?: string;
  publishedAt?: string;
  accessRuleIds: string[];
  state: 'ACTIVE' | 'MISSING' | 'REMOTE_CHANGED';
  workId?: string;
}

export interface PatreonAccessMapping {
  id: string;
  ownerId: string;
  campaignId: string;
  selectorIds: string[];
  accessGroupId: string;
  active: boolean;
  graceSeconds: number;
  version: number;
  safetyHold: boolean;
  createdAt: string;
  updatedAt: string;
}

export class PatreonApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'PatreonApiError';
  }
}

export class PatreonApiClient {
  private readonly baseUrl = 'https://www.patreon.com/api/oauth2/v2';

  constructor(
    private readonly credentials: { clientId: string; clientSecret: string; redirectUri: string },
    private readonly options?: HttpClientOptions,
    private readonly request: typeof fetch = fetch
  ) {}

  createAuthorizationUrl(state: string, scopes: string[] = ['identity', 'campaigns', 'campaigns.members']): string {
    const url = new URL('https://www.patreon.com/oauth2/authorize');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.credentials.clientId);
    url.searchParams.set('redirect_uri', this.credentials.redirectUri);
    url.searchParams.set('scope', scopes.join(' '));
    url.searchParams.set('state', state);
    return url.href;
  }

  async exchangeCode(code: string): Promise<{ accessToken: string; refreshToken?: string; expiresIn?: number; scopes: string[] }> {
    const url = 'https://www.patreon.com/api/oauth2/token';
    const res = await this.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': resolveUserAgent(this.options),
      },
      body: new URLSearchParams({
        code,
        grant_type: 'authorization_code',
        client_id: this.credentials.clientId,
        client_secret: this.credentials.clientSecret,
        redirect_uri: this.credentials.redirectUri,
      }).toString(),
    });

    const data = await res.json() as Record<string, unknown>;
    if (!res.ok || typeof data.access_token !== 'string') {
      throw new PatreonApiError(String(data.error_description || data.error || 'Failed to exchange Patreon code'), res.status);
    }
    return {
      accessToken: data.access_token,
      refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : undefined,
      expiresIn: Number(data.expires_in) || undefined,
      scopes: typeof data.scope === 'string' ? data.scope.split(/[ ,]+/).filter(Boolean) : [],
    };
  }

  async getIdentity(accessToken: string): Promise<{ id: string; fullName?: string; email?: string }> {
    const url = `${this.baseUrl}/identity?fields%5Buser%5D=full_name,email`;
    const res = await this.request(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': resolveUserAgent(this.options),
      },
    });
    const data = await res.json() as { data?: { id?: string; attributes?: { full_name?: string; email?: string } } };
    if (!res.ok || !data.data?.id) {
      throw new PatreonApiError('Failed to fetch Patreon user identity', res.status);
    }
    return {
      id: data.data.id,
      fullName: data.data.attributes?.full_name,
      email: data.data.attributes?.email,
    };
  }

  async getCampaigns(accessToken: string): Promise<PatreonCampaign[]> {
    const url = `${this.baseUrl}/campaigns?fields%5Bcampaign%5D=creation_name,url`;
    const res = await this.request(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': resolveUserAgent(this.options),
      },
    });
    const data = await res.json() as { data?: Array<{ id: string; attributes?: { creation_name?: string; url?: string } }> };
    if (!res.ok || !Array.isArray(data.data)) {
      throw new PatreonApiError('Failed to fetch Patreon campaigns', res.status);
    }
    return data.data.map((c) => ({
      connectionId: '',
      id: c.id,
      creatorAccountId: '',
      url: c.attributes?.url,
      name: c.attributes?.creation_name || 'Campaign',
      active: true,
      lastSync: new Date().toISOString(),
    }));
  }
}
